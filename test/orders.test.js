const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const mongoose = require('mongoose');
const express = require('express');
const jwt = require('jsonwebtoken');

const {
    deriveOrderState, canTransitionPayment, canTransitionShipping, toCents, fromCents,
} = require('../helpers/order-states');

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
        child.once('error', error => finish(() => reject(new Error(`Install ${command} to run order integration tests: ${error.message}`))));
        child.once('exit', code => finish(() => reject(new Error(`${command} exited (${code}): ${output}`))));
        const read = chunk => {
            output += chunk;
            if (ready.test(output)) finish(resolve);
        };
        child.stdout.on('data', read);
        child.stderr.on('data', read);
    });
};

// Las transacciones exigen un replica set: se levanta uno de un solo nodo, aislado y temporal.
const startReplicaSet = async (directory, cleanup) => {
    const port = await freePort();
    await startService('mongod', [
        '--dbpath', directory, '--port', String(port), '--bind_ip', '127.0.0.1', '--nounixsocket', '--replSet', 'rs0',
    ], /Waiting for connections/, cleanup);
    const bootstrap = await mongoose.createConnection(`mongodb://127.0.0.1:${port}/?directConnection=true`).asPromise();
    await bootstrap.db.admin().command({
        replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: `127.0.0.1:${port}` }] },
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const hello = await bootstrap.db.admin().command({ hello: 1 });
        if (hello.isWritablePrimary) break;
        await sleep(200);
    }
    await bootstrap.close();
    return port;
};

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('order domain rules are pure and exhaustive', () => {
    assert.equal(deriveOrderState([]), 'PENDIENTE');
    assert.equal(deriveOrderState(['ORDER_PLACED', 'ORDER_PLACED']), 'PENDIENTE');
    assert.equal(deriveOrderState(['PROCESSING', 'ORDER_PLACED']), 'EN_PROCESO');
    assert.equal(deriveOrderState(['PROCESSING', 'PROCESSING']), 'EN_PROCESO');
    assert.equal(deriveOrderState(['SHIPPED', 'PROCESSING']), 'PARCIALMENTE_ENVIADO');
    assert.equal(deriveOrderState(['DELIVERED', 'ORDER_PLACED']), 'PARCIALMENTE_ENVIADO');
    assert.equal(deriveOrderState(['SHIPPED', 'SHIPPED']), 'ENVIADO');
    assert.equal(deriveOrderState(['SHIPPED', 'DELIVERED']), 'ENVIADO');
    assert.equal(deriveOrderState(['DELIVERED', 'DELIVERED']), 'COMPLETADO');
    assert.equal(deriveOrderState(['DELIVERED']), 'COMPLETADO');

    assert.equal(canTransitionPayment('EN_ESPERA_DE_PAGO', 'PAGO_REALIZADO'), true);
    assert.equal(canTransitionPayment('EN_ESPERA_DE_PAGO', 'CANCELADO'), true);
    assert.equal(canTransitionPayment('PAGO_REALIZADO', 'REEMBOLSADO'), true);
    for (const [from, to] of [
        ['PAGO_REALIZADO', 'EN_ESPERA_DE_PAGO'], ['PAGO_REALIZADO', 'CANCELADO'], ['EN_ESPERA_DE_PAGO', 'REEMBOLSADO'],
        ['CANCELADO', 'PAGO_REALIZADO'], ['REEMBOLSADO', 'PAGO_REALIZADO'], ['CANCELADO', 'REEMBOLSADO'],
    ]) assert.equal(canTransitionPayment(from, to), false, `${from} -> ${to}`);

    assert.equal(canTransitionShipping('ORDER_PLACED', 'PROCESSING'), true);
    assert.equal(canTransitionShipping('PROCESSING', 'SHIPPED'), true);
    assert.equal(canTransitionShipping('SHIPPED', 'DELIVERED'), true);
    for (const [from, to] of [
        ['ORDER_PLACED', 'SHIPPED'], ['ORDER_PLACED', 'DELIVERED'], ['SHIPPED', 'PROCESSING'],
        ['DELIVERED', 'SHIPPED'], ['PROCESSING', 'PROCESSING'], ['DELIVERED', 'DELIVERED'],
    ]) assert.equal(canTransitionShipping(from, to), false, `${from} -> ${to}`);

    // Dinero en centavos enteros: 0.1 + 0.2 no produce 0.30000000000000004.
    assert.equal(fromCents(toCents(0.1) + toCents(0.2)), 0.3);
    assert.equal(toCents(20.1) * 3, 6030);
    assert.equal(fromCents(toCents(1.005)), 1.01);
});

test('order, payment and shipping lifecycle (isolated replica-set MongoDB and Redis; mocked S3 and mail)', { timeout: 120000 }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmetics-orders-'));
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
    process.env.SECRETEORPRIVATEKEY = 'orders-test-secret';
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_BUCKET_NAME = 'orders-test';
    await mongoose.connect(`mongodb://127.0.0.1:${mongoPort}/orders_test?directConnection=true`);
    const { Product, Brand, Subcategory, User, Address, Order, Server } = require('../models');
    await Promise.all([Product.init(), Brand.init(), Subcategory.init(), User.init(), Address.init(), Order.init()]);
    redis = require('../database/config-redis');
    if (!redis.isReady) await once(redis, 'ready');

    const helpers = require('../helpers');
    const uploaded = [];
    const deleted = [];
    helpers.uploadFile = async (file, folder) => {
        assert.equal(file.name.endsWith('.webp'), true);
        const key = `${folder}/receipt-${uploaded.length}.webp`;
        uploaded.push(key);
        return { key };
    };
    helpers.deleteFile = async key => { deleted.push(key); };
    helpers.getFileUrl = async key => `https://signed.test/${key}`;

    const sent = [];
    require('../config/mailer').transporter.sendMail = async mail => { sent.push(mail); };
    // Los correos salen después de responder; se espera hasta que aparezca el que se busca.
    const mailsMatching = async (pattern, count = 1) => {
        const matching = () => sent.filter(mail => pattern.test(mail.subject));
        for (let attempt = 0; attempt < 100 && matching().length < count; attempt += 1) await sleep(20);
        return matching();
    };

    const app = express();
    app.use(express.json());
    app.use(require('express-fileupload')({ useTempFiles: true, tempFileDir: directory }));
    Server.prototype.routes.call({ app, paths: {
        address: '/api/address', auth: '/api/auth', products: '/api/products', brands: '/api/brands',
        subcategories: '/api/subcategories', productImages: '/api/upload/products', orders: '/api/orders',
    } });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api`;

    const admin = await User.create({ email: 'admin@example.com', name: 'Admin Lumina', password: 'testpassword', role: 'ADMIN_ROLE' });
    const alice = await User.create({ email: 'alice@example.com', name: 'Alicia Pérez', password: 'testpassword' });
    const bob = await User.create({ email: 'bob@example.com', name: 'Roberto Gómez', password: 'testpassword' });
    const token = user => jwt.sign({ uid: user.id }, process.env.SECRETEORPRIVATEKEY);
    const [adminToken, aliceToken, bobToken] = [admin, alice, bob].map(token);

    const request = async (method, url, data, auth = adminToken) => {
        const result = await fetch(`${base}${url}`, {
            method,
            headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
            ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        });
        return { status: result.status, body: await result.json() };
    };
    const upload = async (url, auth, { type = 'image/png', bytes = PNG, field = 'archivo' } = {}) => {
        const form = new FormData();
        form.append(field, new Blob([bytes], { type }), 'comprobante.png');
        const result = await fetch(`${base}${url}`, { method: 'POST', headers: auth ? { Authorization: `Bearer ${auth}` } : {}, body: form });
        return { status: result.status, body: await result.json() };
    };

    const brand = await Brand.create({ name: 'Maybelline', slug: 'maybelline' });
    const subcategory = await Subcategory.create({ name: 'Base', slug: 'base', category: 'ROSTRO' });
    let slugCounter = 0;
    const makeProduct = (overrides = {}) => Product.create({
        title: `Producto de prueba ${slugCounter += 1}`, price: 85.5, description: 'Producto para pruebas de pedidos',
        stock: 10, slug: `producto-${slugCounter}`, category: 'ROSTRO', subcategory: subcategory.id, brand: brand.id,
        images: [{ key: `p${slugCounter}.webp`, url: `https://img.test/p${slugCounter}.webp` }], ...overrides,
    });
    const stockOf = async product => (await Product.findById(product.id)).stock;
    const aliceAddress = (await request('POST', '/address', {
        department: 'Guatemala', municipality: 'Mixco', full_address: 'Calle 1, zona 2, Mixco', phoneNumber: '55550000',
    }, aliceToken));
    const bobAddress = (await request('POST', '/address', {
        department: 'Sacatepéquez', municipality: 'Antigua', full_address: 'Avenida Norte 5', phoneNumber: '44440000',
    }, bobToken));
    const checkout = (items, extra = {}, auth = aliceToken) => request('POST', '/orders', {
        items, shippingAddress: aliceAddress.body.address._id, paymentMethod: 'TRANSFERENCIA', ...extra,
    }, auth);
    const states = async id => {
        const order = await Order.findById(id);
        return { payment: order.paymentState, order: order.orderState, items: order.items.map(item => item.shippingStatus) };
    };
    // Lleva un pedido a "pago confirmado" por la vía normal.
    const paidOrder = async (items, extra) => {
        const created = await checkout(items, extra);
        assert.equal(created.status, 201, JSON.stringify(created.body));
        const id = created.body.order.id;
        const paid = await request('PATCH', `/orders/admin/${id}/payment-state`, { paymentState: 'PAGO_REALIZADO', paymentReference: 'DEP-1' });
        assert.equal(paid.status, 200, JSON.stringify(paid.body));
        return paid.body.order;
    };
    const advance = (orderId, items, status) => request('PATCH', `/orders/admin/${orderId}/shipping-status`, {
        items: items.map(item => ({ itemId: item.id ?? item, shippingStatus: status })),
    });

    await t.test('addresses belong to their owner, the first one is the default and shipping cost is server-side', async () => {
        assert.equal(aliceAddress.status, 201);
        assert.equal(aliceAddress.body.address.is_default, true);
        assert.equal(aliceAddress.body.address.shipping_cost, 0);
        assert.equal((await request('GET', '/address', undefined, null)).status, 401);

        const tampered = await request('POST', '/address', {
            department: 'Guatemala', municipality: 'Villa Nueva', full_address: 'Otra dirección 9', phoneNumber: '55551111',
            shipping_cost: 999, recipient: bob.id, is_default: true, state: false,
        }, aliceToken);
        assert.equal(tampered.status, 201);
        assert.equal(tampered.body.address.shipping_cost, 0);
        assert.equal(tampered.body.address.recipient, alice.id);
        assert.equal(tampered.body.address.state, true);
        assert.equal(tampered.body.address.is_default, true);
        assert.equal((await Address.findById(aliceAddress.body.address._id)).is_default, false);

        for (const data of [{ phoneNumber: '123' }, { department: '' }, { full_address: 'x' }]) {
            assert.equal((await request('POST', '/address', { ...aliceAddress.body.address, _id: undefined, ...data }, aliceToken)).status, 400);
        }
        assert.equal((await request('GET', `/address/${aliceAddress.body.address._id}`, undefined, bobToken)).status, 404);
        assert.equal((await request('PATCH', `/address/${aliceAddress.body.address._id}`, { municipality: 'Hack' }, bobToken)).status, 404);
        assert.equal((await request('PUT', `/address/delete/${aliceAddress.body.address._id}`, {}, bobToken)).status, 404);
        assert.equal((await request('GET', '/address', undefined, bobToken)).body.addresses.length, 1);

        // Eliminar la predeterminada promueve otra dirección y la dirección eliminada deja de listarse.
        assert.equal((await request('PUT', `/address/delete/${tampered.body.address._id}`, {}, aliceToken)).status, 200);
        const remaining = (await request('GET', '/address', undefined, aliceToken)).body.addresses;
        assert.equal(remaining.length, 1);
        assert.equal(remaining[0].is_default, true);
        assert.equal((await request('GET', `/address/${tampered.body.address._id}`, undefined, aliceToken)).status, 404);
    });

    let widget, serum, createdOrder;

    await t.test('checkout validates input and never trusts client prices, totals, states or owner', async () => {
        widget = await makeProduct({ title: 'Base Fit Me', price: 85.5, stock: 10 });
        serum = await makeProduct({ title: 'Sérum Hidratante', price: 20.1, stock: 4 });
        const inactive = await makeProduct({ title: 'Producto retirado', state: false });
        const line = { product: widget.id, quantity: 1 };

        assert.equal((await checkout([line], {}, null)).status, 401);
        for (const items of [[], 'x', [{ product: 'no-id', quantity: 1 }], [{ product: widget.id, quantity: 0 }],
            [{ product: widget.id, quantity: 1.5 }], [{ product: widget.id, quantity: '2' }], [{ product: widget.id, quantity: -1 }],
            [{ product: widget.id, quantity: 100000 }]]) {
            assert.equal((await checkout(items)).status, 400, JSON.stringify(items));
        }
        assert.equal((await checkout([line], { paymentMethod: 'TARJETA' })).status, 400);
        assert.equal((await checkout([line], { shippingAddress: 'bad' })).status, 400);
        assert.equal((await checkout([line], { nit: 'abc def' })).status, 400);
        assert.equal((await checkout([line], { checkoutKey: 'corta' })).status, 400);
        // Dirección de otro cliente, producto inexistente o retirado.
        assert.equal((await checkout([line], { shippingAddress: bobAddress.body.address._id })).status, 400);
        assert.equal((await checkout([{ product: new mongoose.Types.ObjectId().toString(), quantity: 1 }])).status, 400);
        const retired = await checkout([{ product: inactive.id, quantity: 1 }]);
        assert.equal(retired.status, 400);
        assert.match(retired.body.msg, /Producto retirado/);
        assert.equal(await Order.countDocuments(), 0);
        assert.equal(await stockOf(widget), 10);

        const result = await checkout([{ product: widget.id, quantity: 2 }, { product: serum.id, quantity: 3 }], {
            total: 0.01, subtotal: 0.01, shippingCost: 0, paymentState: 'PAGO_REALIZADO', orderState: 'COMPLETADO',
            buyerUser: bob.id, orderCode: 'HACK-1', unitPrice: 1,
        });
        assert.equal(result.status, 201, JSON.stringify(result.body));
        createdOrder = result.body.order;
        assert.match(createdOrder.orderCode, /^LUM-\d{8}-[A-HJ-NP-Z2-9]{6}$/);
        assert.equal(createdOrder.paymentState, 'EN_ESPERA_DE_PAGO');
        assert.equal(createdOrder.orderState, 'PENDIENTE');
        assert.equal(createdOrder.subtotal, 231.3); // 2 x 85.50 + 3 x 20.10, calculado en centavos
        assert.equal(createdOrder.total, 231.3);
        assert.deepEqual(createdOrder.items.map(item => [item.title, item.unitPrice, item.quantity, item.subtotal, item.shippingStatus]), [
            ['Base Fit Me', 85.5, 2, 171, 'ORDER_PLACED'], ['Sérum Hidratante', 20.1, 3, 60.3, 'ORDER_PLACED'],
        ]);
        assert.equal(createdOrder.items[0].brandName, 'Maybelline');
        assert.match(createdOrder.items[0].imageUrl, /^https:\/\/img\.test\//);
        assert.equal(createdOrder.shippingAddress.municipality, 'Mixco');
        assert.equal(createdOrder.nit, 'CF');
        assert.equal(createdOrder.awaitingReceipt, true);
        assert.equal(createdOrder.canCancel, true);
        for (const internal of ['stockRestored', 'checkoutKey', 'buyerUser', 'paymentConfirmedBy', '_id', '__v']) {
            assert.equal(internal in createdOrder, false, internal);
        }
        const stored = await Order.findById(createdOrder.id);
        assert.equal(stored.buyerUser.toString(), alice.id);
        assert.equal(stored.stockRestored, false);

        // Stock de antes -> después de comprar.
        assert.equal(await stockOf(widget), 8);
        assert.equal(await stockOf(serum), 1);
        // La caché de Redis del producto refleja el stock nuevo.
        assert.equal((await request('GET', `/products/${widget.id}`)).body.stock, 8);
        const [mail] = await mailsMatching(/Recibimos tu pedido LUM-/);
        assert.match(mail.subject, /^\[Lumina Beauty\]/);
        assert.equal(mail.to, 'alice@example.com');
        assert.match(mail.html, /Base Fit Me/);
        assert.equal(/prowear/i.test(mail.html + mail.subject + mail.from), false);
    });

    await t.test('insufficient stock rejects the whole order without touching any product', async () => {
        const before = [await stockOf(widget), await stockOf(serum)];
        const result = await checkout([{ product: widget.id, quantity: 1 }, { product: serum.id, quantity: 2 }]);
        assert.equal(result.status, 409);
        assert.match(result.body.msg, /Stock insuficiente para "Sérum Hidratante"\. Disponible: 1/);
        assert.deepEqual([await stockOf(widget), await stockOf(serum)], before);
        assert.equal(await Order.countDocuments(), 1);
    });

    await t.test('the same cart cannot be submitted twice: checkoutKey makes the request idempotent', async () => {
        const product = await makeProduct({ stock: 5 });
        const key = 'checkout-key-0001';
        const [first, second] = await Promise.all([
            checkout([{ product: product.id, quantity: 2 }], { checkoutKey: key }),
            checkout([{ product: product.id, quantity: 2 }], { checkoutKey: key }),
        ]);
        assert.deepEqual([first.status, second.status].sort(), [200, 201]);
        assert.equal(first.body.order.id, second.body.order.id);
        assert.equal(await stockOf(product), 3);
        const replay = await checkout([{ product: product.id, quantity: 2 }], { checkoutKey: key });
        assert.equal(replay.status, 200);
        assert.equal(replay.body.replayed, true);
        assert.equal(await stockOf(product), 3);
        assert.equal(await Order.countDocuments({ checkoutKey: key }), 1);
        // La misma llave en otra cuenta es un pedido distinto.
        assert.equal((await request('POST', '/orders', {
            items: [{ product: product.id, quantity: 1 }], shippingAddress: bobAddress.body.address._id,
            paymentMethod: 'TRANSFERENCIA', checkoutKey: key,
        }, bobToken)).status, 201);
        assert.equal(await stockOf(product), 2);
    });

    await t.test('concurrent customers cannot oversell: exactly the available units are sold', async () => {
        const lastUnit = await makeProduct({ stock: 1 });
        const duel = await Promise.all([
            checkout([{ product: lastUnit.id, quantity: 1 }]),
            request('POST', '/orders', { items: [{ product: lastUnit.id, quantity: 1 }], shippingAddress: bobAddress.body.address._id, paymentMethod: 'TRANSFERENCIA' }, bobToken),
        ]);
        assert.deepEqual(duel.map(result => result.status).sort(), [201, 409]);
        assert.equal(await stockOf(lastUnit), 0);
        assert.equal(await Order.countDocuments({ 'items.product': lastUnit._id }), 1);

        const scarce = await makeProduct({ stock: 3 });
        const rush = await Promise.all(Array.from({ length: 8 }, () => checkout([{ product: scarce.id, quantity: 1 }])));
        assert.equal(rush.filter(result => result.status === 201).length, 3);
        assert.equal(rush.filter(result => result.status === 409).length, 5);
        assert.equal(await stockOf(scarce), 0);
        assert.equal(await Order.countDocuments({ 'items.product': scarce._id }), 3);
    });

    await t.test('customers only see their own orders; admin routes reject customers', async () => {
        const mine = await request('GET', '/orders/mine', undefined, aliceToken);
        assert.equal(mine.status, 200);
        assert.ok(mine.body.count >= 1);
        assert.ok(mine.body.orders.every(order => !('buyerUser' in order)));
        assert.equal(mine.body.orders[0].preview[0].imageUrl.startsWith('https://img.test/'), true);
        const bobs = await request('GET', '/orders/mine', undefined, bobToken);
        assert.equal(bobs.body.orders.every(order => order.id !== createdOrder.id), true);

        assert.equal((await request('GET', `/orders/${createdOrder.id}`, undefined, aliceToken)).status, 200);
        for (const attempt of [
            () => request('GET', `/orders/${createdOrder.id}`, undefined, bobToken),
            () => request('POST', `/orders/${createdOrder.id}/cancel`, {}, bobToken),
            () => upload(`/orders/${createdOrder.id}/payment-receipt`, bobToken),
        ]) assert.equal((await attempt()).status, 404);
        assert.equal((await request('GET', `/orders/${createdOrder.id}`, undefined, null)).status, 401);

        for (const [method, url, data] of [
            ['GET', '/orders/admin'], ['GET', `/orders/admin/${createdOrder.id}`],
            ['PATCH', `/orders/admin/${createdOrder.id}/payment-state`, { paymentState: 'PAGO_REALIZADO', paymentReference: 'X' }],
            ['PATCH', `/orders/admin/${createdOrder.id}/shipping-status`, { items: [{ itemId: createdOrder.items[0].id, shippingStatus: 'PROCESSING' }] }],
        ]) {
            assert.equal((await request(method, url, data, aliceToken)).status, 401, `${method} ${url} as customer`);
            assert.equal((await request(method, url, data, null)).status, 401, `${method} ${url} anonymous`);
        }
        assert.equal((await request('GET', '/orders/mine?filter=nope', undefined, aliceToken)).status, 400);
        assert.equal((await request('GET', '/orders/mine?limit=0', undefined, aliceToken)).status, 400);
        assert.equal((await request('GET', '/orders/invalid', undefined, aliceToken)).status, 400);
    });

    await t.test('payment receipts: validated, private, replaceable while payment is pending', async () => {
        const url = `/orders/${createdOrder.id}/payment-receipt`;
        assert.equal((await upload(url, null)).status, 401);
        assert.equal((await upload(url, aliceToken, { field: 'otro' })).status, 400);
        assert.equal((await upload(url, aliceToken, { type: 'application/pdf', bytes: Buffer.from('%PDF-1.4') })).status, 400);
        assert.equal(uploaded.length, 0);

        const first = await upload(url, aliceToken);
        assert.equal(first.status, 200, JSON.stringify(first.body));
        assert.equal(first.body.order.awaitingReceipt, false);
        assert.match(first.body.order.paymentReceipt.url, /^https:\/\/signed\.test\/uploads\/images\/payment-receipts\/receipt-0\.webp$/);
        const stored = await Order.findById(createdOrder.id);
        assert.equal(stored.paymentReceipt.key, uploaded[0]);

        assert.equal((await upload(url, aliceToken)).status, 200);
        assert.equal((await Order.findById(createdOrder.id)).paymentReceipt.key, uploaded[1]);
        await sleep(30);
        assert.deepEqual(deleted, [uploaded[0]]);
    });

    await t.test('admin list searches by code, customer and state, filters by Guatemala-time dates and paginates', async () => {
        const aliceCodeFragment = createdOrder.orderCode.slice(4, 12).toLowerCase();
        let result = await request('GET', `/orders/admin?orderCode=${aliceCodeFragment}`);
        assert.equal(result.status, 200);
        assert.ok(result.body.orders.some(order => order.id === createdOrder.id));
        assert.equal((await request('GET', '/orders/admin?orderCode=.*')).body.count, 0); // regex escapado
        assert.equal((await request('GET', '/orders/admin?customer=ALICIA')).body.orders.every(order => order.buyer.email === 'alice@example.com'), true);
        assert.equal((await request('GET', '/orders/admin?customer=bob@example')).body.orders.every(order => order.buyer.name === 'Roberto Gómez'), true);
        assert.equal((await request('GET', '/orders/admin?customer=nadie')).body.count, 0);
        assert.equal((await request('GET', '/orders/admin?paymentState=PAGO_REALIZADO')).body.count, 0);
        assert.ok((await request('GET', '/orders/admin?paymentState=EN_ESPERA_DE_PAGO&orderState=PENDIENTE')).body.count > 0);
        for (const url of ['/orders/admin?paymentState=NOPE', '/orders/admin?orderState=NOPE', '/orders/admin?startDate=2026-02-31',
            '/orders/admin?startDate=hoy', '/orders/admin?startDate=2026-05-02&endDate=2026-05-01', '/orders/admin?limit=500']) {
            assert.equal((await request('GET', url)).status, 400, url);
        }

        const total = (await request('GET', '/orders/admin')).body.count;
        const paged = await request('GET', '/orders/admin?limit=2&offset=0');
        assert.equal(paged.body.orders.length, 2);
        assert.equal(paged.body.pages, Math.ceil(total / 2));
        const second = await request('GET', '/orders/admin?limit=2&offset=2');
        assert.equal(second.body.orders.some(order => paged.body.orders.some(first => first.id === order.id)), false);

        // Las fechas se interpretan en hora de Guatemala (UTC-6): 23:30 del 4 de mayo allí es 05:30Z del día 5.
        const edge = await Order.create({
            ...(await Order.findById(createdOrder.id)).toObject({ depopulate: true }),
            _id: new mongoose.Types.ObjectId(), orderCode: 'LUM-20260504-EDGE22', createdAt: new Date('2026-05-05T05:30:00Z'),
        });
        const day = async (startDate, endDate) => (await request('GET', `/orders/admin?orderCode=EDGE22&startDate=${startDate}&endDate=${endDate}`)).body.count;
        assert.equal(await day('2026-05-04', '2026-05-04'), 1);
        assert.equal(await day('2026-05-05', '2026-05-05'), 0);
        assert.equal(await day('2026-05-04', '2026-05-05'), 1);
        assert.equal((await request('GET', '/orders/admin?orderCode=EDGE22&startDate=2026-05-04')).body.count, 1);
        assert.equal((await request('GET', '/orders/admin?orderCode=EDGE22&endDate=2026-05-03')).body.count, 0);
        await Order.deleteOne({ _id: edge._id });

        const detail = await request('GET', `/orders/admin/${createdOrder.id}`);
        assert.equal(detail.body.order.buyer.email, 'alice@example.com');
        assert.equal((await request('GET', `/orders/admin/${new mongoose.Types.ObjectId()}`)).status, 404);
    });

    await t.test('my orders filters follow the order state', async () => {
        const filterIds = async filter => (await request('GET', `/orders/mine?filter=${filter}`, undefined, aliceToken)).body.orders.map(order => order.id);
        assert.ok((await filterIds('in-progress')).includes(createdOrder.id));
        assert.equal((await filterIds('completed')).includes(createdOrder.id), false);
        assert.equal((await filterIds('cancelled')).includes(createdOrder.id), false);
        assert.ok((await filterIds('all')).includes(createdOrder.id));
    });

    await t.test('payment confirmation is validated, single-winner and keeps shipping separate', async () => {
        const orderId = createdOrder.id;
        const url = `/orders/admin/${orderId}/payment-state`;
        // Sin pago confirmado no se puede preparar ni enviar.
        const early = await advance(orderId, [createdOrder.items[0]], 'PROCESSING');
        assert.equal(early.status, 409);
        assert.match(early.body.msg, /Confirma el pago/);

        // Un pedido sin comprobante ni referencia no se confirma.
        const bareProduct = await makeProduct({ stock: 3 });
        const bare = (await checkout([{ product: bareProduct.id, quantity: 1 }])).body.order;
        const noProof = await request('PATCH', `/orders/admin/${bare.id}/payment-state`, { paymentState: 'PAGO_REALIZADO' });
        assert.equal(noProof.status, 400);
        assert.match(noProof.body.msg, /comprobante/);
        assert.equal((await Order.findById(bare.id)).paymentState, 'EN_ESPERA_DE_PAGO');
        assert.equal((await request('PATCH', `/orders/admin/${bare.id}/payment-state`, { paymentState: 'PAGO_REALIZADO', paymentReference: 'DEP-77' })).status, 200);

        assert.equal((await request('PATCH', url, { paymentState: 'INVENTADO' })).status, 400);
        assert.equal((await request('PATCH', url, {})).status, 400);
        // Reembolsar un pedido sin pagar es una transición inválida.
        assert.equal((await request('PATCH', url, { paymentState: 'REEMBOLSADO' })).status, 409);
        assert.equal((await request('PATCH', url, { paymentState: 'EN_ESPERA_DE_PAGO' })).status, 409);

        // Dos administradores confirmando al mismo tiempo: gana uno y el otro recibe 409.
        const race = await Promise.all([1, 2].map(() => request('PATCH', url, { paymentState: 'PAGO_REALIZADO' })));
        assert.deepEqual(race.map(result => result.status).sort(), [200, 409]);
        const paid = await Order.findById(orderId);
        assert.equal(paid.paymentState, 'PAGO_REALIZADO');
        assert.equal(paid.orderState, 'PENDIENTE'); // el pago no cambia el estado de envío
        assert.equal(paid.paymentConfirmedBy.toString(), admin.id);
        assert.ok(paid.paidAt);

        // Una vez pagado ya no se puede volver atrás, cancelar a secas ni confirmar de nuevo.
        for (const paymentState of ['EN_ESPERA_DE_PAGO', 'CANCELADO', 'PAGO_REALIZADO']) {
            assert.equal((await request('PATCH', url, { paymentState })).status, 409, paymentState);
        }
        // El cliente tampoco puede cancelar un pedido ya pagado ni subir otro comprobante.
        const customerCancel = await request('POST', `/orders/${orderId}/cancel`, {}, aliceToken);
        assert.equal(customerCancel.status, 409);
        assert.match(customerCancel.body.msg, /reembolso/);
        assert.equal((await upload(`/orders/${orderId}/payment-receipt`, aliceToken)).status, 409);
        assert.equal((await mailsMatching(/Pago confirmado — pedido LUM-/, 2)).length, 2);
    });

    await t.test('per-item shipping advances one step at a time and derives the order state', async () => {
        const orderId = createdOrder.id;
        const [first, second] = createdOrder.items;
        const patch = (items, auth = adminToken) => request('PATCH', `/orders/admin/${orderId}/shipping-status`, { items }, auth);

        // Saltar pasos, retroceder y repetir se rechazan.
        assert.equal((await advance(orderId, [first], 'SHIPPED')).status, 409);
        assert.equal((await advance(orderId, [first], 'DELIVERED')).status, 409);
        assert.equal((await advance(orderId, [first], 'ORDER_PLACED')).status, 409);
        assert.equal((await patch([{ itemId: first.id, shippingStatus: 'PROCESSING' }, { itemId: first.id, shippingStatus: 'SHIPPED' }])).status, 400);
        assert.equal((await patch([{ itemId: new mongoose.Types.ObjectId().toString(), shippingStatus: 'PROCESSING' }])).status, 404);
        assert.equal((await patch([{ itemId: first.id, shippingStatus: 'EN_CAMINO' }])).status, 400);
        assert.deepEqual((await states(orderId)).items, ['ORDER_PLACED', 'ORDER_PLACED']);

        // Una solicitud inválida a medias no aplica ninguna de sus partes.
        assert.equal((await patch([{ itemId: first.id, shippingStatus: 'PROCESSING' }, { itemId: second.id, shippingStatus: 'SHIPPED' }])).status, 409);
        assert.deepEqual(await states(orderId), { payment: 'PAGO_REALIZADO', order: 'PENDIENTE', items: ['ORDER_PLACED', 'ORDER_PLACED'] });

        let result = await advance(orderId, [first], 'PROCESSING');
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.equal(result.body.order.orderState, 'EN_PROCESO');
        assert.deepEqual(result.body.order.items.map(item => item.shippingStatus), ['PROCESSING', 'ORDER_PLACED']);
        assert.deepEqual(result.body.order.items[0].shippingStatusHistory.map(entry => entry.status), ['ORDER_PLACED', 'PROCESSING']);

        // Dos actualizaciones simultáneas del mismo producto: solo una avanza.
        const race = await Promise.all([1, 2].map(() => advance(orderId, [first], 'SHIPPED')));
        assert.deepEqual(race.map(res => res.status).sort(), [200, 409]);
        assert.equal((await states(orderId)).order, 'PARCIALMENTE_ENVIADO');
        assert.equal((await Order.findById(orderId)).items[0].shippingStatusHistory.filter(entry => entry.status === 'SHIPPED').length, 1);

        assert.equal((await advance(orderId, [second], 'PROCESSING')).body.order.orderState, 'PARCIALMENTE_ENVIADO');
        result = await advance(orderId, [second], 'SHIPPED');
        assert.equal(result.body.order.orderState, 'ENVIADO');
        assert.equal((await mailsMatching(/va en camino/)).length, 1);
        assert.equal((await mailsMatching(/Enviamos parte/)).length, 1);

        // Reembolsar o cancelar con productos enviados exige un proceso de devolución.
        const refund = await request('PATCH', `/orders/admin/${orderId}/payment-state`, { paymentState: 'REEMBOLSADO' });
        assert.equal(refund.status, 409);
        assert.match(refund.body.msg, /devolución/);

        result = await advance(orderId, [first], 'DELIVERED');
        assert.equal(result.body.order.orderState, 'ENVIADO'); // uno entregado y otro enviado: todo salió de la tienda
        result = await advance(orderId, [second], 'DELIVERED');
        assert.equal(result.body.order.orderState, 'COMPLETADO');
        assert.ok(result.body.order.completedAt);
        assert.equal((await advance(orderId, [second], 'DELIVERED')).status, 409);
        assert.equal((await request('PATCH', `/orders/admin/${orderId}/payment-state`, { paymentState: 'REEMBOLSADO' })).status, 409);
        assert.equal((await patch([{ itemId: first.id, shippingStatus: 'PROCESSING' }], aliceToken)).status, 401);
        assert.equal((await mailsMatching(/entregado/)).length, 1);

        // El stock consumido por un pedido completado se queda consumido.
        assert.equal(await stockOf(widget), 8);
        assert.equal(await stockOf(serum), 1);
        assert.equal((await Order.findById(orderId)).stockRestored, false);
        const completed = await request('GET', '/orders/mine?filter=completed', undefined, aliceToken);
        assert.ok(completed.body.orders.some(order => order.id === orderId));
    });

    await t.test('cancelling an unpaid order restores stock exactly once', async () => {
        const product = await makeProduct({ stock: 6 });
        const created = (await checkout([{ product: product.id, quantity: 4 }])).body.order;
        assert.equal(await stockOf(product), 2);

        // Cancelación del cliente y del administrador a la vez: una sola gana.
        const race = await Promise.all([
            request('POST', `/orders/${created.id}/cancel`, { reason: 'Me equivoqué' }, aliceToken),
            request('PATCH', `/orders/admin/${created.id}/payment-state`, { paymentState: 'CANCELADO' }),
            request('POST', `/orders/${created.id}/cancel`, {}, aliceToken),
        ]);
        assert.equal(race.filter(result => result.status === 200).length, 1, JSON.stringify(race.map(result => result.body)));
        assert.equal(race.filter(result => result.status === 409).length, 2);
        assert.equal(await stockOf(product), 6);
        assert.deepEqual(await states(created.id), { payment: 'CANCELADO', order: 'CANCELADO', items: ['ORDER_PLACED'] });
        assert.equal((await request('GET', `/products/${product.id}`)).body.stock, 6); // Redis actualizado

        // Reintentos posteriores no devuelven stock otra vez ni reviven el pedido.
        assert.equal((await request('POST', `/orders/${created.id}/cancel`, {}, aliceToken)).status, 409);
        for (const paymentState of ['CANCELADO', 'PAGO_REALIZADO', 'REEMBOLSADO']) {
            assert.equal((await request('PATCH', `/orders/admin/${created.id}/payment-state`, { paymentState, paymentReference: 'X' })).status, 409, paymentState);
        }
        assert.equal((await advance(created.id, [created.items[0]], 'PROCESSING')).status, 409);
        assert.equal((await upload(`/orders/${created.id}/payment-receipt`, aliceToken)).status, 409);
        assert.equal(await stockOf(product), 6);
        const cancelled = await request('GET', '/orders/mine?filter=cancelled', undefined, aliceToken);
        assert.ok(cancelled.body.orders.some(order => order.id === created.id));
        assert.equal((await mailsMatching(/cancelado/)).length, 1); // un solo correo: solo una cancelación ganó
    });

    await t.test('refunding a paid order that has not shipped restores stock once and stays coherent', async () => {
        const product = await makeProduct({ stock: 5 });
        const order = await paidOrder([{ product: product.id, quantity: 3 }]);
        assert.equal(await stockOf(product), 2);
        assert.equal((await advance(order.id, order.items, 'PROCESSING')).status, 200);

        const refund = await request('PATCH', `/orders/admin/${order.id}/payment-state`, { paymentState: 'REEMBOLSADO', reason: 'Producto dañado' });
        assert.equal(refund.status, 200, JSON.stringify(refund.body));
        assert.equal(refund.body.order.paymentState, 'REEMBOLSADO');
        assert.equal(refund.body.order.orderState, 'REEMBOLSADO');
        assert.equal(refund.body.order.cancellationReason, 'Producto dañado');
        assert.ok(refund.body.order.refundedAt);
        assert.equal(await stockOf(product), 5);

        assert.equal((await request('PATCH', `/orders/admin/${order.id}/payment-state`, { paymentState: 'REEMBOLSADO' })).status, 409);
        assert.equal((await advance(order.id, order.items, 'SHIPPED')).status, 409);
        assert.equal(await stockOf(product), 5);
        assert.equal((await mailsMatching(/reembolsado/)).length, 1);
    });

    await t.test('refund vs shipment and refund vs completion: exactly one authoritative state wins', async () => {
        for (let round = 0; round < 3; round += 1) {
            const product = await makeProduct({ stock: 4 });
            const order = await paidOrder([{ product: product.id, quantity: 2 }]);
            await advance(order.id, order.items, 'PROCESSING');
            const race = await Promise.all([
                request('PATCH', `/orders/admin/${order.id}/payment-state`, { paymentState: 'REEMBOLSADO' }),
                advance(order.id, order.items, 'SHIPPED'),
            ]);
            const final = await states(order.id);
            if (race[0].status === 200) {
                assert.equal(race[1].status, 409);
                assert.deepEqual(final, { payment: 'REEMBOLSADO', order: 'REEMBOLSADO', items: ['PROCESSING'] });
                assert.equal(await stockOf(product), 4);
            } else {
                assert.equal(race[0].status, 409);
                assert.equal(race[1].status, 200);
                assert.deepEqual(final, { payment: 'PAGO_REALIZADO', order: 'ENVIADO', items: ['SHIPPED'] });
                assert.equal(await stockOf(product), 2);
            }
        }
        // Refund vs. completion: delivered products can never be refunded through the ledger.
        const product = await makeProduct({ stock: 4 });
        const order = await paidOrder([{ product: product.id, quantity: 1 }]);
        await advance(order.id, order.items, 'PROCESSING');
        await advance(order.id, order.items, 'SHIPPED');
        const race = await Promise.all([
            request('PATCH', `/orders/admin/${order.id}/payment-state`, { paymentState: 'REEMBOLSADO' }),
            advance(order.id, order.items, 'DELIVERED'),
        ]);
        assert.deepEqual(race.map(result => result.status), [409, 200]);
        assert.deepEqual(await states(order.id), { payment: 'PAGO_REALIZADO', order: 'COMPLETADO', items: ['DELIVERED'] });
        assert.equal(await stockOf(product), 3);
    });

    await t.test('payment confirmation vs customer cancel, and shipping vs admin cancel: one coherent winner', async () => {
        for (let round = 0; round < 4; round += 1) {
            const product = await makeProduct({ stock: 5 });
            const created = (await checkout([{ product: product.id, quantity: 2 }])).body.order;
            const race = await Promise.all([
                request('PATCH', `/orders/admin/${created.id}/payment-state`, { paymentState: 'PAGO_REALIZADO', paymentReference: `DEP-${round}` }),
                request('POST', `/orders/${created.id}/cancel`, { reason: 'Ya no lo quiero' }, aliceToken),
            ]);
            const final = await states(created.id);
            if (race[0].status === 200) {
                // Ganó el pago: el cliente ya no puede cancelar (ahora solo procede el reembolso) y el stock sigue descontado.
                assert.equal(race[1].status, 409);
                assert.deepEqual(final, { payment: 'PAGO_REALIZADO', order: 'PENDIENTE', items: ['ORDER_PLACED'] });
                assert.equal(await stockOf(product), 3);
            } else {
                assert.equal(race[0].status, 409);
                assert.equal(race[1].status, 200);
                assert.deepEqual(final, { payment: 'CANCELADO', order: 'CANCELADO', items: ['ORDER_PLACED'] });
                assert.equal(await stockOf(product), 5);
            }
        }

        // Preparar/enviar un pedido sin pagar mientras el administrador lo cancela: nunca se envía algo cancelado.
        for (let round = 0; round < 3; round += 1) {
            const product = await makeProduct({ stock: 5 });
            const created = (await checkout([{ product: product.id, quantity: 1 }])).body.order;
            const race = await Promise.all([
                advance(created.id, created.items, 'PROCESSING'),
                request('PATCH', `/orders/admin/${created.id}/payment-state`, { paymentState: 'CANCELADO' }),
            ]);
            assert.deepEqual(race.map(result => result.status), [409, 200]);
            assert.deepEqual(await states(created.id), { payment: 'CANCELADO', order: 'CANCELADO', items: ['ORDER_PLACED'] });
            assert.equal(await stockOf(product), 5);
        }
    });

    await t.test('duplicate product lines are merged and stock is deducted once per product', async () => {
        const product = await makeProduct({ stock: 5 });
        const result = await checkout([{ product: product.id, quantity: 2 }, { product: product.id, quantity: 1 }]);
        assert.equal(result.status, 201);
        assert.equal(result.body.order.items.length, 1);
        assert.equal(result.body.order.items[0].quantity, 3);
        assert.equal(await stockOf(product), 2);
        const tooMany = await checkout([{ product: product.id, quantity: 2 }, { product: product.id, quantity: 1 }]);
        assert.equal(tooMany.status, 409);
        assert.equal(await stockOf(product), 2);
    });

    await t.test('shipping cost comes from the stored address and is added to the total', async () => {
        const product = await makeProduct({ price: 10.1, stock: 5 });
        const address = await Address.create({
            department: 'Guatemala', municipality: 'Zona 10', full_address: 'Calle 5-50', phoneNumber: '55556666',
            recipient: alice._id, shipping_cost: 25.5,
        });
        const result = await checkout([{ product: product.id, quantity: 3 }], { shippingAddress: address.id });
        assert.equal(result.status, 201);
        assert.equal(result.body.order.subtotal, 30.3);
        assert.equal(result.body.order.shippingCost, 25.5);
        assert.equal(result.body.order.total, 55.8);
        // Cambiar o eliminar la dirección después no altera el pedido ya hecho.
        await request('PUT', `/address/delete/${address.id}`, {}, aliceToken);
        assert.equal((await request('GET', `/orders/${result.body.order.id}`, undefined, aliceToken)).body.order.shippingAddress.municipality, 'Zona 10');
    });

    await t.test('a failing email never breaks the order operation', async () => {
        const transporter = require('../config/mailer').transporter;
        const original = transporter.sendMail;
        transporter.sendMail = async () => { throw new Error('SMTP caído'); };
        try {
            const product = await makeProduct({ stock: 2 });
            const result = await checkout([{ product: product.id, quantity: 1 }]);
            assert.equal(result.status, 201);
            assert.equal(await stockOf(product), 1);
        } finally {
            transporter.sendMail = original;
        }
    });

    await t.test('orders and addresses migration is repeatable and its rollback keeps customer data', async () => {
        const migration = require('../migrations/20261024101500-orders-and-addresses');
        await migration.up(mongoose.connection.db);
        const count = await Order.countDocuments();
        await migration.down(mongoose.connection.db);
        assert.equal(await Order.countDocuments(), count);
        const names = (await mongoose.connection.db.collection('orders').indexes()).map(index => index.name);
        assert.equal(names.includes('orderCode_1'), false);
        await migration.up(mongoose.connection.db);
        const restored = (await mongoose.connection.db.collection('orders').indexes()).map(index => index.name);
        for (const name of ['orderCode_1', 'buyerUser_1_createdAt_-1', 'buyerUser_1_checkoutKey_1', 'paymentState_1_orderState_1_createdAt_-1']) {
            assert.ok(restored.includes(name), name);
        }
        // El índice único protege el código de pedido a nivel de base de datos.
        const sample = (await Order.findOne()).toObject();
        await assert.rejects(Order.collection.insertOne({ ...sample, _id: new mongoose.Types.ObjectId() }), { code: 11000 });
    });
});
