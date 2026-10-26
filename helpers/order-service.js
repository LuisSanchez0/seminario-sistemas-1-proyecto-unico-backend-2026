// Reglas de negocio de pedidos. Toda operación que cambia el estado, el stock o ambos corre
// dentro de una transacción de MongoDB: o se aplica completa o no se aplica nada.
//
// Los callbacks de las transacciones pueden ejecutarse más de una vez (MongoDB reintenta los
// conflictos de escritura), por eso no envían correos ni tocan Redis: eso ocurre tras el commit.
const crypto = require('crypto');
const mongoose = require('mongoose');
const { Product, Address, Order } = require('../models');
const { refreshProductCache } = require('./product-cache');
const {
    TERMINAL_ORDER_STATES,
    canTransitionPayment,
    canTransitionShipping,
    deriveOrderState,
    isDispatched,
    toCents,
    fromCents,
} = require('./order-states');

class OrderError extends Error {
    constructor(status, message) {
        super(message);
        this.name = 'OrderError';
        this.status = status;
    }
}

const PAYMENT_NAMES = {
    EN_ESPERA_DE_PAGO: 'en espera de pago',
    PAGO_REALIZADO: 'pagado',
    CANCELADO: 'cancelado',
    REEMBOLSADO: 'reembolsado',
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I para evitar confusiones al dictarlo
const MAX_CODE_ATTEMPTS = 5;

const generateOrderCode = (now = new Date()) => {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guatemala' })
        .format(now).replace(/-/g, '');
    let suffix = '';
    for (let i = 0; i < 6; i += 1) suffix += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    return `LUM-${date}-${suffix}`;
};

const isDuplicateKey = (error, field) =>
    error?.code === 11000 && (!field || Object.prototype.hasOwnProperty.call(error.keyPattern ?? {}, field));

// ── Stock ────────────────────────────────────────────────────────────────────

const restoreStock = async (order, session) => {
    // El indicador evita devolver dos veces el stock de un mismo pedido.
    if (order.stockRestored) return;
    for (const item of order.items) {
        await Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity } }, { session });
    }
    order.stockRestored = true;
};

// La caché de Redis guarda el stock del producto; se renueva después de confirmar la transacción.
const refreshProductCaches = async productIds => {
    try {
        const products = await Product.find({ _id: { $in: productIds } });
        for (const product of products) await refreshProductCache(product);
    } catch (error) {
        console.error('No se pudo actualizar la caché de productos del pedido:', error.message);
    }
};

// ── Creación ─────────────────────────────────────────────────────────────────

const mergeItems = items => {
    const quantities = new Map();
    for (const { product, quantity } of items) {
        const id = String(product);
        quantities.set(id, (quantities.get(id) ?? 0) + Number(quantity));
    }
    return quantities;
};

const buildOrder = async (session, { user, items, shippingAddress, paymentMethod, nit, notes, checkoutKey }) => {
    const quantities = mergeItems(items);
    const ids = [...quantities.keys()]; // se conserva el orden del carrito

    const address = await Address.findOne({ _id: shippingAddress, recipient: user._id, state: true }).session(session);
    if (!address) throw new OrderError(400, 'La dirección de envío no es válida. Selecciona o agrega una dirección.');

    const products = await Product.find({ _id: { $in: ids } }).populate('brand', 'name').session(session);
    const byId = new Map(products.map(product => [product.id, product]));

    const now = new Date();
    const lines = [];
    let subtotalCents = 0;

    for (const id of ids) {
        const product = byId.get(id);
        if (!product || !product.state) {
            throw new OrderError(400, `${product ? `"${product.title}"` : 'Uno de los productos de tu carrito'} ya no está disponible.`);
        }
        const quantity = quantities.get(id);
        // La condición del filtro hace atómico "validar y descontar": nunca queda stock negativo
        // ni dos pedidos pueden quedarse con la misma unidad.
        const result = await Product.updateOne(
            { _id: product._id, state: true, stock: { $gte: quantity } },
            { $inc: { stock: -quantity } },
            { session },
        );
        if (result.modifiedCount !== 1) {
            const available = Math.max(0, product.stock);
            throw new OrderError(409, `Stock insuficiente para "${product.title}". Disponible: ${available}, solicitado: ${quantity}.`);
        }
        // El precio siempre sale del catálogo, nunca del cliente.
        const unitCents = toCents(product.price);
        const lineCents = unitCents * quantity;
        subtotalCents += lineCents;
        lines.push({
            product: product._id,
            title: product.title,
            brandName: product.brand?.name,
            slug: product.slug,
            imageUrl: product.images?.[0]?.url,
            unitPrice: fromCents(unitCents),
            quantity,
            subtotal: fromCents(lineCents),
            shippingStatus: 'ORDER_PLACED',
            shippingStatusHistory: [{ status: 'ORDER_PLACED', changedAt: now, changedBy: user._id }],
        });
    }

    const shippingCents = toCents(address.shipping_cost ?? 0);
    const [order] = await Order.create([{
        orderCode: generateOrderCode(now),
        buyerUser: user._id,
        items: lines,
        shippingAddress: {
            address: address._id,
            department: address.department,
            municipality: address.municipality,
            street: address.street,
            full_address: address.full_address,
            phoneNumber: address.phoneNumber,
        },
        subtotal: fromCents(subtotalCents),
        shippingCost: fromCents(shippingCents),
        total: fromCents(subtotalCents + shippingCents),
        paymentMethod,
        nit: nit || 'CF',
        notes,
        checkoutKey,
    }], { session });
    return order;
};

/**
 * Crea el pedido, valida el stock y lo descuenta en una sola transacción.
 * Si el cliente reintenta con la misma checkoutKey recibe el pedido original (created = false).
 */
const createOrder = async input => {
    const { user, checkoutKey } = input;
    const existing = () => checkoutKey ? Order.findOne({ buyerUser: user._id, checkoutKey }) : null;

    const replay = await existing();
    if (replay) return { order: replay, created: false };

    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
        try {
            const order = await mongoose.connection.transaction(session => buildOrder(session, input));
            await refreshProductCaches(order.items.map(item => item.product));
            return { order, created: true };
        } catch (error) {
            if (isDuplicateKey(error, 'orderCode')) continue; // código repetido: reintentar con otro
            if (isDuplicateKey(error, 'checkoutKey')) {
                const original = await existing();
                if (original) return { order: original, created: false };
            }
            throw error;
        }
    }
    throw new OrderError(503, 'No se pudo generar un código de pedido único. Intenta de nuevo.');
};

// ── Pago ─────────────────────────────────────────────────────────────────────

const loadOrder = async (session, filter) => {
    const order = await Order.findOne(filter).session(session);
    if (!order) throw new OrderError(404, 'No se encontró el pedido');
    return order;
};

const cancelOrderRecord = async (order, session, { actorId, reason, refunded }) => {
    const now = new Date();
    await restoreStock(order, session);
    order.paymentState = refunded ? 'REEMBOLSADO' : 'CANCELADO';
    order.orderState = order.paymentState;
    if (refunded) {
        order.refundedAt = now;
        order.refundedBy = actorId;
    } else {
        order.cancelledAt = now;
        order.cancelledBy = actorId;
    }
    if (reason) order.cancellationReason = reason;
};

/**
 * Cambia el estado de pago (administrador). Las transiciones válidas son
 *   EN_ESPERA_DE_PAGO -> PAGO_REALIZADO | CANCELADO
 *   PAGO_REALIZADO    -> REEMBOLSADO (solo si ningún producto salió de la tienda)
 * Cancelar o reembolsar devuelve el stock exactamente una vez y deja el pedido en el mismo estado.
 */
const changePaymentState = async (orderId, actor, { paymentState: target, paymentReference, reason }) => {
    const order = await mongoose.connection.transaction(async session => {
        const current = await loadOrder(session, { _id: orderId });
        const from = current.paymentState;

        if (from === target) {
            throw new OrderError(409, `El pedido ya está ${PAYMENT_NAMES[from]}.`);
        }
        if (!canTransitionPayment(from, target)) {
            throw new OrderError(409, `No se puede pasar un pedido ${PAYMENT_NAMES[from]} a ${PAYMENT_NAMES[target]}.`);
        }

        if (target === 'PAGO_REALIZADO') {
            if (!current.paymentReceipt?.key && !paymentReference) {
                throw new OrderError(400, 'Para confirmar el pago se necesita el comprobante del cliente o una referencia de pago.');
            }
            current.paymentState = 'PAGO_REALIZADO';
            current.paidAt = new Date();
            current.paymentConfirmedBy = actor._id;
            if (paymentReference) current.paymentReference = paymentReference;
        } else if (target === 'REEMBOLSADO') {
            if (current.items.some(item => isDispatched(item.shippingStatus))) {
                throw new OrderError(409, 'El pedido ya tiene productos enviados. Un reembolso en este punto requiere un proceso de devolución.');
            }
            await cancelOrderRecord(current, session, { actorId: actor._id, reason, refunded: true });
        } else {
            await cancelOrderRecord(current, session, { actorId: actor._id, reason, refunded: false });
        }
        await current.save({ session });
        return current;
    });
    if (target !== 'PAGO_REALIZADO') await refreshProductCaches(order.items.map(item => item.product));
    return order;
};

/** El cliente solo puede cancelar mientras el pago no se haya confirmado. */
const cancelOwnOrder = async (orderId, user, reason) => {
    const order = await mongoose.connection.transaction(async session => {
        const current = await loadOrder(session, { _id: orderId, buyerUser: user._id });
        if (current.paymentState === 'EN_ESPERA_DE_PAGO' && !TERMINAL_ORDER_STATES.includes(current.orderState)) {
            await cancelOrderRecord(current, session, { actorId: user._id, reason, refunded: false });
            await current.save({ session });
            return current;
        }
        if (current.paymentState === 'PAGO_REALIZADO') {
            throw new OrderError(409, 'Tu pago ya fue confirmado. Para cancelar este pedido comunícate con la tienda y solicita un reembolso.');
        }
        throw new OrderError(409, `Este pedido ya está ${PAYMENT_NAMES[current.paymentState]}.`);
    });
    await refreshProductCaches(order.items.map(item => item.product));
    return order;
};

/** Guarda el comprobante del cliente mientras el pago siga pendiente. Devuelve el comprobante anterior. */
const attachPaymentReceipt = async (orderId, user, key) => {
    const previous = await Order.findOneAndUpdate(
        { _id: orderId, buyerUser: user._id, paymentState: 'EN_ESPERA_DE_PAGO' },
        { $set: { paymentReceipt: { key, uploadedAt: new Date() } } },
        { returnDocument: 'before' },
    );
    if (previous) return { previousKey: previous.paymentReceipt?.key };

    const order = await Order.findOne({ _id: orderId, buyerUser: user._id });
    if (!order) throw new OrderError(404, 'No se encontró el pedido');
    throw new OrderError(409, `Ya no se puede subir un comprobante: el pedido está ${PAYMENT_NAMES[order.paymentState]}.`);
};

// ── Envío ────────────────────────────────────────────────────────────────────

/**
 * Avanza el estado de preparación/envío de uno o varios productos. Un producto solo pasa al
 * paso inmediato siguiente, y únicamente cuando el pago ya fue confirmado. El estado del
 * pedido se vuelve a derivar de todos sus productos en la misma transacción.
 */
const updateItemsShipping = async (orderId, actor, updates) => {
    const result = await mongoose.connection.transaction(async session => {
        const order = await loadOrder(session, { _id: orderId });
        if (TERMINAL_ORDER_STATES.includes(order.orderState)) {
            throw new OrderError(409, `El pedido está ${PAYMENT_NAMES[order.paymentState]}; ya no se puede modificar su envío.`);
        }
        if (order.paymentState !== 'PAGO_REALIZADO') {
            throw new OrderError(409, 'Confirma el pago del pedido antes de prepararlo o enviarlo.');
        }

        const previousState = order.orderState;
        const now = new Date();
        for (const { itemId, shippingStatus } of updates) {
            const item = order.items.id(itemId);
            if (!item) throw new OrderError(404, 'Uno de los productos no pertenece a este pedido.');
            if (!canTransitionShipping(item.shippingStatus, shippingStatus)) {
                throw new OrderError(409, `"${item.title}" no puede pasar de ${item.shippingStatus} a ${shippingStatus}. Los productos avanzan paso a paso.`);
            }
            item.shippingStatus = shippingStatus;
            item.shippingStatusHistory.push({ status: shippingStatus, changedAt: now, changedBy: actor._id });
        }

        order.orderState = deriveOrderState(order.items.map(item => item.shippingStatus));
        if (order.orderState === 'COMPLETADO') order.completedAt = now;
        await order.save({ session });
        return { order, previousState };
    });
    return result;
};

module.exports = {
    OrderError,
    generateOrderCode,
    createOrder,
    changePaymentState,
    cancelOwnOrder,
    attachPaymentReceipt,
    updateItemsShipping,
    refreshProductCaches,
};
