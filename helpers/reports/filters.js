// Validación y normalización de los filtros de reportes. Una sola función por tipo: la misma
// que usa la pantalla la usan el PDF y el Excel, de modo que los tres comparten alcance.
const mongoose = require('mongoose');
const { PAYMENT_STATES, ORDER_STATES } = require('../order-states');
const { PRODUCT_CATEGORIES } = require('../product-categories');
const { isValidDay, daysBetween } = require('./dates');

class ReportError extends Error {
    constructor(status, message) {
        super(message);
        this.name = 'ReportError';
        this.status = status;
    }
}

const REPORT_TYPES = ['sales', 'products', 'inventory', 'customers'];
const STOCK_STATUSES = ['all', 'ok', 'low', 'out'];
const PRODUCT_ORDERS = ['top', 'least'];

const SALE_ORDER_STATES = ORDER_STATES.filter(state => !['CANCELADO', 'REEMBOLSADO'].includes(state));

const MAX_RANGE_DAYS = 1830; // 5 años
const MAX_TEXT = 80;
const DEFAULT_LOW_STOCK_THRESHOLD = 5;

const text = (value, name) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') throw new ReportError(400, `El filtro ${name} no es válido`);
    const trimmed = value.trim();
    if (trimmed.length > MAX_TEXT) throw new ReportError(400, `El filtro ${name} no puede exceder ${MAX_TEXT} caracteres`);
    return trimmed || undefined;
};

const oneOf = (value, allowed, name, message) => {
    const normalized = text(value, name);
    if (normalized === undefined) return undefined;
    if (!allowed.includes(normalized)) throw new ReportError(400, message);
    return normalized;
};

const period = query => {
    const { startDate, endDate } = query;
    if (!startDate || !endDate) throw new ReportError(400, 'Indica la fecha inicial y la fecha final del reporte');
    if (!isValidDay(startDate) || !isValidDay(endDate)) throw new ReportError(400, 'El rango de fechas no es válido (usa AAAA-MM-DD)');
    if (startDate > endDate) throw new ReportError(400, 'La fecha inicial no puede ser mayor que la fecha final');
    if (daysBetween(startDate, endDate) > MAX_RANGE_DAYS) throw new ReportError(400, 'El rango de fechas no puede exceder 5 años');
    return { startDate, endDate };
};

const brandId = (value) => {
    const id = text(value, 'marca');
    if (id === undefined) return undefined;
    if (!mongoose.isValidObjectId(id)) throw new ReportError(400, 'La marca no es válida');
    return id;
};

const bool = (value, name) => {
    if (value === undefined || value === '') return false;
    if (value === true || value === 'true' || value === '1') return true;
    if (value === false || value === 'false' || value === '0') return false;
    throw new ReportError(400, `El filtro ${name} no es válido`);
};

const integer = (value, { name, min, max, fallback }) => {
    if (value === undefined || value === '') return fallback;
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
        throw new ReportError(400, `${name} debe ser un entero entre ${min} y ${max}`);
    }
    return number;
};

const paymentState = query => oneOf(query.paymentState, PAYMENT_STATES, 'estado de pago', 'El estado de pago no es válido');
const orderState = query => oneOf(query.orderState, ORDER_STATES, 'estado del pedido', 'El estado del pedido no es válido');
const category = query => oneOf(query.category, PRODUCT_CATEGORIES, 'categoría', 'La categoría no es válida');

const PARSERS = {
    sales: query => ({
        ...period(query),
        paymentState: paymentState(query),
        orderState: orderState(query),
        customer: text(query.customer, 'cliente'),
    }),
    products: query => ({
        ...period(query),
        category: category(query),
        brand: brandId(query.brand),
        search: text(query.search, 'producto'),
        // Los productos solo cuentan en ventas válidas: cancelado/reembolsado nunca produce filas.
        orderState: oneOf(query.orderState, SALE_ORDER_STATES, 'estado del pedido', 'El estado del pedido no es válido para este reporte'),
        order: oneOf(query.order, PRODUCT_ORDERS, 'orden', 'El orden no es válido') ?? 'top',
    }),
    inventory: query => ({
        category: category(query),
        brand: brandId(query.brand),
        search: text(query.search, 'producto'),
        stockStatus: oneOf(query.stockStatus, STOCK_STATUSES, 'estado de stock', 'El estado de stock no es válido') ?? 'all',
        lowStockThreshold: integer(query.lowStockThreshold, {
            name: 'El umbral de stock bajo', min: 1, max: 1000, fallback: DEFAULT_LOW_STOCK_THRESHOLD,
        }),
    }),
    customers: query => ({
        ...period(query),
        customer: text(query.customer, 'cliente'),
        repeatOnly: bool(query.repeatOnly, 'clientes recurrentes'),
    }),
};

const parseReportFilters = (type, query = {}) => {
    const parser = PARSERS[type];
    if (!parser) throw new ReportError(404, 'Reporte no encontrado');
    return parser(query);
};

// Paginación de la pantalla. La exportación ignora estos valores y siempre incluye todo.
const parsePaging = query => ({
    limit: integer(query.limit, { name: 'El límite', min: 1, max: 100, fallback: 20 }),
    offset: integer(query.offset, { name: 'El offset', min: 0, max: 10000000, fallback: 0 }),
});

module.exports = {
    ReportError,
    REPORT_TYPES,
    STOCK_STATUSES,
    SALE_ORDER_STATES,
    DEFAULT_LOW_STOCK_THRESHOLD,
    MAX_RANGE_DAYS,
    parseReportFilters,
    parsePaging,
};
