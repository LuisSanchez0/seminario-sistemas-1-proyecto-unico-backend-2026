// Etiquetas en español de los estados y categorías, iguales a las que ve el administrador
// en la aplicación.
const PAYMENT_STATE_LABELS = {
    EN_ESPERA_DE_PAGO: 'Pago pendiente',
    PAGO_REALIZADO: 'Pago confirmado',
    CANCELADO: 'Cancelado',
    REEMBOLSADO: 'Reembolsado',
};

const ORDER_STATE_LABELS = {
    PENDIENTE: 'Pedido recibido',
    EN_PROCESO: 'Preparando',
    PARCIALMENTE_ENVIADO: 'Enviado parcialmente',
    ENVIADO: 'Enviado',
    COMPLETADO: 'Entregado',
    CANCELADO: 'Cancelado',
    REEMBOLSADO: 'Reembolsado',
};

const CATEGORY_LABELS = {
    ROSTRO: 'Rostro',
    OJOS_Y_CEJAS: 'Ojos y cejas',
    LABIOS: 'Labios',
    LIMPIEZA: 'Limpieza',
    TRATAMIENTOS: 'Tratamientos',
    HIDRATACION: 'Hidratación',
    PROTECCION_SOLAR: 'Protección solar',
    PERFUMES: 'Perfumes',
};

const STOCK_STATUS_LABELS = {
    out: 'Agotado',
    low: 'Stock bajo',
    ok: 'Disponible',
};

const label = (map, key) => map[key] ?? key ?? '';

module.exports = {
    PAYMENT_STATE_LABELS,
    ORDER_STATE_LABELS,
    CATEGORY_LABELS,
    STOCK_STATUS_LABELS,
    label,
};
