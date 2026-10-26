const { Schema, model } = require('mongoose');
const {
    PAYMENT_STATES, ORDER_STATES, SHIPPING_STATUSES, PAYMENT_METHODS,
} = require('../helpers/order-states');

const ShippingHistorySchema = Schema({
    status: { type: String, enum: SHIPPING_STATUSES, required: true },
    changedAt: { type: Date, default: Date.now, required: true },
    changedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { _id: false });

// Cada línea guarda una copia del producto al momento de la compra: si el catálogo
// cambia después, el historial del pedido sigue mostrando lo que se compró y a qué precio.
const OrderItemSchema = Schema({
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: [true, 'El producto es obligatorio'] },
    title: { type: String, required: true },
    brandName: { type: String },
    slug: { type: String },
    imageUrl: { type: String },
    unitPrice: { type: Number, required: true, min: [0, 'El precio unitario no puede ser negativo'] },
    quantity: {
        type: Number,
        required: [true, 'La cantidad del producto es obligatoria'],
        min: [1, 'La cantidad debe ser mayor o igual a 1'],
        validate: { validator: Number.isInteger, message: 'La cantidad debe ser un número entero' },
    },
    subtotal: { type: Number, required: true, min: [0, 'El subtotal no puede ser negativo'] },
    shippingStatus: { type: String, enum: SHIPPING_STATUSES, default: 'ORDER_PLACED' },
    shippingStatusHistory: { type: [ShippingHistorySchema], default: [] },
});

const ShippingAddressSnapshotSchema = Schema({
    address: { type: Schema.Types.ObjectId, ref: 'Address' },
    department: { type: String, required: true },
    municipality: { type: String, required: true },
    street: { type: String },
    full_address: { type: String, required: true },
    phoneNumber: { type: String, required: true },
}, { _id: false });

const OrderSchema = Schema({
    orderCode: { type: String, required: true },
    buyerUser: { type: Schema.Types.ObjectId, ref: 'User', required: [true, 'El usuario del pedido es obligatorio'] },
    items: {
        type: [OrderItemSchema],
        validate: { validator: items => items.length > 0, message: 'El pedido debe tener al menos un producto' },
    },
    shippingAddress: { type: ShippingAddressSnapshotSchema, required: true },
    subtotal: { type: Number, required: true, min: 0 },
    shippingCost: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },

    paymentMethod: { type: String, enum: PAYMENT_METHODS, required: [true, 'El método de pago es obligatorio'] },
    paymentState: { type: String, enum: PAYMENT_STATES, default: 'EN_ESPERA_DE_PAGO' },
    orderState: { type: String, enum: ORDER_STATES, default: 'PENDIENTE' },

    // Comprobante de transferencia subido por el cliente. Solo se guarda la key: el archivo es
    // privado y la URL firmada se genera al leer el pedido.
    paymentReceipt: {
        key: { type: String },
        uploadedAt: { type: Date },
    },
    paymentReference: { type: String, trim: true, maxlength: 120 },
    paidAt: { type: Date },
    paymentConfirmedBy: { type: Schema.Types.ObjectId, ref: 'User' },

    cancelledAt: { type: Date },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User' },
    cancellationReason: { type: String, trim: true, maxlength: 300 },
    refundedAt: { type: Date },
    refundedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    completedAt: { type: Date },
    // Garantiza que el stock de un pedido se devuelva una sola vez.
    stockRestored: { type: Boolean, default: false },

    nit: { type: String, trim: true, uppercase: true, default: 'CF' },
    notes: { type: String, trim: true, maxlength: 500 },
    // Identificador generado por el cliente para que reintentar un checkout no duplique el pedido.
    checkoutKey: { type: String, trim: true, maxlength: 80 },
}, { timestamps: true });

OrderSchema.index({ orderCode: 1 }, { unique: true });
OrderSchema.index({ buyerUser: 1, createdAt: -1 });
OrderSchema.index({ buyerUser: 1, checkoutKey: 1 }, {
    unique: true, partialFilterExpression: { checkoutKey: { $type: 'string' } },
});
OrderSchema.index({ paymentState: 1, orderState: 1, createdAt: -1 });

module.exports = model('Order', OrderSchema);
