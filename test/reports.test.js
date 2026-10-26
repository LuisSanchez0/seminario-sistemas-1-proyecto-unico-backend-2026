const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const mongoose = require('mongoose');
const express = require('express');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');

const {
    resolvePeriod, rangeBounds, dayInTimezone, addDays, isValidDay, toWallClockDate, formatLocalDateTime,
} = require('../helpers/reports/dates');
const { parseReportFilters, ReportError } = require('../helpers/reports/filters');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = async () => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
};

const startService = async (command, args, ready, cleanup) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    cleanup.push(async () => {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit');
            child.kill('SIGTERM');
            await exited;
        }
    });
    await new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error(`${command} did not start: ${output}`)), 20000);
        const finish = callback => { clearTimeout(timer); callback(); };
        child.once('error', error => finish(() => reject(new Error(`Install ${command} to run report integration tests: ${error.message}`))));
        child.once('exit', code => finish(() => reject(new Error(`${command} exited (${code}): ${output}`))));
        const read = chunk => {
            output += chunk;
            if (ready.test(output)) finish(resolve);
        };
        child.stdout.on('data', read);
        child.stderr.on('data', read);
    });
};

const startReplicaSet = async (directory, cleanup) => {
    const port = await freePort();
    await startService('mongod', [
        '--dbpath', directory, '--port', String(port), '--bind_ip', '127.0.0.1', '--nounixsocket', '--replSet', 'rs0',
    ], /Waiting for connections/, cleanup);
    const bootstrap = await mongoose.createConnection(`mongodb://127.0.0.1:${port}/?directConnection=true`).asPromise();
    await bootstrap.db.admin().command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: `127.0.0.1:${port}` }] } });
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const hello = await bootstrap.db.admin().command({ hello: 1 });
        if (hello.isWritablePrimary) break;
        await sleep(200);
    }
    await bootstrap.close();
    return port;
};

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const hasPdfTools = spawnSync('pdftotext', ['-v']).error === undefined;

const pdfText = async (buffer, directory, name) => {
    const file = path.join(directory, `${name}.pdf`);
    await fs.writeFile(file, buffer);
    const result = spawnSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
};
const pdfPages = buffer => (buffer.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length;

const readWorkbook = async buffer => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    return workbook;
};

// ── Fechas y filtros: dominio puro ───────────────────────────────────────────

test('report dates use Guatemala (UTC-6) day boundaries, week starts Monday', () => {
    // 2026-10-24 es sábado. A las 23:30 en Guatemala ya es 25 en UTC: el reporte debe seguir en el 24.
    const lateSaturday = new Date('2026-10-25T05:30:00.000Z');
    assert.equal(dayInTimezone(lateSaturday), '2026-10-24');
    // A las 00:30 UTC del 25 todavía es el 24 local; a las 06:00 UTC ya es el 25.
    assert.equal(dayInTimezone(new Date('2026-10-25T05:59:59.999Z')), '2026-10-24');
    assert.equal(dayInTimezone(new Date('2026-10-25T06:00:00.000Z')), '2026-10-25');

    assert.deepEqual(resolvePeriod('today', {}, lateSaturday), { key: 'today', startDate: '2026-10-24', endDate: '2026-10-24' });
    assert.deepEqual(resolvePeriod('week', {}, lateSaturday), { key: 'week', startDate: '2026-10-19', endDate: '2026-10-24' });
    assert.deepEqual(resolvePeriod('month', {}, lateSaturday), { key: 'month', startDate: '2026-10-01', endDate: '2026-10-24' });
    // Domingo: la semana sigue empezando el lunes anterior.
    assert.equal(resolvePeriod('week', {}, new Date('2026-10-25T18:00:00.000Z')).startDate, '2026-10-19');
    // Lunes: la semana empieza ese mismo día.
    assert.equal(resolvePeriod('week', {}, new Date('2026-10-26T18:00:00.000Z')).startDate, '2026-10-26');
    // Cambio de año.
    assert.equal(resolvePeriod('week', {}, new Date('2027-01-01T12:00:00.000Z')).startDate, '2026-12-28');
    assert.deepEqual(resolvePeriod('custom', { startDate: '2026-02-01', endDate: '2026-02-03' }), { key: 'custom', startDate: '2026-02-01', endDate: '2026-02-03' });

    const { from, toExclusive } = rangeBounds('2026-10-01', '2026-10-31');
    assert.equal(from.toISOString(), '2026-10-01T06:00:00.000Z');
    assert.equal(toExclusive.toISOString(), '2026-11-01T06:00:00.000Z');
    assert.equal(addDays('2026-02-28', 1), '2026-03-01');
    assert.equal(addDays('2028-02-28', 1), '2028-02-29');
    assert.equal(isValidDay('2026-02-30'), false);
    assert.equal(isValidDay('2026-2-3'), false);
    assert.equal(formatLocalDateTime(new Date('2026-10-01T06:00:00.000Z')), '01/10/2026 00:00');
    assert.equal(toWallClockDate(new Date('2026-10-01T06:00:00.000Z')).toISOString(), '2026-10-01T00:00:00.000Z');
});

test('report filters are validated strictly and defaulted per report', () => {
    const fail = (type, query, pattern) => assert.throws(() => parseReportFilters(type, query), error => {
        assert.ok(error instanceof ReportError);
        assert.equal(error.status, 400);
        assert.match(error.message, pattern);
        return true;
    });
    fail('sales', {}, /fecha inicial y la fecha final/);
    fail('sales', { startDate: '2026-10-01' }, /fecha inicial y la fecha final/);
    fail('sales', { startDate: '2026-02-30', endDate: '2026-03-01' }, /rango de fechas no es válido/);
    fail('sales', { startDate: '2026-10-02', endDate: '2026-10-01' }, /no puede ser mayor/);
    fail('sales', { startDate: '2000-01-01', endDate: '2026-10-01' }, /5 años/);
    fail('sales', { startDate: '2026-10-01', endDate: '2026-10-02', paymentState: 'NOPE' }, /estado de pago/);
    fail('sales', { startDate: '2026-10-01', endDate: '2026-10-02', orderState: 'NOPE' }, /estado del pedido/);
    fail('sales', { startDate: '2026-10-01', endDate: '2026-10-02', customer: 'x'.repeat(81) }, /80 caracteres/);
    fail('sales', { startDate: '2026-10-01', endDate: '2026-10-02', customer: ['a'] }, /cliente no es válido/);
    fail('products', { startDate: '2026-10-01', endDate: '2026-10-02', category: 'ROPA' }, /categoría/);
    fail('products', { startDate: '2026-10-01', endDate: '2026-10-02', brand: 'no-id' }, /marca/);
    fail('products', { startDate: '2026-10-01', endDate: '2026-10-02', orderState: 'CANCELADO' }, /no es válido para este reporte/);
    fail('products', { startDate: '2026-10-01', endDate: '2026-10-02', order: 'random' }, /orden/);
    fail('inventory', { stockStatus: 'mucho' }, /estado de stock/);
    fail('inventory', { lowStockThreshold: '0' }, /umbral/);
    fail('inventory', { lowStockThreshold: '1.5' }, /umbral/);
    fail('customers', { startDate: '2026-10-01', endDate: '2026-10-02', repeatOnly: 'tal vez' }, /recurrentes/);

    assert.deepEqual(parseReportFilters('inventory', {}), {
        category: undefined, brand: undefined, search: undefined, stockStatus: 'all', lowStockThreshold: 5,
    });
    assert.equal(parseReportFilters('products', { startDate: '2026-10-01', endDate: '2026-10-02' }).order, 'top');
    assert.equal(parseReportFilters('customers', { startDate: '2026-10-01', endDate: '2026-10-02', repeatOnly: 'true' }).repeatOnly, true);
    assert.throws(() => parseReportFilters('nada', {}), error => error.status === 404);
});

// ── Integración: reportes, exportaciones, seguridad ─────────────────────────

test('admin reports, dashboard, PDF and Excel exports (isolated replica-set MongoDB and Redis)', { timeout: 180000 }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmetics-reports-'));
    const cleanup = [];
    let server, redis;
    t.after(async () => {
        if (server) await new Promise(resolve => server.close(resolve));
        if (redis?.isOpen) redis.destroy();
        await mongoose.disconnect();
        for (const stop of cleanup.reverse()) await stop();
        await fs.rm(directory, { recursive: true, force: true });
    });
    const mongoPort = await startReplicaSet(directory, cleanup);
    const redisPort = await freePort();
    await startService('redis-server', ['--port', String(redisPort), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--dir', directory], /Ready to accept connections/i, cleanup);

    process.env.REDIS_URL = `redis://127.0.0.1:${redisPort}`;
    process.env.SECRETEORPRIVATEKEY = 'reports-test-secret';
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_BUCKET_NAME = 'reports-test';
    await mongoose.connect(`mongodb://127.0.0.1:${mongoPort}/reports_test?directConnection=true`);
    const { Product, Brand, Subcategory, User, Order, Server } = require('../models');
    await Promise.all([Product.init(), Brand.init(), Subcategory.init(), User.init(), Order.init()]);
    redis = require('../database/config-redis');
    if (!redis.isReady) await once(redis, 'ready');

    const app = express();
    app.use(express.json());
    Server.prototype.routes.call({ app, paths: {
        address: '/api/address', auth: '/api/auth', products: '/api/products', brands: '/api/brands',
        subcategories: '/api/subcategories', productImages: '/api/upload/products', orders: '/api/orders', admin: '/api/admin',
    } });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api`;

    const admin = await User.create({ email: 'admin@example.com', name: 'Admin Lumina', password: 'testpassword', role: 'ADMIN_ROLE' });
    const alice = await User.create({ email: 'alice@example.com', name: 'Alicia Pérez', password: 'testpassword' });
    const bob = await User.create({ email: 'bob@example.com', name: 'Roberto Gómez', password: 'testpassword' });
    const carol = await User.create({ email: 'carol@example.com', name: 'Carolina Díaz', password: 'testpassword' });
    const sign = user => jwt.sign({ uid: user.id }, process.env.SECRETEORPRIVATEKEY);
    const [adminToken, aliceToken] = [admin, alice].map(sign);

    const get = async (url, auth = adminToken) => {
        const result = await fetch(`${base}${url}`, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} });
        const type = result.headers.get('content-type') ?? '';
        const body = type.includes('json') ? await result.json() : Buffer.from(await result.arrayBuffer());
        // Para inspeccionar a mano los archivos reales: REPORT_ARTIFACTS_DIR=/ruta node --test test/reports.test.js
        if (process.env.REPORT_ARTIFACTS_DIR && Buffer.isBuffer(body) && result.status === 200) {
            const name = /filename="([^"]+)"/.exec(result.headers.get('content-disposition') ?? '')?.[1];
            if (name) {
                const suffix = encodeURIComponent(url.split('?')[1] ?? '').slice(0, 60);
                await fs.mkdir(process.env.REPORT_ARTIFACTS_DIR, { recursive: true });
                await fs.writeFile(path.join(process.env.REPORT_ARTIFACTS_DIR, `${path.parse(name).name}__${suffix}${path.extname(name)}`), body);
            }
        }
        return { status: result.status, headers: result.headers, body };
    };

    // ── Catálogo ──
    const maybelline = await Brand.create({ name: 'Maybelline', slug: 'maybelline' });
    const loreal = await Brand.create({ name: "L'Oréal", slug: 'loreal' });
    const sub = {
        rostro: await Subcategory.create({ name: 'Base', slug: 'base', category: 'ROSTRO' }),
        labios: await Subcategory.create({ name: 'Labiales', slug: 'labiales', category: 'LABIOS' }),
        perfumes: await Subcategory.create({ name: 'Fragancias', slug: 'fragancias', category: 'PERFUMES' }),
    };
    const makeProduct = (title, price, stock, category, brand, subcategory, extra = {}) => Product.create({
        title, price, stock, category, brand: brand.id, subcategory: subcategory.id,
        description: 'Producto para pruebas de reportes', slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        images: [], ...extra,
    });
    const foundation = await makeProduct('Base Fit Matte', 100, 10, 'ROSTRO', maybelline, sub.rostro);
    const lipstick = await makeProduct('Labial Rojo Intenso', 50.5, 3, 'LABIOS', loreal, sub.labios);
    const blush = await makeProduct('Rubor Rosa Suave', 75.25, 0, 'ROSTRO', maybelline, sub.rostro);
    const perfume = await makeProduct('Perfume Floral', 200, 20, 'PERFUMES', loreal, sub.perfumes);
    const inactive = await makeProduct('Producto retirado', 10, 0, 'ROSTRO', maybelline, sub.rostro, { state: false });

    // ── Pedidos con fechas exactas en la frontera de los días de Guatemala ──
    let orderSerial = 0;
    const line = (product, quantity) => ({
        _id: new mongoose.Types.ObjectId(), product: product._id, title: product.title, brandName: 'x', slug: product.slug,
        unitPrice: product.price, quantity, subtotal: Math.round(product.price * quantity * 100) / 100, shippingStatus: 'ORDER_PLACED',
        shippingStatusHistory: [],
    });
    const insertOrder = ({ at, buyer, payment, state, lines, shipping = 25, extra = {} }) => {
        orderSerial += 1;
        const items = lines.map(([product, quantity]) => line(product, quantity));
        const subtotal = Math.round(items.reduce((sum, item) => sum + item.subtotal * 100, 0)) / 100;
        return {
            _id: new mongoose.Types.ObjectId(),
            orderCode: `LUM-TEST-${String(orderSerial).padStart(6, '0')}`,
            buyerUser: buyer._id,
            items,
            shippingAddress: { department: 'Guatemala', municipality: 'Mixco', full_address: 'Calle 1', phoneNumber: '55550000' },
            subtotal, shippingCost: shipping, total: Math.round((subtotal + shipping) * 100) / 100,
            paymentMethod: 'TRANSFERENCIA', paymentState: payment, orderState: state,
            createdAt: new Date(at), updatedAt: new Date(at), ...extra,
        };
    };
    await Order.collection.insertMany([
        // Fuera de octubre: el último milisegundo de septiembre y el primero de noviembre (hora de Guatemala).
        insertOrder({ at: '2026-10-01T05:59:59.999Z', buyer: alice, payment: 'PAGO_REALIZADO', state: 'COMPLETADO', lines: [[foundation, 1]] }),
        insertOrder({ at: '2026-11-01T06:00:00.000Z', buyer: alice, payment: 'PAGO_REALIZADO', state: 'ENVIADO', lines: [[foundation, 1]] }),
        // Dentro de octubre, primer y último instante.
        insertOrder({ at: '2026-10-01T06:00:00.000Z', buyer: alice, payment: 'PAGO_REALIZADO', state: 'COMPLETADO', lines: [[foundation, 2], [lipstick, 1]] }),
        insertOrder({ at: '2026-11-01T05:59:59.999Z', buyer: alice, payment: 'PAGO_REALIZADO', state: 'EN_PROCESO', lines: [[lipstick, 3]] }),
        // Dentro de octubre: no cobrados.
        insertOrder({ at: '2026-10-15T18:00:00.000Z', buyer: bob, payment: 'EN_ESPERA_DE_PAGO', state: 'PENDIENTE', lines: [[blush, 1]] }),
        insertOrder({ at: '2026-10-20T18:00:00.000Z', buyer: bob, payment: 'CANCELADO', state: 'CANCELADO', lines: [[foundation, 1]] }),
        insertOrder({ at: '2026-10-25T18:00:00.000Z', buyer: alice, payment: 'REEMBOLSADO', state: 'REEMBOLSADO', lines: [[perfume, 1]] }),
        // Dentro de octubre: cobrados de otra clienta.
        insertOrder({ at: '2026-10-10T18:00:00.000Z', buyer: carol, payment: 'PAGO_REALIZADO', state: 'PARCIALMENTE_ENVIADO', lines: [[perfume, 2], [blush, 1]] }),
        insertOrder({ at: '2026-10-11T18:00:00.000Z', buyer: carol, payment: 'PAGO_REALIZADO', state: 'COMPLETADO', lines: [[foundation, 1]] }),
    ]);

    const OCT = 'startDate=2026-10-01&endDate=2026-10-31';
    const rowsByCode = report => Object.fromEntries(report.rows.map(row => [row.orderCode, row]));

    await t.test('sales report: exact totals, inclusive date boundaries and collected-revenue semantics', async () => {
        const result = await get(`/admin/reports/sales?${OCT}`);
        assert.equal(result.status, 200, JSON.stringify(result.body));
        const { report } = result.body;
        assert.equal(report.title, 'Reporte de ventas');
        // 7 pedidos en octubre: se excluyen el último ms de septiembre y el primero de noviembre.
        assert.equal(result.body.count, 7);
        assert.equal(report.rowCount, 7);
        const kpi = Object.fromEntries(report.kpis.map(item => [item.key, item.value]));
        assert.deepEqual(kpi, {
            orders: 7, collectedOrders: 4, collectedRevenue: 1077.25, averageTicket: 269.31,
            collectedUnits: 10, pendingAmount: 100.25, cancelledOrders: 1, refundedOrders: 1, refundedAmount: 225,
        });
        // Ingreso cobrado = O2 275.50 + O6 176.50 + O8 500.25 + O9 125.00; pendiente/cancelado/reembolsado no cuentan.
        assert.equal(report.totals.collected, 1077.25);
        assert.equal(report.totals.total, 1077.25 + 100.25 + 125 + 225);
        assert.equal(report.totals.subtotal, 1352.5);
        assert.equal(report.totals.shippingCost, 25 * 7);
        assert.equal(report.totals.units, 13); // 10 cobradas + rubor + base + perfume de los no cobrados
        const rows = rowsByCode(report);
        const sum = key => Math.round(report.rows.reduce((acc, row) => acc + row[key] * 100, 0)) / 100;
        assert.equal(sum('collected'), report.totals.collected, 'la columna cobrada suma exactamente el total');
        assert.equal(sum('total'), report.totals.total);
        assert.deepEqual(report.rows.map(row => row.collected > 0), report.rows.map(row => ['Pago confirmado'].includes(row.paymentState) && !['Cancelado', 'Reembolsado'].includes(row.orderState)));
        const byPayment = report.breakdowns.find(item => item.key === 'payment');
        assert.deepEqual(byPayment.rows, [
            { state: 'Pago pendiente', orders: 1, amount: 100.25 },
            { state: 'Pago confirmado', orders: 4, amount: 1077.25 },
            { state: 'Cancelado', orders: 1, amount: 125 },
            { state: 'Reembolsado', orders: 1, amount: 225 },
        ]);
        const byState = report.breakdowns.find(item => item.key === 'order');
        assert.deepEqual(byState.rows.map(row => [row.state, row.orders]), [
            ['Pedido recibido', 1], ['Preparando', 1], ['Enviado parcialmente', 1], ['Entregado', 2], ['Cancelado', 1], ['Reembolsado', 1],
        ]);
        assert.equal(byState.totals.amount, report.totals.total);
        // Orden: del más reciente al más antiguo; nombres reales de las clientas.
        assert.equal(report.rows[0].createdAt, '2026-11-01T05:59:59.999Z');
        assert.equal(report.rows.at(-1).createdAt, '2026-10-01T06:00:00.000Z');
        assert.equal(Object.values(rows).find(row => row.customerEmail === 'carol@example.com').customerName, 'Carolina Díaz');
        assert.equal(JSON.stringify(report).includes('password'), false);
    });

    await t.test('sales report filters: payment state, order state, customer, narrow days and pagination are exact', async () => {
        const paid = (await get(`/admin/reports/sales?${OCT}&paymentState=PAGO_REALIZADO`)).body.report;
        assert.equal(paid.rowCount, 4);
        assert.equal(paid.totals.total, 1077.25);
        const refunded = (await get(`/admin/reports/sales?${OCT}&paymentState=REEMBOLSADO`)).body.report;
        assert.equal(refunded.rowCount, 1);
        assert.equal(refunded.totals.collected, 0, 'un reembolso nunca es ingreso cobrado');
        assert.equal(refunded.kpis.find(item => item.key === 'refundedAmount').value, 225);
        const completed = (await get(`/admin/reports/sales?${OCT}&orderState=COMPLETADO`)).body.report;
        assert.equal(completed.rowCount, 2);
        assert.equal(completed.totals.collected, 275.5 + 125);
        const carolOnly = (await get(`/admin/reports/sales?${OCT}&customer=carol`)).body.report;
        assert.equal(carolOnly.rowCount, 2);
        assert.equal(carolOnly.totals.collected, 625.25);
        assert.equal((await get(`/admin/reports/sales?${OCT}&customer=nadie-existe`)).body.report.rowCount, 0);

        // Un solo día: el 1 de octubre en Guatemala solo contiene el pedido de 00:00:00.000.
        const firstDay = (await get('/admin/reports/sales?startDate=2026-10-01&endDate=2026-10-01')).body.report;
        assert.equal(firstDay.rowCount, 1);
        assert.equal(firstDay.totals.collected, 275.5);
        const sept30 = (await get('/admin/reports/sales?startDate=2026-09-30&endDate=2026-09-30')).body.report;
        assert.equal(sept30.rowCount, 1);
        assert.equal(sept30.totals.collected, 125);
        const nov1 = (await get('/admin/reports/sales?startDate=2026-11-01&endDate=2026-11-01')).body.report;
        assert.equal(nov1.rowCount, 1);
        assert.equal(nov1.totals.collected, 125);

        // Paginación de la pantalla: el resumen y los totales siguen siendo los de TODO el filtro.
        const page = (await get(`/admin/reports/sales?${OCT}&limit=3&offset=3`)).body;
        assert.equal(page.report.rows.length, 3);
        assert.equal(page.count, 7);
        assert.equal(page.pages, 3);
        assert.equal(page.report.totals.collected, 1077.25);
        const everything = (await get(`/admin/reports/sales?${OCT}&limit=100`)).body.report.rows.map(row => row.orderCode);
        assert.deepEqual(page.report.rows.map(row => row.orderCode), everything.slice(3, 6));
    });

    await t.test('product report: units and sales from valid orders only, exact quantities, filters and ordering', async () => {
        const { report } = (await get(`/admin/reports/products?${OCT}&limit=100`)).body;
        assert.deepEqual(report.rows.map(row => [row.title, row.units, row.orders, row.revenue, row.stock]), [
            ['Labial Rojo Intenso', 4, 2, 202, 3],
            ['Base Fit Matte', 3, 2, 300, 10],
            ['Perfume Floral', 2, 1, 400, 20],
            ['Rubor Rosa Suave', 1, 1, 75.25, 0],
        ]);
        assert.deepEqual(report.totals, { units: 10, revenue: 977.25 });
        const kpi = Object.fromEntries(report.kpis.map(item => [item.key, item.value]));
        assert.deepEqual(kpi, { units: 10, revenue: 977.25, products: 4, orders: 4 });
        // Venta de productos = ingresos cobrados menos el envío (4 pedidos x Q25).
        assert.equal(report.totals.revenue, 1077.25 - 100);
        assert.equal(report.rows.find(row => row.title === 'Perfume Floral').averagePrice, 200);
        assert.equal(report.rows.find(row => row.title === 'Base Fit Matte').share, 0.307); // 300 / 977.25
        // Reembolsado, cancelado y pendiente no aparecen.
        assert.equal(report.rows.some(row => row.title === 'Perfume Floral' && row.units === 3), false);

        const least = (await get(`/admin/reports/products?${OCT}&order=least`)).body.report;
        assert.deepEqual(least.rows.map(row => row.units), [1, 2, 3, 4]);
        const labios = (await get(`/admin/reports/products?${OCT}&category=LABIOS`)).body.report;
        assert.deepEqual(labios.rows.map(row => row.title), ['Labial Rojo Intenso']);
        assert.deepEqual(labios.totals, { units: 4, revenue: 202 });
        const byBrand = (await get(`/admin/reports/products?${OCT}&brand=${maybelline.id}`)).body.report;
        assert.deepEqual(byBrand.rows.map(row => row.title).sort(), ['Base Fit Matte', 'Rubor Rosa Suave']);
        assert.equal(byBrand.totals.revenue, 375.25);
        assert.equal((await get(`/admin/reports/products?${OCT}&search=perfume`)).body.report.rows.length, 1);
        const delivered = (await get(`/admin/reports/products?${OCT}&orderState=COMPLETADO`)).body.report;
        assert.deepEqual(delivered.totals, { units: 4, revenue: 200 + 50.5 + 100 });
        // Desglose por categoría y marca consistente con el total.
        const category = report.breakdowns.find(item => item.key === 'category');
        assert.deepEqual(category.rows.map(row => [row.name, row.units, row.revenue]), [
            ['Perfumes', 2, 400], ['Rostro', 4, 375.25], ['Labios', 4, 202],
        ]);
        assert.equal(Math.round(category.rows.reduce((acc, row) => acc + row.revenue * 100, 0)) / 100, report.totals.revenue);
        const brands = report.breakdowns.find(item => item.key === 'brand');
        assert.deepEqual(brands.rows.map(row => [row.name, row.revenue]), [["L'Oréal", 602], ['Maybelline', 375.25]]);
        // Paginación de pantalla sin alterar totales.
        const page = (await get(`/admin/reports/products?${OCT}&limit=2&offset=2`)).body;
        assert.equal(page.report.rows.length, 2);
        assert.equal(page.count, 4);
        assert.deepEqual(page.report.totals, { units: 10, revenue: 977.25 });
    });

    await t.test('inventory report reads live stock (not Redis), classifies status and filters exactly', async () => {
        // Se calienta la caché de Redis con el stock antiguo y se cambia la base de datos por debajo.
        await get(`/products/${lipstick.id}`, null);
        await Product.updateOne({ _id: lipstick._id }, { stock: 2 });
        assert.equal((await get('/admin/reports/inventory')).body.report.rows.find(row => row.title === 'Labial Rojo Intenso').stock, 2);
        await Product.updateOne({ _id: lipstick._id }, { stock: 3 });

        const all = (await get('/admin/reports/inventory?limit=100')).body.report;
        assert.deepEqual(all.rows.map(row => [row.title, row.stock, row.status]), [
            ['Rubor Rosa Suave', 0, 'Agotado'],
            ['Labial Rojo Intenso', 3, 'Stock bajo'],
            ['Base Fit Matte', 10, 'Disponible'],
            ['Perfume Floral', 20, 'Disponible'],
        ]);
        assert.equal(all.rows.some(row => row.title === 'Producto retirado'), false, 'los productos inactivos no son inventario');
        assert.deepEqual(Object.fromEntries(all.kpis.map(item => [item.key, item.value])), { products: 4, units: 33, ok: 2, low: 1, out: 1 });
        assert.deepEqual(all.totals, { stock: 33 });
        assert.equal(all.period, null);
        assert.match(all.fileBase, /^inventario-\d{4}-\d{2}-\d{2}$/);
        // Sin costos en el modelo no se inventa valoración del inventario: ni columnas ni indicadores de "valor".
        assert.equal([...all.columns, ...all.kpis.map(kpi => ({ header: kpi.label }))].some(item => /valor|costo/i.test(item.header)), false);

        assert.deepEqual((await get('/admin/reports/inventory?stockStatus=out')).body.report.rows.map(row => row.title), ['Rubor Rosa Suave']);
        assert.deepEqual((await get('/admin/reports/inventory?stockStatus=low')).body.report.rows.map(row => row.title), ['Labial Rojo Intenso']);
        assert.equal((await get('/admin/reports/inventory?stockStatus=ok')).body.report.rowCount, 2);
        // Umbral configurable: con 10, la base (10 unidades) pasa a stock bajo.
        const wide = (await get('/admin/reports/inventory?lowStockThreshold=10')).body.report;
        assert.equal(wide.kpis.find(item => item.key === 'low').value, 2);
        assert.deepEqual((await get(`/admin/reports/inventory?category=ROSTRO`)).body.report.rows.map(row => row.title), ['Rubor Rosa Suave', 'Base Fit Matte']);
        assert.equal((await get(`/admin/reports/inventory?brand=${loreal.id}`)).body.report.rowCount, 2);
        assert.equal((await get('/admin/reports/inventory?search=perfume')).body.report.rowCount, 1);
        const byCategory = all.breakdowns.find(item => item.key === 'category');
        assert.deepEqual(byCategory.rows.map(row => [row.name, row.products, row.units, row.low, row.out]), [
            ['Labios', 1, 3, 1, 0], ['Perfumes', 1, 20, 0, 0], ['Rostro', 2, 10, 0, 1],
        ]);
        assert.equal((await get('/admin/reports/inventory?limit=2&offset=1')).body.report.rows.length, 2);
    });

    await t.test('customer report: legitimate purchase totals, repeat customers and privacy', async () => {
        const { report } = (await get(`/admin/reports/customers?${OCT}`)).body;
        assert.deepEqual(report.rows.map(row => [row.name, row.orders, row.collectedOrders, row.purchased, row.repeat]), [
            ['Carolina Díaz', 2, 2, 625.25, 'Sí'],
            ['Alicia Pérez', 3, 2, 452, 'Sí'],
            ['Roberto Gómez', 2, 0, 0, 'No'],
        ]);
        assert.deepEqual(report.totals, { orders: 7, collectedOrders: 4, purchased: 1077.25 });
        assert.deepEqual(Object.fromEntries(report.kpis.map(item => [item.key, item.value])), {
            customers: 3, repeatCustomers: 2, orders: 7, collectedOrders: 4, purchased: 1077.25,
        });
        // El total comprado de clientes coincide exactamente con los ingresos cobrados del reporte de ventas.
        assert.equal(report.totals.purchased, (await get(`/admin/reports/sales?${OCT}`)).body.report.totals.collected);
        assert.equal(report.rows.find(row => row.name === 'Alicia Pérez').averageTicket, 226);
        assert.equal((await get(`/admin/reports/customers?${OCT}&repeatOnly=true`)).body.report.rowCount, 2);
        assert.equal((await get(`/admin/reports/customers?${OCT}&customer=rober`)).body.report.rowCount, 1);
        const serialized = JSON.stringify(report);
        for (const secret of ['password', 'phoneNumber', 'full_address', 'token']) assert.equal(serialized.includes(secret), false, secret);
        assert.equal((await get('/admin/reports/customers?startDate=2025-01-01&endDate=2025-01-31')).body.report.rowCount, 0);
    });

    await t.test('dashboard KPIs use Guatemala day boundaries and the documented definitions', async () => {
        const { buildDashboard } = require('../helpers/reports/dashboard');
        // 24 oct 2026 23:30 en Guatemala (ya es 25 en UTC): "hoy" sigue siendo el 24.
        const now = new Date('2026-10-25T05:30:00.000Z');
        const dashboardOrders = [
            insertOrder({ at: '2026-10-24T05:59:00.000Z', buyer: alice, payment: 'PAGO_REALIZADO', state: 'ENVIADO', lines: [[foundation, 1]] }), // 23:59 del 23 oct
            insertOrder({ at: '2026-10-24T06:00:00.000Z', buyer: alice, payment: 'PAGO_REALIZADO', state: 'PENDIENTE', lines: [[lipstick, 2]] }), // 00:00 del 24
            insertOrder({ at: '2026-10-25T05:00:00.000Z', buyer: bob, payment: 'EN_ESPERA_DE_PAGO', state: 'PENDIENTE', lines: [[blush, 1]], extra: { paymentReceipt: { key: 'receipts/a.webp', uploadedAt: new Date() } } }), // 23:00 del 24
            insertOrder({ at: '2026-10-25T06:00:00.000Z', buyer: bob, payment: 'PAGO_REALIZADO', state: 'COMPLETADO', lines: [[foundation, 1]], extra: { completedAt: new Date('2026-10-25T06:30:00.000Z') } }), // ya es 25 local
        ];
        await Order.collection.insertMany(dashboardOrders);
        const today = await buildDashboard({ period: 'today' }, now);
        assert.equal(today.period.startDate, '2026-10-24');
        assert.deepEqual(today.sales, {
            orders: 2, collectedOrders: 1, revenue: 126, averageTicket: 126, units: 2, completedOrders: 0,
        });
        assert.equal(today.current.awaitingVerification, 1);
        const week = await buildDashboard({ period: 'week' }, now);
        assert.equal(week.period.startDate, '2026-10-19');
        const month = await buildDashboard({ period: 'month' }, now);
        // Octubre completo hasta el 24: lo cobrado de octubre (4 pedidos, 1077.25) + 23 oct 125 + 24 oct 126.
        assert.equal(month.sales.revenue, 1077.25 - 176.5 + 125 + 126, 'el último pedido de octubre del 31 queda fuera del "mes hasta hoy"');
        assert.equal(month.period.endDate, '2026-10-24');
        // Ventas válidas del 1 al 24 de octubre: Base 4 uds (O2 2 + O9 1 + 23 oct 1), Labial 3, Perfume 2, Rubor 1.
        assert.deepEqual(month.topProducts.map(item => [item.title, item.units, item.revenue]), [
            ['Base Fit Matte', 4, 400], ['Labial Rojo Intenso', 3, 151.5], ['Perfume Floral', 2, 400], ['Rubor Rosa Suave', 1, 75.25],
        ]);
        assert.equal(month.topProducts[0].id, String(foundation._id));
        assert.deepEqual({ low: month.current.lowStock, out: month.current.outOfStock }, { low: 1, out: 1 });
        assert.deepEqual(month.lowestStock.map(item => item.title), ['Rubor Rosa Suave', 'Labial Rojo Intenso']);
        assert.equal(month.current.customers, 3);
        // Foto actual: pagos pendientes, por preparar, preparando y enviados.
        assert.deepEqual(
            { pendingPayment: month.current.pendingPayment, toPrepare: month.current.toPrepare, shipped: month.current.shipped },
            { pendingPayment: 2, toPrepare: 1, shipped: 3 },
        );
        const completedToday = await buildDashboard({ period: 'custom', startDate: '2026-10-25', endDate: '2026-10-25' }, now);
        assert.equal(completedToday.sales.completedOrders, 1);
        await Order.deleteMany({ _id: { $in: dashboardOrders.map(order => order._id) } }); // no contaminar los reportes de octubre
        const http = await get('/admin/dashboard?period=custom&startDate=2026-10-01&endDate=2026-10-31');
        assert.equal(http.status, 200);
        assert.equal(http.body.sales.revenue, 1077.25);
        assert.equal(http.body.timezone, 'America/Guatemala');
        for (const url of ['/admin/dashboard?period=siempre', '/admin/dashboard?period=custom', '/admin/dashboard?period=custom&startDate=2026-10-05&endDate=2026-10-01', '/admin/dashboard?lowStockThreshold=0']) {
            const bad = await get(url);
            assert.equal(bad.status, 400, url);
        }
    });

    await t.test('PDF export: valid file, correct scope, title, filters and totals', { skip: hasPdfTools ? false : 'pdftotext no está instalado' }, async () => {
        const result = await get(`/admin/reports/sales/export?format=pdf&${OCT}&paymentState=PAGO_REALIZADO`);
        assert.equal(result.status, 200);
        assert.equal(result.headers.get('content-type'), 'application/pdf');
        assert.equal(result.headers.get('content-disposition'), `attachment; filename="reporte-ventas-2026-10-01-a-2026-10-31.pdf"; filename*=UTF-8''reporte-ventas-2026-10-01-a-2026-10-31.pdf`);
        assert.equal(result.headers.get('cache-control'), 'no-store');
        assert.equal(Number(result.headers.get('content-length')), result.body.length);
        assert.equal(result.body.subarray(0, 5).toString(), '%PDF-');
        assert.ok(result.body.length > 2000);
        const text = await pdfText(result.body, directory, 'sales');
        assert.match(text, /LUMINA BEAUTY/);
        assert.match(text, /Reporte de ventas/);
        assert.match(text, /Generado el \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);
        assert.match(text, /Período: +01\/10\/2026 al 31\/10\/2026/);
        assert.match(text, /Estado de pago: +Pago confirmado/);
        assert.match(text, /Ingresos cobrados/);
        assert.match(text, /Q1,077\.25/);
        assert.match(text, /Totales/);
        assert.match(text, /Página 1 de 1/);
        // Alcance: solo los 4 pedidos pagados, nunca los pendientes, cancelados o reembolsados.
        assert.equal((text.match(/LUM-TEST-/g) ?? []).length, 4);
        assert.doesNotMatch(text, /Roberto Gómez/);
        assert.match(text, /Carolina Díaz/);
        assert.match(text, /Alicia Pérez/);

        const products = await get(`/admin/reports/products/export?format=pdf&${OCT}&category=LABIOS`);
        const productText = await pdfText(products.body, directory, 'products');
        assert.match(productText, /Reporte de productos/);
        assert.match(productText, /Labial Rojo Intenso/);
        assert.doesNotMatch(productText, /Base Fit Matte/);
        assert.match(productText, /Categoría: +Labios/);
        assert.match(productText, /Q202\.00/);
        assert.equal(products.headers.get('content-disposition').includes('reporte-productos-2026-10-01-a-2026-10-31.pdf'), true);

        const inventory = await get('/admin/reports/inventory/export?format=pdf&stockStatus=low');
        const inventoryText = await pdfText(inventory.body, directory, 'inventory');
        assert.match(inventoryText, /Reporte de inventario/);
        assert.match(inventoryText, /Labial Rojo Intenso/);
        assert.doesNotMatch(inventoryText, /Perfume Floral/);
        assert.match(inventory.headers.get('content-disposition'), /filename="inventario-\d{4}-\d{2}-\d{2}\.pdf"/);

        const customers = await get(`/admin/reports/customers/export?format=pdf&${OCT}`);
        const customersText = await pdfText(customers.body, directory, 'customers');
        assert.match(customersText, /Reporte de clientes/);
        assert.match(customersText, /Q625\.25/);
        assert.match(customersText, /Q1,077\.25/);

        // Acentos y apóstrofes del catálogo ("L'Oréal") se imprimen bien.
        assert.match(await pdfText((await get('/admin/reports/inventory/export?format=pdf')).body, directory, 'inventory-all'), /L'Oréal/);
    });

    await t.test('Excel export: real workbook, typed numeric/date cells, currency formats, totals, filters', async () => {
        const result = await get(`/admin/reports/sales/export?format=xlsx&${OCT}`);
        assert.equal(result.status, 200);
        assert.equal(result.headers.get('content-type'), XLSX_TYPE);
        assert.match(result.headers.get('content-disposition'), /filename="reporte-ventas-2026-10-01-a-2026-10-31\.xlsx"/);
        assert.equal(result.body.subarray(0, 2).toString(), 'PK');
        const workbook = await readWorkbook(result.body);
        assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['Resumen', 'Detalle', 'Por estado de pago', 'Por estado del pedido']);

        const summary = workbook.getWorksheet('Resumen');
        assert.equal(summary.getCell('A1').value, 'Reporte de ventas');
        const summaryValues = new Map();
        summary.eachRow(row => summaryValues.set(row.getCell(1).value, row.getCell(2)));
        assert.equal(summaryValues.get('Período').value, '01/10/2026 al 31/10/2026');
        assert.equal(summaryValues.get('Ingresos cobrados').value, 1077.25);
        assert.equal(summaryValues.get('Ingresos cobrados').numFmt, '"Q"#,##0.00');
        assert.equal(typeof summaryValues.get('Pedidos del período').value, 'number');
        assert.equal(summaryValues.get('Pedidos del período').numFmt, '#,##0');

        const detail = workbook.getWorksheet('Detalle');
        const headers = detail.getRow(5).values.slice(1);
        assert.deepEqual(headers, ['Pedido', 'Fecha', 'Cliente', 'Correo', 'Pago', 'Estado del pedido', 'Unidades', 'Productos', 'Envío', 'Total', 'Ingreso cobrado']);
        assert.equal(detail.rowCount, 5 + 7 + 1); // título (3) + encabezado + 7 pedidos + totales
        assert.equal(detail.autoFilter, 'A5:K5');
        assert.equal(detail.views[0].state, 'frozen');
        assert.equal(detail.views[0].ySplit, 5);

        const first = detail.getRow(6); // el más reciente: 31 oct 23:59:59.999 (Guatemala)
        assert.equal(first.getCell(1).value, 'LUM-TEST-000004');
        assert.ok(first.getCell(2).value instanceof Date, 'la fecha es una fecha real');
        assert.equal(first.getCell(2).numFmt, 'dd/mm/yyyy hh:mm');
        // La celda muestra la hora de pared de Guatemala: 31/10/2026 23:59.
        assert.equal(first.getCell(2).value.toISOString().slice(0, 16), '2026-10-31T23:59');
        for (const column of [7]) assert.equal(typeof first.getCell(column).value, 'number');
        for (const column of [8, 9, 10, 11]) {
            assert.equal(typeof first.getCell(column).value, 'number', `columna ${column} numérica`);
            assert.equal(first.getCell(column).numFmt, '"Q"#,##0.00');
        }
        assert.equal(first.getCell(10).value, 176.5);
        assert.equal(first.getCell(7).numFmt, '#,##0');
        // Ningún importe quedó como texto "Q 1,200.00".
        detail.eachRow({ includeEmpty: false }, (row, number) => {
            if (number < 6 || number > 12) return;
            for (let column = 7; column <= 11; column += 1) assert.equal(typeof row.getCell(column).value, 'number');
        });

        const totals = detail.getRow(13);
        assert.equal(totals.getCell(1).value, 'Totales');
        assert.deepEqual(totals.getCell(11).value, { formula: 'SUBTOTAL(109,K6:K12)', result: 1077.25 });
        assert.deepEqual(totals.getCell(10).value, { formula: 'SUBTOTAL(109,J6:J12)', result: 1527.5 });
        assert.equal(totals.getCell(7).value.result, 13); // unidades de todos los pedidos listados (cobrados o no)
        const columnSum = column => Math.round(Array.from({ length: 7 }, (_, index) => detail.getRow(6 + index).getCell(column).value).reduce((acc, value) => acc + value * 100, 0)) / 100;
        assert.equal(columnSum(11), totals.getCell(11).value.result, 'el total del libro coincide con la suma de sus filas');
        assert.equal(columnSum(10), totals.getCell(10).value.result);

        const breakdown = workbook.getWorksheet('Por estado de pago');
        assert.deepEqual(breakdown.getRow(5).values.slice(1), ['Estado', 'Pedidos', 'Monto']);
        assert.equal(breakdown.getRow(7).getCell(3).value, 1077.25);

        // Alcance: filtros de pago respetados en el libro.
        const paidBook = await readWorkbook((await get(`/admin/reports/sales/export?format=xlsx&${OCT}&paymentState=PAGO_REALIZADO`)).body);
        assert.equal(paidBook.getWorksheet('Detalle').rowCount, 5 + 4 + 1);
        assert.equal(paidBook.getWorksheet('Resumen').getCell('B6').value, '01/10/2026 al 31/10/2026');

        const products = await readWorkbook((await get(`/admin/reports/products/export?format=xlsx&${OCT}`)).body);
        assert.deepEqual(products.worksheets.map(sheet => sheet.name), ['Resumen', 'Detalle', 'Por categoría', 'Por marca']);
        const productSheet = products.getWorksheet('Detalle');
        assert.equal(productSheet.getRow(6).getCell(1).value, 'Labial Rojo Intenso');
        assert.equal(productSheet.getRow(6).getCell(4).value, 4);
        assert.equal(productSheet.getRow(6).getCell(6).value, 202);
        assert.equal(productSheet.getRow(6).getCell(8).numFmt, '0.0%');
        assert.equal(typeof productSheet.getRow(6).getCell(8).value, 'number');
        assert.deepEqual(productSheet.getRow(10).getCell(6).value, { formula: 'SUBTOTAL(109,F6:F9)', result: 977.25 });

        const inventory = await readWorkbook((await get('/admin/reports/inventory/export?format=xlsx')).body);
        assert.deepEqual(inventory.worksheets.map(sheet => sheet.name), ['Resumen', 'Detalle', 'Por categoría', 'Por marca']);
        assert.equal(inventory.getWorksheet('Detalle').getRow(6).getCell(5).numFmt, '"Q"#,##0.00');
        assert.equal(inventory.getWorksheet('Detalle').getRow(6).getCell(6).value, 0);
        assert.equal(inventory.getWorksheet('Detalle').getRow(6).getCell(7).value, 'Agotado');

        const customers = await readWorkbook((await get(`/admin/reports/customers/export?format=xlsx&${OCT}`)).body);
        assert.deepEqual(customers.worksheets.map(sheet => sheet.name), ['Resumen', 'Detalle']);
        const customerSheet = customers.getWorksheet('Detalle');
        assert.equal(customerSheet.getRow(6).getCell(5).value, 625.25);
        assert.ok(customerSheet.getRow(6).getCell(7).value instanceof Date);
    });

    await t.test('exports and screen share one scope: totals are identical in screen, PDF and Excel', { skip: hasPdfTools ? false : 'pdftotext no está instalado' }, async () => {
        const query = `${OCT}&paymentState=PAGO_REALIZADO&orderState=COMPLETADO`;
        const screen = (await get(`/admin/reports/sales?${query}&limit=1`)).body.report; // pantalla con UNA fila por página
        const book = await readWorkbook((await get(`/admin/reports/sales/export?format=xlsx&${query}`)).body);
        const text = await pdfText((await get(`/admin/reports/sales/export?format=pdf&${query}`)).body, directory, 'consistency');
        const sheet = book.getWorksheet('Detalle');
        // La pantalla muestra 1 fila, pero el total y las exportaciones cubren las 2 filas del filtro.
        assert.equal(screen.rows.length, 1);
        assert.equal(screen.rowCount, 2);
        assert.equal(screen.totals.collected, 400.5);
        assert.equal(sheet.rowCount, 5 + 2 + 1);
        assert.equal(sheet.getRow(8).getCell(11).value.result, screen.totals.collected);
        assert.equal(sheet.getRow(8).getCell(10).value.result, screen.totals.total);
        assert.equal((text.match(/LUM-TEST-/g) ?? []).length, 2);
        assert.match(text, /Q400\.50/);
        assert.match(text, /Estado del pedido: +Entregado/);
    });

    await t.test('empty reports export valid files that say no records were found', async () => {
        const empty = 'startDate=2020-01-01&endDate=2020-01-31';
        const screen = (await get(`/admin/reports/sales?${empty}`)).body.report;
        assert.equal(screen.rowCount, 0);
        assert.equal(screen.totals.collected, 0);
        const book = await readWorkbook((await get(`/admin/reports/sales/export?format=xlsx&${empty}`)).body);
        assert.match(book.getWorksheet('Detalle').getRow(6).getCell(1).value, /No se encontraron registros/);
        const pdf = await get(`/admin/reports/sales/export?format=pdf&${empty}`);
        assert.equal(pdf.status, 200);
        assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
        if (hasPdfTools) assert.match(await pdfText(pdf.body, directory, 'empty'), /No se encontraron registros/);
    });

    await t.test('large reports: all filtered rows are exported across several PDF pages and Excel rows', { timeout: 120000 }, async () => {
        const buyers = await User.insertMany(Array.from({ length: 8 }, (_, index) => ({
            email: `bulk${index}@example.com`, name: `Cliente Masivo ${String.fromCharCode(65 + index)}`, password: 'testpassword',
        })));
        const long = await makeProduct('Paleta de sombras profesional edición limitada con espejo e iluminador compacto de viaje', 349.99, 50, 'OJOS_Y_CEJAS', maybelline, sub.rostro);
        const bulk = Array.from({ length: 347 }, (_, index) => insertOrder({
            at: new Date(Date.UTC(2026, 11, 1 + (index % 28), 12, index % 60)).toISOString(),
            buyer: buyers[index % buyers.length], payment: 'PAGO_REALIZADO', state: 'COMPLETADO',
            lines: [[index % 2 ? foundation : long, (index % 3) + 1]],
        }));
        await Order.collection.insertMany(bulk);
        const DEC = 'startDate=2026-12-01&endDate=2026-12-31';
        const screen = (await get(`/admin/reports/sales?${DEC}&limit=20`)).body;
        assert.equal(screen.count, 347, 'la pantalla pagina de 20 en 20 pero el filtro tiene 347 filas');
        assert.equal(screen.report.rows.length, 20);

        const book = await readWorkbook((await get(`/admin/reports/sales/export?format=xlsx&${DEC}`)).body);
        const sheet = book.getWorksheet('Detalle');
        assert.equal(sheet.rowCount, 5 + 347 + 1, 'el Excel trae las 347 filas, no solo la página visible');
        assert.equal(sheet.getRow(5 + 347 + 1).getCell(11).value.result, screen.report.totals.collected);
        assert.equal(sheet.getRow(5 + 347 + 1).getCell(11).value.formula, `SUBTOTAL(109,K6:K${5 + 347})`);

        const pdf = await get(`/admin/reports/sales/export?format=pdf&${DEC}`);
        assert.equal(pdf.status, 200);
        const pages = pdfPages(pdf.body);
        assert.ok(pages >= 8, `se esperaban varias páginas, hubo ${pages}`);
        if (hasPdfTools) {
            const text = await pdfText(pdf.body, directory, 'large');
            assert.equal((text.match(/LUM-TEST-/g) ?? []).length, 347, 'el PDF trae todas las filas');
            // Las páginas con filas repiten el encabezado; una página final solo con definiciones no lo necesita.
            const pageTexts = text.split('\f').filter(page => page.trim());
            const withRows = pageTexts.filter(page => /LUM-TEST-/.test(page));
            assert.ok(withRows.length >= pages - 1, 'solo la última página puede no tener filas');
            assert.equal((text.match(/(?:^|\f) *Pedido +Fecha/gm) ?? []).length, withRows.length, 'el encabezado de la tabla se repite en cada página con filas');
            assert.match(text, new RegExp(`Página ${pages} de ${pages}`));
            // Totales juntos con la última fila, y el valor impreso coincide con el de la pantalla.
            const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2 }).format(screen.report.totals.collected);
            const lastPage = withRows.at(-1);
            assert.match(lastPage, new RegExp(`Totales[^\\n]*Q${money.replace('.', '\\.')}`));
            assert.match(lastPage, /LUM-TEST-/, 'la fila de totales nunca queda sola en una página');
            // Nombres de producto largos se parten en líneas en lugar de recortarse.
            const productsPdf = await pdfText((await get(`/admin/reports/products/export?format=pdf&${DEC}`)).body, directory, 'long-names');
            assert.match(productsPdf, /Paleta de sombras/);
            assert.match(productsPdf, /viaje/);
        }
        // Rangos enormes de filas se rechazan con un mensaje claro en lugar de agotar la memoria.
        const { MAX_EXPORT_ROWS } = require('../helpers/reports/data');
        assert.ok(MAX_EXPORT_ROWS >= 347);
    });

    await t.test('report and export endpoints are admin-only and reject bad input safely', async () => {
        const urls = [
            `/admin/reports/sales?${OCT}`, `/admin/reports/sales/export?format=pdf&${OCT}`, `/admin/reports/sales/export?format=xlsx&${OCT}`,
            `/admin/reports/products?${OCT}`, `/admin/reports/products/export?format=pdf&${OCT}`,
            '/admin/reports/inventory', '/admin/reports/inventory/export?format=xlsx',
            `/admin/reports/customers?${OCT}`, `/admin/reports/customers/export?format=pdf&${OCT}`,
            '/admin/dashboard',
        ];
        for (const url of urls) {
            const anonymous = await get(url, null);
            assert.equal(anonymous.status, 401, `sin sesión: ${url}`);
            const customer = await get(url, aliceToken);
            assert.equal(customer.status, 401, `clienta: ${url}`);
            assert.equal(customer.headers.get('content-type').includes('json'), true, 'la clienta no recibe ningún archivo');
            assert.equal((await get(url)).status, 200, `admin: ${url}`);
        }
        // Un token válido de un usuario desactivado tampoco entra.
        await User.updateOne({ _id: admin._id }, { state: false });
        assert.equal((await get('/admin/reports/inventory')).status, 401);
        await User.updateOne({ _id: admin._id }, { state: true });

        const bad = async (url, status, pattern) => {
            const result = await get(url);
            assert.equal(result.status, status, url);
            assert.match(result.body.msg, pattern);
            assert.equal(JSON.stringify(result.body).includes('at '), false, 'no se filtran trazas');
        };
        await bad('/admin/reports/ventas', 400, /El reporte debe ser/);
        await bad('/admin/reports/sales/export?format=csv&startDate=2026-10-01&endDate=2026-10-02', 400, /formato debe ser pdf o xlsx/);
        await bad('/admin/reports/sales/export?startDate=2026-10-01&endDate=2026-10-02', 400, /formato debe ser pdf o xlsx/);
        await bad('/admin/reports/sales/export?format=pdf', 400, /fecha inicial y la fecha final/);
        await bad(`/admin/reports/sales?${OCT}&limit=1000`, 400, /límite/);
        await bad(`/admin/reports/sales?${OCT}&offset=-1`, 400, /offset/);
        await bad(`/admin/reports/products/export?format=pdf&${OCT}&brand=../../etc/passwd`, 400, /marca/);
        // Nada del nombre de archivo viene del cliente.
        const named = await get(`/admin/reports/sales/export?format=pdf&${OCT}&fileName=../../evil&name=x`);
        assert.match(named.headers.get('content-disposition'), /^attachment; filename="reporte-ventas-2026-10-01-a-2026-10-31\.pdf"/);
    });

    await t.test('export failures return a safe JSON error and never leak internals', async () => {
        const original = ExcelJS.Workbook.prototype.addWorksheet;
        ExcelJS.Workbook.prototype.addWorksheet = () => { throw new Error('boom: /secret/path /etc/passwd'); };
        const originalError = console.error;
        console.error = () => {};
        try {
            const failed = await get(`/admin/reports/sales/export?format=xlsx&${OCT}`);
            assert.equal(failed.status, 500);
            assert.deepEqual(failed.body, { ok: false, msg: 'No se pudo exportar el reporte' });
        } finally {
            ExcelJS.Workbook.prototype.addWorksheet = original;
            console.error = originalError;
        }
        assert.equal((await get(`/admin/reports/sales/export?format=xlsx&${OCT}`)).status, 200, 'el servicio sigue funcionando');
    });
});
