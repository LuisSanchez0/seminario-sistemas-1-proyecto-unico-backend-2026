const fs = require('fs');
const { response } = require('express');
const { Order, User } = require('../models');
const helpers = require('../helpers');
const { ORDER_FILTERS } = require('../helpers/order-states');
const {
    OrderError, createOrder, changePaymentState, cancelOwnOrder, attachPaymentReceipt, updateItemsShipping,
} = require('../helpers/order-service');
const { serializeOrder, serializeSummary } = require('../helpers/order-serializer');
const { sendOrderEmail } = require('../helpers/order-emails');

const RECEIPT_FOLDER = 'uploads/images/payment-receipts';
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;
const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ORDER_NOT_FOUND = 'No se encontró el pedido';

const escapeRegex = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Correo de mejor esfuerzo: se envía después de responder y un fallo solo queda en el log.
const notify = (order, kind, buyer) => {
    Promise.resolve()
        .then(async () => sendOrderEmail(order, buyer ?? await User.findById(order.buyerUser).select('name email'), kind))
        .catch(error => console.error(`No se pudo enviar el correo "${kind}" del pedido ${order.orderCode}:`, error.message));
};

const failure = (res, error, fallback) => {
    if (error instanceof OrderError) return res.status(error.status).json({ ok: false, msg: error.message });
    if (error?.name === 'ValidationError' || error?.name === 'CastError') {
        return res.status(400).json({ ok: false, msg: error.message });
    }
    if (error?.hasErrorLabel?.('TransientTransactionError')) {
        return res.status(503).json({ ok: false, msg: 'El pedido está siendo modificado en este momento. Intenta de nuevo.' });
    }
    console.error(fallback, error);
    return res.status(500).json({ ok: false, msg: fallback });
};

const paging = query => ({ limit: Number(query.limit ?? 10), offset: Number(query.offset ?? 0) });

// "YYYY-MM-DD" interpretado en hora de Guatemala (UTC-6, sin horario de verano).
const parseDay = (value, endOfDay) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    const [, year, month, day] = match.map(Number);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
    return new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}-06:00`);
};

// ── Cliente ──────────────────────────────────────────────────────────────────

const create = async (req, res = response) => {
    try {
        // Solo se leen los campos permitidos: total, precios, estados y dueño nunca vienen del cliente.
        const { items, shippingAddress, paymentMethod, nit, notes, checkoutKey } = req.body;
        const { order, created } = await createOrder({
            user: req.user, items, shippingAddress, paymentMethod, nit, notes, checkoutKey,
        });
        if (created) notify(order, 'created', req.user);
        return res.status(created ? 201 : 200).json({ ok: true, replayed: !created, order: await serializeOrder(order) });
    } catch (error) {
        return failure(res, error, 'Error al crear el pedido');
    }
};

const listMine = async (req, res = response) => {
    try {
        const { limit, offset } = paging(req.query);
        const states = ORDER_FILTERS[req.query.filter ?? 'all'];
        const query = { buyerUser: req.user._id, ...(states ? { orderState: { $in: states } } : {}) };
        const [count, orders] = await Promise.all([
            Order.countDocuments(query),
            Order.find(query).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit),
        ]);
        return res.status(200).json({
            ok: true, count, pages: Math.ceil(count / limit),
            orders: orders.map(order => serializeSummary(order)),
        });
    } catch (error) {
        return failure(res, error, 'Error al obtener tus pedidos');
    }
};

const getMine = async (req, res = response) => {
    try {
        // Un pedido ajeno responde igual que uno inexistente: no se revela que existe.
        const order = await Order.findOne({ _id: req.params.id, buyerUser: req.user._id });
        if (!order) return res.status(404).json({ ok: false, msg: ORDER_NOT_FOUND });
        return res.status(200).json({ ok: true, order: await serializeOrder(order) });
    } catch (error) {
        return failure(res, error, 'Error al obtener el pedido');
    }
};

const cancelMine = async (req, res = response) => {
    try {
        const order = await cancelOwnOrder(req.params.id, req.user, req.body?.reason);
        notify(order, 'cancelled', req.user);
        return res.status(200).json({ ok: true, order: await serializeOrder(order) });
    } catch (error) {
        return failure(res, error, 'Error al cancelar el pedido');
    }
};

const removeTemp = path => {
    if (path && fs.existsSync(path)) fs.unlinkSync(path);
};

const uploadReceipt = async (req, res = response) => {
    const original = req.files?.archivo;
    const originalPath = original?.tempFilePath;
    let processed;
    let key;
    try {
        if (!original || Array.isArray(original)) {
            return res.status(400).json({ ok: false, msg: 'Envía un solo archivo de imagen en el campo "archivo"' });
        }
        if (!RECEIPT_TYPES.includes(original.mimetype)) {
            return res.status(400).json({ ok: false, msg: 'El comprobante debe ser una imagen JPG, PNG o WebP' });
        }
        if (original.size > MAX_RECEIPT_BYTES) {
            return res.status(400).json({ ok: false, msg: 'El comprobante no puede pesar más de 8 MB' });
        }

        // Se valida dueño y estado antes de subir nada a S3 para no dejar archivos huérfanos.
        const current = await Order.findOne({ _id: req.params.id, buyerUser: req.user._id });
        if (!current) return res.status(404).json({ ok: false, msg: ORDER_NOT_FOUND });
        if (current.paymentState !== 'EN_ESPERA_DE_PAGO') {
            return res.status(409).json({ ok: false, msg: 'Ya no se puede subir un comprobante: el pago de este pedido ya fue resuelto.' });
        }

        processed = await helpers.processImageToWebp(original);
        ({ key } = await helpers.uploadFile(processed, RECEIPT_FOLDER));
        const { previousKey } = await attachPaymentReceipt(req.params.id, req.user, key);
        if (previousKey) helpers.deleteFile(previousKey)?.catch?.(() => {});

        const order = await Order.findById(req.params.id);
        return res.status(200).json({ ok: true, msg: 'Comprobante guardado correctamente', order: await serializeOrder(order) });
    } catch (error) {
        // Si el comprobante no quedó asociado al pedido, el archivo subido sobra.
        if (key) Promise.resolve(helpers.deleteFile(key)).catch(() => {});
        return failure(res, error, 'Error al subir el comprobante');
    } finally {
        removeTemp(originalPath);
        if (processed?.tempFilePath !== originalPath) removeTemp(processed?.tempFilePath);
    }
};

// ── Administración ───────────────────────────────────────────────────────────

const listAdmin = async (req, res = response) => {
    try {
        const { customer, orderCode, paymentState, orderState, startDate, endDate } = req.query;
        const { limit, offset } = paging(req.query);
        const query = {};

        if (orderCode) query.orderCode = { $regex: escapeRegex(orderCode.trim()), $options: 'i' };
        if (paymentState) query.paymentState = paymentState;
        if (orderState) query.orderState = orderState;

        if (startDate || endDate) {
            const from = startDate ? parseDay(startDate, false) : null;
            const to = endDate ? parseDay(endDate, true) : null;
            if ((startDate && !from) || (endDate && !to)) {
                return res.status(400).json({ ok: false, msg: 'El rango de fechas no es válido' });
            }
            if (from && to && from > to) {
                return res.status(400).json({ ok: false, msg: 'La fecha inicial no puede ser mayor que la fecha final' });
            }
            query.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
        }

        if (customer) {
            const pattern = { $regex: escapeRegex(customer.trim()), $options: 'i' };
            const buyers = await User.find({ $or: [{ name: pattern }, { email: pattern }] }).select('_id').limit(500);
            query.buyerUser = { $in: buyers.map(buyer => buyer._id) };
        }

        const [count, orders] = await Promise.all([
            Order.countDocuments(query),
            Order.find(query).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit).populate('buyerUser', 'name email'),
        ]);
        return res.status(200).json({
            ok: true, count, pages: Math.ceil(count / limit),
            orders: orders.map(order => serializeSummary(order, { admin: true })),
        });
    } catch (error) {
        return failure(res, error, 'Error al obtener los pedidos');
    }
};

const getAdmin = async (req, res = response) => {
    try {
        const order = await Order.findById(req.params.id).populate('buyerUser', 'name email');
        if (!order) return res.status(404).json({ ok: false, msg: ORDER_NOT_FOUND });
        return res.status(200).json({ ok: true, order: await serializeOrder(order, { admin: true }) });
    } catch (error) {
        return failure(res, error, 'Error al obtener el pedido');
    }
};

const respondAdmin = async (res, orderId) => {
    const order = await Order.findById(orderId).populate('buyerUser', 'name email');
    return res.status(200).json({ ok: true, order: await serializeOrder(order, { admin: true }) });
};

const setPaymentState = async (req, res = response) => {
    try {
        const { paymentState, paymentReference, reason } = req.body;
        const order = await changePaymentState(req.params.id, req.user, { paymentState, paymentReference, reason });
        notify(order, { PAGO_REALIZADO: 'payment', CANCELADO: 'cancelled', REEMBOLSADO: 'refunded' }[paymentState]);
        return await respondAdmin(res, order._id);
    } catch (error) {
        return failure(res, error, 'Error al actualizar el estado de pago');
    }
};

const setShippingStatus = async (req, res = response) => {
    try {
        const { order, previousState } = await updateItemsShipping(req.params.id, req.user, req.body.items);
        if (order.orderState !== previousState) {
            const kind = { PARCIALMENTE_ENVIADO: 'partial', ENVIADO: 'shipped', COMPLETADO: 'completed' }[order.orderState];
            if (kind) notify(order, kind);
        }
        return await respondAdmin(res, order._id);
    } catch (error) {
        return failure(res, error, 'Error al actualizar el envío');
    }
};

module.exports = {
    create, listMine, getMine, cancelMine, uploadReceipt,
    listAdmin, getAdmin, setPaymentState, setShippingStatus,
};
