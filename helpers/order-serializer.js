// Representación pública de los pedidos. Es una lista blanca: los campos internos
// (indicador de stock, llave de checkout, ids de quien confirmó) nunca salen en la API.
const helpers = require('./index');

const idOf = value => (value?._id ?? value)?.toString();

const receiptView = async order => {
    const key = order.paymentReceipt?.key;
    if (!key) return null;
    let url = null;
    try {
        url = await helpers.getFileUrl(key);
    } catch (error) {
        // Un fallo de S3 no debe impedir ver el pedido; el comprobante simplemente no se muestra.
        console.error('No se pudo firmar la URL del comprobante:', error.message);
    }
    return { url, uploadedAt: order.paymentReceipt.uploadedAt };
};

const itemView = item => ({
    id: idOf(item),
    product: idOf(item.product),
    title: item.title,
    brandName: item.brandName ?? null,
    slug: item.slug ?? null,
    imageUrl: item.imageUrl ?? null,
    unitPrice: item.unitPrice,
    quantity: item.quantity,
    subtotal: item.subtotal,
    shippingStatus: item.shippingStatus,
    shippingStatusHistory: item.shippingStatusHistory.map(({ status, changedAt }) => ({ status, changedAt })),
});

const buyerView = buyer => buyer && typeof buyer === 'object' && 'email' in buyer
    ? { id: idOf(buyer), name: buyer.name, email: buyer.email }
    : null;

const flags = order => ({
    // El cliente puede cancelar solo mientras el pago no se confirmó.
    canCancel: order.paymentState === 'EN_ESPERA_DE_PAGO',
    awaitingReceipt: order.paymentState === 'EN_ESPERA_DE_PAGO' && !order.paymentReceipt?.key,
});

const serializeOrder = async (order, { admin = false } = {}) => {
    const address = order.shippingAddress;
    const view = {
        id: idOf(order),
        orderCode: order.orderCode,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        paymentMethod: order.paymentMethod,
        paymentState: order.paymentState,
        orderState: order.orderState,
        items: order.items.map(itemView),
        shippingAddress: {
            department: address.department,
            municipality: address.municipality,
            street: address.street ?? null,
            full_address: address.full_address,
            phoneNumber: address.phoneNumber,
        },
        subtotal: order.subtotal,
        shippingCost: order.shippingCost,
        total: order.total,
        nit: order.nit,
        notes: order.notes ?? null,
        paymentReference: order.paymentReference ?? null,
        paymentReceipt: await receiptView(order),
        paidAt: order.paidAt ?? null,
        cancelledAt: order.cancelledAt ?? null,
        refundedAt: order.refundedAt ?? null,
        completedAt: order.completedAt ?? null,
        cancellationReason: order.cancellationReason ?? null,
        ...flags(order),
    };
    if (admin) view.buyer = buyerView(order.buyerUser);
    return view;
};

const serializeSummary = (order, { admin = false } = {}) => {
    const summary = {
        id: idOf(order),
        orderCode: order.orderCode,
        createdAt: order.createdAt,
        total: order.total,
        paymentState: order.paymentState,
        orderState: order.orderState,
        itemCount: order.items.length,
        unitCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
        preview: order.items.slice(0, 3).map(item => ({
            title: item.title,
            imageUrl: item.imageUrl ?? null,
            quantity: item.quantity,
        })),
        ...flags(order),
    };
    if (admin) {
        summary.buyer = buyerView(order.buyerUser);
        summary.municipality = order.shippingAddress?.municipality ?? null;
        summary.department = order.shippingAddress?.department ?? null;
    }
    return summary;
};

module.exports = { serializeOrder, serializeSummary };
