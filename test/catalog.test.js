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
    const timer = setTimeout(() => reject(new Error(`${command} did not start: ${output}`)), 15000);
    const finish = callback => { clearTimeout(timer); callback(); };
    child.once('error', error => finish(() => reject(new Error(`Install ${command} to run catalog integration tests: ${error.message}`))));
    child.once('exit', code => finish(() => reject(new Error(`${command} exited (${code}): ${output}`))));
    const read = chunk => {
      output += chunk;
      if (ready.test(output)) finish(resolve);
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
  });
};

test('cosmetics catalog integration (isolated MongoDB and Redis; mocked S3 transport)', { timeout: 60000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmetics-catalog-'));
  const cleanup = [];
  let server, redis;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (redis?.isOpen) redis.destroy();
    await mongoose.disconnect();
    for (const stop of cleanup.reverse()) await stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const mongoPort = await freePort();
  const redisPort = await freePort();
  await startService('mongod', ['--dbpath', directory, '--port', String(mongoPort), '--bind_ip', '127.0.0.1', '--nounixsocket'], /Waiting for connections/, cleanup);
  await startService('redis-server', ['--port', String(redisPort), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--dir', directory], /Ready to accept connections/i, cleanup);

  process.env.REDIS_URL = `redis://127.0.0.1:${redisPort}`;
  process.env.SECRETEORPRIVATEKEY = 'catalog-test-secret';
  process.env.AWS_REGION = 'us-east-1';
  process.env.AWS_BUCKET_NAME = 'catalog-test';
  await mongoose.connect(`mongodb://127.0.0.1:${mongoPort}/catalog_test`);
  const { Product, Brand, Subcategory, User, Server } = require('../models');
  await Promise.all([Product.init(), Brand.init(), Subcategory.init(), User.init()]);
  redis = require('../database/config-redis');
  if (!redis.isReady) await once(redis, 'ready');

  const helpers = require('../helpers');
  const deletedImages = [];
  let uploadFolder;
  helpers.uploadFile = async (file, folder) => {
    uploadFolder = folder;
    assert.equal(file.name.endsWith('.webp'), true);
    return { key: `${folder}/test.webp` };
  };
  helpers.deleteFile = async key => deletedImages.push(key);

  // Mount the actual registered routes without connecting to the application's database.
  const app = express();
  app.use(express.json());
  app.use(require('express-fileupload')({ useTempFiles: true, tempFileDir: directory }));
  Server.prototype.routes.call({ app, paths: {
    auth: '/api/auth', products: '/api/products', brands: '/api/brands',
    subcategories: '/api/subcategories', productImages: '/api/upload/products',
  } });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const admin = await User.create({ email: 'admin@example.com', name: 'Admin', password: 'testpassword', role: 'ADMIN_ROLE' });
  const common = await User.create({ email: 'user@example.com', name: 'Usuario', password: 'testpassword' });
  const adminToken = jwt.sign({ uid: admin.id }, process.env.SECRETEORPRIVATEKEY);
  const commonToken = jwt.sign({ uid: common.id }, process.env.SECRETEORPRIVATEKEY);
  const request = async (method, url, data, token = adminToken) => {
    const result = await fetch(`${base}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: result.status, body: await result.json() };
  };
  let brand, baseSubcategory, lipsSubcategory, product;
  const newProduct = () => ({ title: 'Fit Me Matte + Poreless', price: 85, description: 'Base líquida de acabado mate', stock: 15, slug: 'fit-me-matte-poreless', category: 'ROSTRO', subcategory: baseSubcategory.id, brand: brand.id });

  await t.test('all catalog mutations require JWT and admin role', async () => {
    for (const resource of ['brands', 'subcategories', 'products']) {
      for (const method of ['POST', 'PATCH', 'DELETE']) {
        const url = `/${resource}${method === 'POST' ? '' : '/507f1f77bcf86cd799439011'}`;
        assert.equal((await request(method, url, {}, null)).status, 401);
        assert.equal((await request(method, url, {}, commonToken)).status, 401);
      }
    }
  });

  await t.test('dynamic brands and subcategories normalize and reject active duplicates', async () => {
    let result = await request('POST', '/brands', { name: '  Maybelline  ', slug: ' MAYBELLINE ' });
    assert.equal(result.status, 201);
    brand = result.body.brand;
    assert.equal(brand.name, 'Maybelline');
    assert.equal(brand.slug, 'maybelline');
    assert.equal((await request('POST', '/brands', { name: 'MAYBELLINE', slug: 'other' })).status, 409);
    assert.equal((await request('POST', '/brands', { name: 'Other', slug: 'MAYBELLINE' })).status, 409);
    result = await request('POST', '/subcategories', { name: 'Base', slug: 'BASE', category: 'ROSTRO' });
    assert.equal(result.status, 201);
    baseSubcategory = result.body.subcategory;
    assert.equal((await request('POST', '/subcategories', { name: ' base ', slug: 'other', category: 'ROSTRO' })).status, 409);
    assert.equal((await request('POST', '/subcategories', { name: 'Other', slug: 'base', category: 'ROSTRO' })).status, 409);
    result = await request('POST', '/subcategories', { name: 'Base', slug: 'base', category: 'LABIOS' });
    assert.equal(result.status, 201);
    lipsSubcategory = result.body.subcategory;
    for (const url of ['/subcategories?category=ROSTRO', '/subcategories/category/ROSTRO']) {
      result = await request('GET', url);
      assert.deepEqual(result.body.subcategories.map(value => value.id), [baseSubcategory.id]);
    }
    assert.equal((await request('GET', `/brands/${brand.id}`)).body.brand.id, brand.id);
    assert.equal((await request('GET', `/subcategories/${baseSubcategory.id}`)).body.subcategory.id, baseSubcategory.id);
  });

  await t.test('invalid categories, references, stock, nulls and query objects return 400', async () => {
    const missing = new mongoose.Types.ObjectId().toString();
    for (const data of [
      { category: 'CAMISA' }, { category: 'Hidratación' }, { category: 'LABIOS' },
      { stock: -1 }, { stock: null }, { stock: '5' }, { price: -1 },
      { brand: missing }, { brand: 'invalid' }, { subcategory: missing }, { subcategory: null },
    ]) assert.equal((await request('POST', '/products', { ...newProduct(), ...data })).status, 400, JSON.stringify(data));
    const noStock = newProduct();
    delete noStock.stock;
    assert.equal((await request('POST', '/products', noStock)).status, 400);
    for (const url of ['/products?category=CAMISA', '/products?brand=invalid', '/products?subcategory=invalid', '/products?category=ROSTRO&category=LABIOS', '/products?limit=0', '/products?offset=-1', '/products/stock?brand=invalid', '/subcategories/category/INVALID', '/brands/invalid']) {
      assert.equal((await request('GET', url)).status, 400, url);
    }
  });

  await t.test('create populates references and uses the same JSON for MongoDB and Redis reads', async () => {
    const result = await request('POST', '/products', { ...newProduct(), state: false, sizes: [{ size: 'M', stock: 99 }], gender: 'HOMBRES' });
    assert.equal(result.status, 201);
    product = result.body;
    assert.equal(product.state, true);
    assert.equal(product.stock, 15);
    assert.equal(product.brand.id, brand.id);
    assert.equal(product.subcategory.name, 'Base');
    assert.equal('sizes' in product, false);
    assert.equal('gender' in product, false);
    for (const url of [`/products/${product.id}`, `/products/slug/${product.slug}`]) {
      const first = await request('GET', url);
      assert.deepEqual(first.body, product);
      await redis.del(`product:${url.includes('/slug/') ? product.slug : product.id}`);
      const uncached = await request('GET', url);
      assert.deepEqual(uncached.body, first.body);
    }
  });

  await t.test('lists filter all classifications and stock, with separate cache keys', async () => {
    const soldOut = await request('POST', '/products', { ...newProduct(), title: 'Sin existencias', slug: 'sin-existencias', stock: 0 });
    assert.equal(soldOut.status, 201);
    const filters = `category=ROSTRO&subcategory=${baseSubcategory.id}&brand=${brand.id}`;
    const list = await request('GET', `/products?${filters}`);
    assert.equal(list.body.count, 2);
    assert.equal(list.body.products[0].brand.name, 'Maybelline');
    assert.deepEqual((await request('GET', `/products?${filters}`)).body, list.body);
    assert.equal((await request('GET', `/products/stock?${filters}`)).body.count, 1);
    assert.equal((await request('GET', `/products?subcategory=${lipsSubcategory.id}`)).body.count, 0);
    assert.equal((await request('GET', '/products?category=LABIOS')).body.count, 0);
    assert.equal((await request('GET', `/products?brand=${new mongoose.Types.ObjectId()}`)).body.count, 0);
    assert.equal((await request('GET', '/products?limit=1&offset=1')).body.products.length, 1);
    assert.ok((await redis.keys('products:*')).some(key => key.endsWith(':WITH_STOCK')));
    await request('DELETE', `/products/${soldOut.body.id}`);
  });

  await t.test('PATCH validates merged references; invalid updates cannot change saved data', async () => {
    for (const data of [{ category: 'LABIOS' }, { subcategory: lipsSubcategory.id }, { stock: -1 }, { brand: null }]) {
      assert.equal((await request('PATCH', `/products/${product.id}`, data)).status, 400);
    }
    const unchanged = await Product.findById(product.id);
    assert.equal(unchanged.category, 'ROSTRO');
    assert.equal(unchanged.stock, 15);
    const result = await request('PATCH', `/products/${product.id}`, { category: 'LABIOS', subcategory: lipsSubcategory.id, slug: 'nuevo-slug', stock: 0 });
    assert.equal(result.status, 200);
    assert.equal(result.body.subcategory.id, lipsSubcategory.id);
    assert.equal(await redis.get(`product:${product.slug}`), null);
    assert.equal((await request('GET', `/products/slug/${product.slug}`)).status, 404);
    assert.equal((await request('GET', '/products/slug/nuevo-slug')).body.stock, 0);
    assert.equal((await request('GET', '/products/stock')).body.count, 0);
    assert.equal(JSON.parse(await redis.get(`product:${product.id}`)).stock, 0);
    product = result.body;
  });

  await t.test('used classifications cannot be deleted or moved; renaming invalidates populated caches', async () => {
    assert.equal((await request('DELETE', `/brands/${brand.id}`)).status, 409);
    assert.equal((await request('DELETE', `/subcategories/${lipsSubcategory.id}`)).status, 409);
    assert.equal((await request('PATCH', `/subcategories/${lipsSubcategory.id}`, { category: 'ROSTRO' })).status, 409);
    assert.equal((await request('PATCH', `/brands/${brand.id}`, { name: 'Maybelline New', slug: 'maybelline-new' })).status, 200);
    assert.equal(await redis.get(`product:${product.id}`), null);
    assert.equal((await request('GET', `/products/${product.id}`)).body.brand.name, 'Maybelline New');
    assert.equal((await request('PATCH', `/subcategories/${lipsSubcategory.id}`, { name: 'Labial' })).status, 200);
    assert.equal((await request('GET', `/products/slug/${product.slug}`)).body.subcategory.name, 'Labial');
  });

  await t.test('image uploads keep WebP/S3 contracts and invalidate ID, slug and list caches', async () => {
    const sharp = require('sharp');
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const form = new FormData();
    form.append('archivo', new Blob([png], { type: 'image/png' }), 'sample.png');
    await request('GET', '/products');
    const result = await fetch(`${base}/upload/products/${product.id}`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, body: form });
    assert.equal(result.status, 200, JSON.stringify(await result.json()));
    assert.equal(uploadFolder, 'uploads/images/products');
    assert.equal((await redis.keys('products:*')).length, 0);
    const current = await request('GET', `/products/slug/${product.slug}`);
    assert.equal(current.body.images.length, 1);
    assert.equal(current.body.brand.id, brand.id);
    const key = current.body.images[0].key;
    assert.equal((await request('DELETE', `/upload/products/${product.id}`, { key })).status, 200);
    assert.deepEqual(deletedImages, [key]);
    assert.equal((await request('GET', `/products/${product.id}`)).body.images.length, 0);
    assert.equal((await request('GET', `/products/slug/${product.slug}`)).body.images.length, 0);
  });

  await t.test('soft deletion clears all product caches and permits unused taxonomy deletion/reuse', async () => {
    await request('GET', '/products');
    assert.equal((await request('DELETE', `/products/${product.id}`)).status, 200);
    assert.equal((await Product.findById(product.id)).state, false);
    assert.equal(await redis.get(`product:${product.id}`), null);
    assert.equal(await redis.get(`product:${product.slug}`), null);
    assert.equal((await redis.keys('products:*')).length, 0);
    assert.equal((await request('GET', `/products/${product.id}`)).status, 404);
    assert.equal((await request('GET', `/products/slug/${product.slug}`)).status, 404);
    assert.equal((await request('PATCH', `/products/${product.id}`, { stock: 4 })).status, 404);
    assert.equal((await request('GET', '/products')).body.count, 0);
    assert.equal((await request('DELETE', `/brands/${brand.id}`)).status, 200);
    assert.equal((await request('DELETE', `/subcategories/${baseSubcategory.id}`)).status, 200);
    assert.equal((await Brand.findById(brand.id)).state, false);
    assert.equal((await Subcategory.findById(baseSubcategory.id)).state, false);
    assert.equal((await request('GET', `/brands/${brand.id}`)).status, 404);
    assert.equal((await request('GET', '/brands')).body.brands.length, 0);
    assert.equal((await request('GET', '/subcategories/category/ROSTRO')).body.subcategories.length, 0);
    assert.equal((await request('POST', '/products', newProduct())).status, 400);
    assert.equal((await request('POST', '/products', { ...newProduct(), category: 'LABIOS', subcategory: lipsSubcategory.id })).status, 400);
    assert.equal((await request('POST', '/brands', { name: 'Maybelline New', slug: 'maybelline-new' })).status, 201);
    assert.equal((await request('POST', '/subcategories', { name: 'Base', slug: 'base', category: 'ROSTRO' })).status, 201);
  });

  await t.test('index migration can run against existing schema indexes and roll back without dropping data', async () => {
    const migration = require('../migrations/20260922010000-catalog-indexes');
    await migration.up(mongoose.connection.db);
    const count = await Brand.countDocuments();
    await migration.down(mongoose.connection.db);
    assert.equal(await Brand.countDocuments(), count);
    await migration.up(mongoose.connection.db);
  });
});
