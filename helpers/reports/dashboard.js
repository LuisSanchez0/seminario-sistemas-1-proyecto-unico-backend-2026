// Indicadores del panel de administración. Cada KPI tiene una definición explícita:
//
//   Período (hoy / semana / mes / personalizado): días completos de Guatemala (UTC-6).
//     - hoy:    el día actual.   - semana: de lunes al día actual.   - mes: del día 1 al día actual.
//   Indicadores del período (por fecha del pedido):
//     orders            pedidos recibidos (cualquier estado)
//     collectedOrders   ventas cobradas (pago confirmado, sin cancelar ni reembolsar)
//     revenue           suma del total (productos + envío) de las ventas cobradas
//     averageTicket     revenue / collectedOrders
//     units             unidades de las ventas cobradas
//     completedOrders   pedidos entregados en el período (por fecha de entrega)
//   Indicadores actuales (foto del momento, no dependen del período):
//     pendingPayment, awaitingVerification, toPrepare, inPreparation, shipped, lowStock, outOfStock
const { Order, Product, User } = require('../../models');
const { fromCents } = require('../order-states');
const { rangeBounds, resolvePeriod, PERIOD_LABELS, formatLocalDay, TIMEZONE, dayInTimezone } = require('./dates');
const { COLLECTED_MATCH, EXCLUDED_ORDER_STATES, soldProducts, orderMatch } = require('./data');
const { DEFAULT_LOW_STOCK_THRESHOLD } = require('./filters');

const periodSales = async period => {
    const collected = { $and: [{ $eq: ['$paymentState', 'PAGO_REALIZADO'] }, { $not: [{ $in: ['$orderState', EXCLUDED_ORDER_STATES] }] }] };
    const [row] = await Order.aggregate([
        { $match: orderMatch(period) },
        {
            $group: {
                _id: null,
                orders: { $sum: 1 },
                collectedOrders: { $sum: { $cond: [collected, 1, 0] } },
                revenueCents: { $sum: { $cond: [collected, { $round: [{ $multiply: ['$total', 100] }, 0] }, 0] } },
                units: { $sum: { $cond: [collected, { $sum: '$items.quantity' }, 0] } },
            },
        },
    ]);
    const { orders = 0, collectedOrders = 0, revenueCents = 0, units = 0 } = row ?? {};
    return {
        orders,
        collectedOrders,
        revenue: fromCents(revenueCents),
        averageTicket: fromCents(collectedOrders ? Math.round(revenueCents / collectedOrders) : 0),
        units,
    };
};

const completedInPeriod = ({ startDate, endDate }) => {
    const { from, toExclusive } = rangeBounds(startDate, endDate);
    return Order.countDocuments({ ...COLLECTED_MATCH, orderState: 'COMPLETADO', completedAt: { $gte: from, $lt: toExclusive } });
};

const currentCounts = async () => {
    const paid = { paymentState: 'PAGO_REALIZADO' };
    const [pendingPayment, awaitingVerification, toPrepare, inPreparation, shipped] = await Promise.all([
        Order.countDocuments({ paymentState: 'EN_ESPERA_DE_PAGO' }),
        Order.countDocuments({ paymentState: 'EN_ESPERA_DE_PAGO', 'paymentReceipt.key': { $type: 'string' } }),
        Order.countDocuments({ ...paid, orderState: 'PENDIENTE' }),
        Order.countDocuments({ ...paid, orderState: 'EN_PROCESO' }),
        Order.countDocuments({ ...paid, orderState: { $in: ['PARCIALMENTE_ENVIADO', 'ENVIADO'] } }),
    ]);
    return { pendingPayment, awaitingVerification, toPrepare, inPreparation, shipped };
};

const stockAlerts = async threshold => {
    const [lowStock, outOfStock, lowest] = await Promise.all([
        Product.countDocuments({ state: true, stock: { $gt: 0, $lte: threshold } }),
        Product.countDocuments({ state: true, stock: { $lte: 0 } }),
        Product.find({ state: true, stock: { $lte: threshold } }).sort({ stock: 1, title: 1 }).limit(5).select('title stock').lean(),
    ]);
    return {
        lowStock,
        outOfStock,
        lowestStock: lowest.map(product => ({ id: String(product._id), title: product.title, stock: product.stock })),
    };
};

const buildDashboard = async ({ period: periodKey = 'month', startDate, endDate, lowStockThreshold = DEFAULT_LOW_STOCK_THRESHOLD } = {}, now = new Date()) => {
    const period = resolvePeriod(periodKey, { startDate, endDate }, now);
    const [sales, completedOrders, counts, alerts, customers, sold] = await Promise.all([
        periodSales(period),
        completedInPeriod(period),
        currentCounts(),
        stockAlerts(lowStockThreshold),
        User.countDocuments({ role: 'COMMON_ROLE', state: true }),
        soldProducts(period, null),
    ]);

    const topProducts = sold.grouped
        .sort((a, b) => b.units - a.units || b.revenueCents - a.revenueCents || a.title.localeCompare(b.title, 'es'))
        .slice(0, 5)
        .map(row => ({ id: String(row._id), title: row.title, units: row.units, revenue: fromCents(row.revenueCents) }));

    return {
        timezone: TIMEZONE,
        generatedAt: now,
        today: dayInTimezone(now),
        period: {
            key: period.key,
            label: PERIOD_LABELS[period.key],
            startDate: period.startDate,
            endDate: period.endDate,
            text: period.startDate === period.endDate
                ? formatLocalDay(period.startDate)
                : `${formatLocalDay(period.startDate)} al ${formatLocalDay(period.endDate)}`,
        },
        sales: { ...sales, completedOrders },
        current: { ...counts, lowStock: alerts.lowStock, outOfStock: alerts.outOfStock, lowStockThreshold, customers },
        lowestStock: alerts.lowestStock,
        topProducts,
    };
};

module.exports = { buildDashboard };
