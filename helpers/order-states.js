// Dominio puro de pedidos: estados, transiciones permitidas y dinero.
// Sin acceso a base de datos para poder probarlo de forma aislada.

const PAYMENT_STATES = ['EN_ESPERA_DE_PAGO', 'PAGO_REALIZADO', 'CANCELADO', 'REEMBOLSADO'];

const ORDER_STATES = [
    'PENDIENTE',
    'EN_PROCESO',
    'PARCIALMENTE_ENVIADO',
    'ENVIADO',
    'COMPLETADO',
    'CANCELADO',
    'REEMBOLSADO',
];

// Estado de preparación/envío de cada producto del pedido, en orden de avance.
const SHIPPING_STATUSES = ['ORDER_PLACED', 'PROCESSING', 'SHIPPED', 'DELIVERED'];

const PAYMENT_METHODS = ['TRANSFERENCIA'];

// El pedido refleja de forma manual solo estos estados; el resto se deriva de los productos.
const TERMINAL_ORDER_STATES = ['CANCELADO', 'REEMBOLSADO'];

// Pago -> pagos a los que puede pasar.
const PAYMENT_TRANSITIONS = {
    EN_ESPERA_DE_PAGO: ['PAGO_REALIZADO', 'CANCELADO'],
    PAGO_REALIZADO: ['REEMBOLSADO'],
    CANCELADO: [],
    REEMBOLSADO: [],
};

const ORDER_FILTERS = {
    all: null,
    'in-progress': ['PENDIENTE', 'EN_PROCESO', 'PARCIALMENTE_ENVIADO', 'ENVIADO'],
    completed: ['COMPLETADO'],
    cancelled: ['CANCELADO', 'REEMBOLSADO'],
};

const canTransitionPayment = (from, to) => (PAYMENT_TRANSITIONS[from] ?? []).includes(to);

// Un producto solo avanza al paso inmediato siguiente; nunca retrocede ni se salta pasos.
const nextShippingStatus = status => SHIPPING_STATUSES[SHIPPING_STATUSES.indexOf(status) + 1] ?? null;
const canTransitionShipping = (from, to) => nextShippingStatus(from) === to;

const isDispatched = status => status === 'SHIPPED' || status === 'DELIVERED';

/**
 * Estado agregado del pedido a partir del estado de cada producto.
 *   todos DELIVERED                        -> COMPLETADO
 *   todos SHIPPED/DELIVERED (alguno SHIPPED) -> ENVIADO
 *   algunos SHIPPED/DELIVERED               -> PARCIALMENTE_ENVIADO
 *   ninguno enviado, alguno PROCESSING      -> EN_PROCESO
 *   todos ORDER_PLACED                      -> PENDIENTE
 */
const deriveOrderState = statuses => {
    if (!statuses.length) return 'PENDIENTE';
    if (statuses.every(status => status === 'DELIVERED')) return 'COMPLETADO';
    const dispatched = statuses.filter(isDispatched).length;
    if (dispatched === statuses.length) return 'ENVIADO';
    if (dispatched > 0) return 'PARCIALMENTE_ENVIADO';
    if (statuses.some(status => status === 'PROCESSING')) return 'EN_PROCESO';
    return 'PENDIENTE';
};

// ── Dinero: aritmética en centavos enteros para evitar errores de coma flotante ──

const toCents = amount => Math.round((Number(amount) + Number.EPSILON) * 100);
const fromCents = cents => Math.round(cents) / 100;

module.exports = {
    PAYMENT_STATES,
    ORDER_STATES,
    SHIPPING_STATUSES,
    PAYMENT_METHODS,
    TERMINAL_ORDER_STATES,
    PAYMENT_TRANSITIONS,
    ORDER_FILTERS,
    canTransitionPayment,
    canTransitionShipping,
    nextShippingStatus,
    deriveOrderState,
    isDispatched,
    toCents,
    fromCents,
};
