// Construcción de reportes a partir de la base de datos. Pantalla, PDF y Excel salen de estas
// mismas funciones: lo único que cambia es si se devuelve una página de filas o todas.
//
// Definiciones de negocio (también se imprimen en los archivos exportados):
//   - Pedido cobrado (venta válida): paymentState = PAGO_REALIZADO y el pedido no está
//     CANCELADO ni REEMBOLSADO. Un reembolso cambia ambos estados, así que deja de contar.
//   - Ingresos cobrados: suma del total del pedido (productos + envío) de los pedidos cobrados.
//   - Venta de productos: suma de los subtotales por producto de los pedidos cobrados (sin envío).
//   - La fecha del reporte es la fecha del pedido (createdAt) en hora de Guatemala.
//   - Todo el dinero se suma en centavos enteros y se convierte a quetzales al final.
const { Order, Product, Brand, Subcategory, User } = require('../../models');
const { toCents, fromCents, ORDER_STATES } = require('../order-states');
const {
    TIMEZONE, rangeBounds, dayInTimezone, formatLocalDay,
} = require('./dates');
const {
    PAYMENT_STATE_LABELS, ORDER_STATE_LABELS, CATEGORY_LABELS, STOCK_STATUS_LABELS, label,
} = require('./labels');
const { ReportError } = require('./filters');

const MAX_EXPORT_ROWS = 20000;
const EXCLUDED_ORDER_STATES = ['CANCELADO', 'REEMBOLSADO'];

const COLLECTED_MATCH = { paymentState: 'PAGO_REALIZADO', orderState: { $nin: EXCLUDED_ORDER_STATES } };
const isCollected = order => order.paymentState === 'PAGO_REALIZADO' && !EXCLUDED_ORDER_STATES.includes(order.orderState);

const escapeRegex = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const centsOf = amount => toCents(amount ?? 0);

// Acumula filas respetando la página solicitada; con `all` conserva todas (con tope de seguridad).
const createRowCollector = ({ all, offset = 0, limit = 20 }) => {
    const rows = [];
    let count = 0;
    return {
        rows,
        get count() { return count; },
        push(row) {
            if (all) {
                if (count >= MAX_EXPORT_ROWS) {
                    throw new ReportError(413, `El reporte supera ${MAX_EXPORT_ROWS} filas. Acota el rango de fechas o los filtros para exportarlo.`);
                }
                rows.push(row);
            } else if (count >= offset && count < offset + limit) {
                rows.push(row);
            }
            count += 1;
        },
    };
};

const findBuyerIds = async search => {
    if (!search) return null;
    const pattern = { $regex: escapeRegex(search), $options: 'i' };
    const buyers = await User.find({ $or: [{ name: pattern }, { email: pattern }] }).select('_id').limit(500).lean();
    return buyers.map(buyer => buyer._id);
};

const loadUsers = async ids => {
    const unique = [...new Set(ids.map(String))];
    if (!unique.length) return new Map();
    const users = await User.find({ _id: { $in: unique } }).select('name email').lean();
    return new Map(users.map(user => [String(user._id), user]));
};

const periodText = ({ startDate, endDate }) => `${formatLocalDay(startDate)} al ${formatLocalDay(endDate)}`;

const orderMatch = ({ startDate, endDate }) => {
    const { from, toExclusive } = rangeBounds(startDate, endDate);
    return { createdAt: { $gte: from, $lt: toExclusive } };
};

const COLLECTED_NOTE = 'Pedido cobrado: pago confirmado y no cancelado ni reembolsado.';

// ── Ventas ───────────────────────────────────────────────────────────────────

const SALES_COLUMNS = [
    { key: 'orderCode', header: 'Pedido', type: 'text', width: 19 },
    { key: 'createdAt', header: 'Fecha', type: 'datetime', width: 13 },
    { key: 'customerName', header: 'Cliente', type: 'text', width: 12 },
    { key: 'customerEmail', header: 'Correo', type: 'text', width: 16 },
    { key: 'paymentState', header: 'Pago', type: 'text', width: 13 },
    { key: 'orderState', header: 'Estado del pedido', type: 'text', width: 11 },
    { key: 'units', header: 'Unidades', type: 'int', width: 9 },
    { key: 'subtotal', header: 'Productos', type: 'money', width: 9 },
    { key: 'shippingCost', header: 'Envío', type: 'money', width: 7 },
    { key: 'total', header: 'Total', type: 'money', width: 9 },
    { key: 'collected', header: 'Ingreso cobrado', type: 'money', width: 10 },
];

const buildSalesReport = async (filters, { all = false, offset = 0, limit = 20 } = {}) => {
    const match = orderMatch(filters);
    if (filters.paymentState) match.paymentState = filters.paymentState;
    if (filters.orderState) match.orderState = filters.orderState;
    const buyers = await findBuyerIds(filters.customer);
    if (buyers) match.buyerUser = { $in: buyers };

    const cursor = Order.aggregate([
        { $match: match },
        { $sort: { createdAt: -1, _id: -1 } },
        {
            $project: {
                orderCode: 1, createdAt: 1, buyerUser: 1, paymentState: 1, orderState: 1,
                subtotal: 1, shippingCost: 1, total: 1, units: { $sum: '$items.quantity' },
            },
        },
    ]).cursor();

    const collector = createRowCollector({ all, offset, limit });
    const byPayment = new Map();
    const byOrder = new Map();
    const totals = { units: 0, subtotal: 0, shippingCost: 0, total: 0, collected: 0 };
    const summary = {
        orders: 0, collectedOrders: 0, collectedUnits: 0, pendingCents: 0,
        cancelledOrders: 0, refundedOrders: 0, refundedCents: 0,
    };

    const bump = (map, key, cents) => {
        const entry = map.get(key) ?? { orders: 0, cents: 0 };
        entry.orders += 1;
        entry.cents += cents;
        map.set(key, entry);
    };

    for await (const order of cursor) {
        const totalCents = centsOf(order.total);
        const collected = isCollected(order);
        summary.orders += 1;
        bump(byPayment, order.paymentState, totalCents);
        bump(byOrder, order.orderState, totalCents);
        if (collected) {
            summary.collectedOrders += 1;
            summary.collectedUnits += order.units;
        }
        if (order.paymentState === 'EN_ESPERA_DE_PAGO') summary.pendingCents += totalCents;
        if (order.orderState === 'CANCELADO') summary.cancelledOrders += 1;
        if (order.orderState === 'REEMBOLSADO') {
            summary.refundedOrders += 1;
            summary.refundedCents += totalCents;
        }
        totals.units += order.units;
        totals.subtotal += centsOf(order.subtotal);
        totals.shippingCost += centsOf(order.shippingCost);
        totals.total += totalCents;
        if (collected) totals.collected += totalCents;
        collector.push({
            orderCode: order.orderCode,
            createdAt: order.createdAt,
            buyerUser: order.buyerUser,
            paymentState: label(PAYMENT_STATE_LABELS, order.paymentState),
            orderState: label(ORDER_STATE_LABELS, order.orderState),
            units: order.units,
            subtotal: fromCents(centsOf(order.subtotal)),
            shippingCost: fromCents(centsOf(order.shippingCost)),
            total: fromCents(totalCents),
            collected: fromCents(collected ? totalCents : 0),
        });
    }

    const users = await loadUsers(collector.rows.map(row => row.buyerUser));
    const rows = collector.rows.map(({ buyerUser, ...row }) => {
        const user = users.get(String(buyerUser));
        return { ...row, customerName: user?.name ?? 'Cliente eliminado', customerEmail: user?.email ?? '' };
    });

    const average = summary.collectedOrders ? Math.round(totals.collected / summary.collectedOrders) : 0;
    const breakdown = (title, map, order, labels) => ({
        key: title,
        title: { payment: 'Por estado de pago', order: 'Por estado del pedido' }[title],
        columns: [
            { key: 'state', header: 'Estado', type: 'text', width: 40 },
            { key: 'orders', header: 'Pedidos', type: 'int', width: 20 },
            { key: 'amount', header: 'Monto', type: 'money', width: 25 },
        ],
        rows: order.filter(state => map.has(state)).map(state => ({
            state: label(labels, state), orders: map.get(state).orders, amount: fromCents(map.get(state).cents),
        })),
        totals: { orders: summary.orders, amount: fromCents(totals.total) },
    });

    return {
        key: 'sales',
        title: 'Reporte de ventas',
        fileBase: `reporte-ventas-${filters.startDate}-a-${filters.endDate}`,
        period: { startDate: filters.startDate, endDate: filters.endDate },
        filters: [
            { label: 'Período', value: periodText(filters) },
            { label: 'Estado de pago', value: filters.paymentState ? label(PAYMENT_STATE_LABELS, filters.paymentState) : 'Todos' },
            { label: 'Estado del pedido', value: filters.orderState ? label(ORDER_STATE_LABELS, filters.orderState) : 'Todos' },
            { label: 'Cliente', value: filters.customer ?? 'Todos' },
        ],
        notes: [
            `${COLLECTED_NOTE} Los ingresos cobrados incluyen el envío.`,
            'La fecha es la del pedido, en hora de Guatemala.',
            'Los pedidos pendientes de pago, cancelados o reembolsados no cuentan como ingreso cobrado.',
        ],
        kpis: [
            { key: 'orders', label: 'Pedidos del período', value: summary.orders, type: 'int' },
            { key: 'collectedOrders', label: 'Ventas cobradas', value: summary.collectedOrders, type: 'int' },
            { key: 'collectedRevenue', label: 'Ingresos cobrados', value: fromCents(totals.collected), type: 'money' },
            { key: 'averageTicket', label: 'Ticket promedio', value: fromCents(average), type: 'money' },
            { key: 'collectedUnits', label: 'Unidades cobradas', value: summary.collectedUnits, type: 'int' },
            { key: 'pendingAmount', label: 'Por cobrar', value: fromCents(summary.pendingCents), type: 'money' },
            { key: 'cancelledOrders', label: 'Cancelados', value: summary.cancelledOrders, type: 'int' },
            { key: 'refundedOrders', label: 'Reembolsados', value: summary.refundedOrders, type: 'int' },
            { key: 'refundedAmount', label: 'Monto reembolsado', value: fromCents(summary.refundedCents), type: 'money' },
        ],
        breakdowns: [
            breakdown('payment', byPayment, ['EN_ESPERA_DE_PAGO', 'PAGO_REALIZADO', 'CANCELADO', 'REEMBOLSADO'], PAYMENT_STATE_LABELS),
            breakdown('order', byOrder, ORDER_STATES, ORDER_STATE_LABELS),
        ],
        columns: SALES_COLUMNS,
        rows,
        rowCount: collector.count,
        totals: {
            units: totals.units,
            subtotal: fromCents(totals.subtotal),
            shippingCost: fromCents(totals.shippingCost),
            total: fromCents(totals.total),
            collected: fromCents(totals.collected),
        },
    };
};

// ── Productos ────────────────────────────────────────────────────────────────

const PRODUCT_COLUMNS = [
    { key: 'title', header: 'Producto', type: 'text', width: 26 },
    { key: 'brand', header: 'Marca', type: 'text', width: 14 },
    { key: 'category', header: 'Categoría', type: 'text', width: 13 },
    { key: 'units', header: 'Unidades', type: 'int', width: 8 },
    { key: 'orders', header: 'Pedidos', type: 'int', width: 8 },
    { key: 'revenue', header: 'Venta', type: 'money', width: 11 },
    { key: 'averagePrice', header: 'Precio promedio', type: 'money', width: 11 },
    { key: 'share', header: '% de la venta', type: 'percent', width: 9 },
    { key: 'stock', header: 'Stock actual', type: 'int', width: 8 },
];

const catalogMaps = async () => {
    const [brands, subcategories] = await Promise.all([Brand.find().lean(), Subcategory.find().lean()]);
    return {
        brands: new Map(brands.map(brand => [String(brand._id), brand.name])),
        subcategories: new Map(subcategories.map(item => [String(item._id), item.name])),
    };
};

const productIdsMatching = async ({ category, brand, search }) => {
    if (!category && !brand && !search) return null;
    const query = {};
    if (category) query.category = category;
    if (brand) query.brand = brand;
    if (search) query.title = { $regex: escapeRegex(search), $options: 'i' };
    return Product.find(query).distinct('_id');
};

// Pedidos cobrados del período, una fila por producto (en centavos).
const soldProducts = async ({ startDate, endDate, orderState }, productIds) => {
    const match = { ...orderMatch({ startDate, endDate }), ...COLLECTED_MATCH };
    if (orderState) match.orderState = orderState;
    const lines = [{ $match: match }, { $unwind: '$items' }];
    if (productIds) lines.push({ $match: { 'items.product': { $in: productIds } } });

    const [grouped, distinct] = await Promise.all([
        Order.aggregate([
            ...lines,
            {
                $group: {
                    _id: '$items.product',
                    title: { $first: '$items.title' },
                    units: { $sum: '$items.quantity' },
                    // Un producto aparece una sola vez por pedido, así que cada línea es un pedido.
                    orders: { $sum: 1 },
                    revenueCents: { $sum: { $round: [{ $multiply: ['$items.subtotal', 100] }, 0] } },
                },
            },
        ]),
        Order.aggregate([...lines, { $group: { _id: '$_id' } }, { $count: 'orders' }]),
    ]);
    return { grouped, orderCount: distinct[0]?.orders ?? 0 };
};

const buildProductsReport = async (filters, { all = false, offset = 0, limit = 20 } = {}) => {
    const productIds = await productIdsMatching(filters);
    const [{ grouped, orderCount }, maps] = await Promise.all([soldProducts(filters, productIds), catalogMaps()]);
    const products = await Product.find({ _id: { $in: grouped.map(row => row._id) } })
        .select('title category brand stock').lean();
    const productById = new Map(products.map(product => [String(product._id), product]));

    const totalRevenue = grouped.reduce((sum, row) => sum + row.revenueCents, 0);
    const totalUnits = grouped.reduce((sum, row) => sum + row.units, 0);

    const rows = grouped.map(row => {
        const product = productById.get(String(row._id));
        return {
            title: product?.title ?? row.title,
            brand: product ? (maps.brands.get(String(product.brand)) ?? 'Sin marca') : 'Sin marca',
            category: product ? label(CATEGORY_LABELS, product.category) : 'Sin categoría',
            units: row.units,
            orders: row.orders,
            revenueCents: row.revenueCents,
            revenue: fromCents(row.revenueCents),
            averagePrice: fromCents(Math.round(row.revenueCents / row.units)),
            share: totalRevenue ? Math.round((row.revenueCents / totalRevenue) * 10000) / 10000 : 0,
            stock: product?.stock ?? 0,
        };
    });
    const direction = filters.order === 'least' ? 1 : -1;
    rows.sort((a, b) => direction * (a.units - b.units) || b.revenueCents - a.revenueCents || a.title.localeCompare(b.title, 'es'));

    if (all && rows.length > MAX_EXPORT_ROWS) {
        throw new ReportError(413, `El reporte supera ${MAX_EXPORT_ROWS} filas. Acota los filtros para exportarlo.`);
    }
    const page = (all ? rows : rows.slice(offset, offset + limit)).map(({ revenueCents, ...row }) => row);

    const group = (keyOf, nameLabel) => {
        const map = new Map();
        for (const row of rows) {
            const key = keyOf(row);
            const entry = map.get(key) ?? { units: 0, cents: 0, products: 0 };
            entry.units += row.units;
            entry.cents += row.revenueCents;
            entry.products += 1;
            map.set(key, entry);
        }
        return {
            columns: [
                { key: 'name', header: nameLabel, type: 'text', width: 32 },
                { key: 'products', header: 'Productos', type: 'int', width: 14 },
                { key: 'units', header: 'Unidades', type: 'int', width: 14 },
                { key: 'revenue', header: 'Venta', type: 'money', width: 18 },
                { key: 'share', header: '% de la venta', type: 'percent', width: 14 },
            ],
            rows: [...map.entries()]
                .sort((a, b) => b[1].cents - a[1].cents || a[0].localeCompare(b[0], 'es'))
                .map(([name, entry]) => ({
                    name,
                    products: entry.products,
                    units: entry.units,
                    revenue: fromCents(entry.cents),
                    share: totalRevenue ? Math.round((entry.cents / totalRevenue) * 10000) / 10000 : 0,
                })),
            totals: { products: rows.length, units: totalUnits, revenue: fromCents(totalRevenue) },
        };
    };

    const brandName = filters.brand ? (maps.brands.get(filters.brand) ?? 'Marca desconocida') : 'Todas';
    return {
        key: 'products',
        title: 'Reporte de productos',
        fileBase: `reporte-productos-${filters.startDate}-a-${filters.endDate}`,
        period: { startDate: filters.startDate, endDate: filters.endDate },
        filters: [
            { label: 'Período', value: periodText(filters) },
            { label: 'Categoría', value: filters.category ? label(CATEGORY_LABELS, filters.category) : 'Todas' },
            { label: 'Marca', value: brandName },
            { label: 'Producto', value: filters.search ?? 'Todos' },
            { label: 'Estado del pedido', value: filters.orderState ? label(ORDER_STATE_LABELS, filters.orderState) : 'Todos los cobrados' },
            { label: 'Orden', value: filters.order === 'least' ? 'Menos vendidos primero' : 'Más vendidos primero' },
        ],
        notes: [
            `Solo cuenta ventas válidas. ${COLLECTED_NOTE}`,
            'La venta de cada producto es la suma de sus subtotales; no incluye el costo de envío.',
            'Categoría, marca y stock son los actuales del catálogo.',
        ],
        kpis: [
            { key: 'units', label: 'Unidades vendidas', value: totalUnits, type: 'int' },
            { key: 'revenue', label: 'Venta de productos', value: fromCents(totalRevenue), type: 'money' },
            { key: 'products', label: 'Productos distintos', value: rows.length, type: 'int' },
            { key: 'orders', label: 'Pedidos incluidos', value: orderCount, type: 'int' },
        ],
        breakdowns: [
            { key: 'category', title: 'Por categoría', ...group(row => row.category, 'Categoría') },
            { key: 'brand', title: 'Por marca', ...group(row => row.brand, 'Marca') },
        ],
        columns: PRODUCT_COLUMNS,
        rows: page,
        rowCount: rows.length,
        totals: { units: totalUnits, revenue: fromCents(totalRevenue) },
    };
};

// ── Inventario ───────────────────────────────────────────────────────────────

const INVENTORY_COLUMNS = [
    { key: 'title', header: 'Producto', type: 'text', width: 27 },
    { key: 'brand', header: 'Marca', type: 'text', width: 14 },
    { key: 'category', header: 'Categoría', type: 'text', width: 13 },
    { key: 'subcategory', header: 'Subcategoría', type: 'text', width: 14 },
    { key: 'price', header: 'Precio', type: 'money', width: 10 },
    { key: 'stock', header: 'Stock', type: 'int', width: 8 },
    { key: 'status', header: 'Estado', type: 'text', width: 11 },
];

const stockStatus = (stock, threshold) => (stock <= 0 ? 'out' : stock <= threshold ? 'low' : 'ok');

const inventoryQuery = ({ category, brand, search, stockStatus: status, lowStockThreshold }) => {
    // Solo productos activos: un producto eliminado del catálogo no forma parte del inventario.
    const query = { state: true };
    if (category) query.category = category;
    if (brand) query.brand = brand;
    if (search) query.title = { $regex: escapeRegex(search), $options: 'i' };
    if (status === 'out') query.stock = { $lte: 0 };
    if (status === 'low') query.stock = { $gt: 0, $lte: lowStockThreshold };
    if (status === 'ok') query.stock = { $gt: lowStockThreshold };
    return query;
};

const buildInventoryReport = async (filters, { all = false, offset = 0, limit = 20 } = {}, now = new Date()) => {
    const maps = await catalogMaps();
    // Se lee siempre de la base de datos (no de la caché de Redis) para no mostrar stock viejo.
    const cursor = Product.find(inventoryQuery(filters)).sort({ stock: 1, title: 1, _id: 1 }).lean().cursor();
    const collector = createRowCollector({ all, offset, limit });
    const counts = { out: 0, low: 0, ok: 0 };
    let units = 0;
    const byCategory = new Map();
    const byBrand = new Map();
    const bump = (map, key, status, stock) => {
        const entry = map.get(key) ?? { products: 0, units: 0, out: 0, low: 0 };
        entry.products += 1;
        entry.units += stock;
        if (status === 'out') entry.out += 1;
        if (status === 'low') entry.low += 1;
        map.set(key, entry);
    };

    for await (const product of cursor) {
        const status = stockStatus(product.stock, filters.lowStockThreshold);
        counts[status] += 1;
        units += product.stock;
        const categoryName = label(CATEGORY_LABELS, product.category);
        const brandName = maps.brands.get(String(product.brand)) ?? 'Sin marca';
        bump(byCategory, categoryName, status, product.stock);
        bump(byBrand, brandName, status, product.stock);
        collector.push({
            title: product.title,
            brand: brandName,
            category: categoryName,
            subcategory: maps.subcategories.get(String(product.subcategory)) ?? '',
            price: fromCents(centsOf(product.price)),
            stock: product.stock,
            status: STOCK_STATUS_LABELS[status],
        });
    }

    const group = (map, nameLabel) => ({
        columns: [
            { key: 'name', header: nameLabel, type: 'text', width: 32 },
            { key: 'products', header: 'Productos', type: 'int', width: 14 },
            { key: 'units', header: 'Unidades en stock', type: 'int', width: 18 },
            { key: 'low', header: 'Stock bajo', type: 'int', width: 14 },
            { key: 'out', header: 'Agotados', type: 'int', width: 14 },
        ],
        rows: [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'es')).map(([name, entry]) => ({ name, ...entry })),
        totals: { products: collector.count, units, low: counts.low, out: counts.out },
    });

    const brandName = filters.brand ? (maps.brands.get(filters.brand) ?? 'Marca desconocida') : 'Todas';
    const today = dayInTimezone(now);
    return {
        key: 'inventory',
        title: 'Reporte de inventario',
        fileBase: `inventario-${today}`,
        period: null,
        filters: [
            { label: 'Categoría', value: filters.category ? label(CATEGORY_LABELS, filters.category) : 'Todas' },
            { label: 'Marca', value: brandName },
            { label: 'Producto', value: filters.search ?? 'Todos' },
            {
                label: 'Estado de stock',
                value: { all: 'Todos', ok: 'Disponible', low: 'Stock bajo', out: 'Agotado' }[filters.stockStatus],
            },
            { label: 'Umbral de stock bajo', value: `${filters.lowStockThreshold} unidades o menos` },
        ],
        notes: [
            `Existencias al momento de generar el reporte (${TIMEZONE}). Solo productos activos.`,
            `Stock bajo: de 1 a ${filters.lowStockThreshold} unidades. Agotado: 0 unidades.`,
            'El stock ya descuenta los pedidos recibidos; no se modela costo ni stock reservado, por eso no se calcula valor del inventario.',
        ],
        kpis: [
            { key: 'products', label: 'Productos', value: collector.count, type: 'int' },
            { key: 'units', label: 'Unidades en stock', value: units, type: 'int' },
            { key: 'ok', label: 'Disponibles', value: counts.ok, type: 'int' },
            { key: 'low', label: 'Stock bajo', value: counts.low, type: 'int' },
            { key: 'out', label: 'Agotados', value: counts.out, type: 'int' },
        ],
        breakdowns: [
            { key: 'category', title: 'Por categoría', ...group(byCategory, 'Categoría') },
            { key: 'brand', title: 'Por marca', ...group(byBrand, 'Marca') },
        ],
        columns: INVENTORY_COLUMNS,
        rows: collector.rows,
        rowCount: collector.count,
        totals: { stock: units },
    };
};

// ── Clientes ─────────────────────────────────────────────────────────────────

const CUSTOMER_COLUMNS = [
    { key: 'name', header: 'Cliente', type: 'text', width: 20 },
    { key: 'email', header: 'Correo', type: 'text', width: 25 },
    { key: 'orders', header: 'Pedidos', type: 'int', width: 8 },
    { key: 'collectedOrders', header: 'Compras cobradas', type: 'int', width: 10 },
    { key: 'purchased', header: 'Total comprado', type: 'money', width: 12 },
    { key: 'averageTicket', header: 'Ticket promedio', type: 'money', width: 12 },
    { key: 'lastOrderAt', header: 'Último pedido', type: 'datetime', width: 12 },
    { key: 'repeat', header: 'Recurrente', type: 'text', width: 9 },
];

const buildCustomersReport = async (filters, { all = false, offset = 0, limit = 20 } = {}) => {
    const match = orderMatch(filters);
    const buyers = await findBuyerIds(filters.customer);
    if (buyers) match.buyerUser = { $in: buyers };
    const collected = { $and: [{ $eq: ['$paymentState', 'PAGO_REALIZADO'] }, { $not: [{ $in: ['$orderState', EXCLUDED_ORDER_STATES] }] }] };

    const grouped = await Order.aggregate([
        { $match: match },
        {
            $group: {
                _id: '$buyerUser',
                orders: { $sum: 1 },
                collectedOrders: { $sum: { $cond: [collected, 1, 0] } },
                purchasedCents: { $sum: { $cond: [collected, { $round: [{ $multiply: ['$total', 100] }, 0] }, 0] } },
                lastOrderAt: { $max: '$createdAt' },
            },
        },
    ]);
    const users = await loadUsers(grouped.map(row => row._id));

    let rows = grouped.map(row => {
        const user = users.get(String(row._id));
        return {
            name: user?.name ?? 'Cliente eliminado',
            email: user?.email ?? '',
            orders: row.orders,
            collectedOrders: row.collectedOrders,
            purchasedCents: row.purchasedCents,
            purchased: fromCents(row.purchasedCents),
            averageTicket: fromCents(row.collectedOrders ? Math.round(row.purchasedCents / row.collectedOrders) : 0),
            lastOrderAt: row.lastOrderAt,
            repeat: row.collectedOrders >= 2 ? 'Sí' : 'No',
        };
    });
    if (filters.repeatOnly) rows = rows.filter(row => row.collectedOrders >= 2);
    rows.sort((a, b) => b.purchasedCents - a.purchasedCents || b.orders - a.orders
        || a.name.localeCompare(b.name, 'es') || a.email.localeCompare(b.email));

    if (all && rows.length > MAX_EXPORT_ROWS) {
        throw new ReportError(413, `El reporte supera ${MAX_EXPORT_ROWS} filas. Acota los filtros para exportarlo.`);
    }
    const page = (all ? rows : rows.slice(offset, offset + limit)).map(({ purchasedCents, ...row }) => row);

    const totalPurchased = rows.reduce((sum, row) => sum + row.purchasedCents, 0);
    const totalOrders = rows.reduce((sum, row) => sum + row.orders, 0);
    const totalCollected = rows.reduce((sum, row) => sum + row.collectedOrders, 0);
    const repeatCustomers = rows.filter(row => row.collectedOrders >= 2).length;

    return {
        key: 'customers',
        title: 'Reporte de clientes',
        fileBase: `reporte-clientes-${filters.startDate}-a-${filters.endDate}`,
        period: { startDate: filters.startDate, endDate: filters.endDate },
        filters: [
            { label: 'Período', value: periodText(filters) },
            { label: 'Cliente', value: filters.customer ?? 'Todos' },
            { label: 'Solo recurrentes', value: filters.repeatOnly ? 'Sí' : 'No' },
        ],
        notes: [
            `Incluye a los clientes con al menos un pedido en el período. ${COLLECTED_NOTE}`,
            'Total comprado: suma del total de sus pedidos cobrados (incluye envío).',
            'Recurrente: dos o más compras cobradas en el período.',
        ],
        kpis: [
            { key: 'customers', label: 'Clientes con pedidos', value: rows.length, type: 'int' },
            { key: 'repeatCustomers', label: 'Clientes recurrentes', value: repeatCustomers, type: 'int' },
            { key: 'orders', label: 'Pedidos', value: totalOrders, type: 'int' },
            { key: 'collectedOrders', label: 'Compras cobradas', value: totalCollected, type: 'int' },
            { key: 'purchased', label: 'Total comprado', value: fromCents(totalPurchased), type: 'money' },
        ],
        breakdowns: [],
        columns: CUSTOMER_COLUMNS,
        rows: page,
        rowCount: rows.length,
        totals: { orders: totalOrders, collectedOrders: totalCollected, purchased: fromCents(totalPurchased) },
    };
};

const BUILDERS = {
    sales: buildSalesReport,
    products: buildProductsReport,
    inventory: buildInventoryReport,
    customers: buildCustomersReport,
};

module.exports = {
    MAX_EXPORT_ROWS,
    COLLECTED_MATCH,
    EXCLUDED_ORDER_STATES,
    BUILDERS,
    buildSalesReport,
    buildProductsReport,
    buildInventoryReport,
    buildCustomersReport,
    soldProducts,
    catalogMaps,
    stockStatus,
    orderMatch,
    isCollected,
};
