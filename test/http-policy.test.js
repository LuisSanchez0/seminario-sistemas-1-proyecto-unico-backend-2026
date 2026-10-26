const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const Server = require('../models/server');

const ENV = ['NODE_ENV', 'TRUST_PROXY', 'CORS_ORIGINS'];
const withEnv = async (values, run) => {
  const saved = Object.fromEntries(ENV.map(key => [key, process.env[key]]));
  for (const key of ENV) if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key];
  try { return await run(); } finally { for (const key of ENV) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
};
// Real Server middleware stack plus a probe route; connects over loopback like Caddy does on EC2.
const start = async () => {
  const app = express();
  Server.prototype.middlewares.call({ app });
  app.get('/api/probe', (req, res) => res.json({ ip: req.ip, protocol: req.protocol }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const get = (headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/probe`, { headers });
  return { app, get, close: () => new Promise(resolve => server.close(resolve)) };
};

test('trust proxy accepts only the same-host loopback hop', async () => {
  await withEnv({ TRUST_PROXY: 'loopback' }, async () => {
    const api = await start();
    try {
      const trusted = api.app.get('trust proxy fn');
      for (const address of ['127.0.0.1', '127.0.0.53', '::1']) assert.equal(trusted(address, 0), true, address);
      for (const address of ['172.17.0.1', '10.0.0.5', '203.0.113.7', '::ffff:198.51.100.1']) assert.equal(trusted(address, 0), false, address);
      // Caddy sets the real peer; client-supplied prefixes are discarded.
      const proxied = await (await api.get({ 'X-Forwarded-For': '6.6.6.6, 198.51.100.20', 'X-Forwarded-Proto': 'https' })).json();
      assert.deepEqual(proxied, { ip: '198.51.100.20', protocol: 'https' });
      // A loopback-looking forged value is not trusted either: only the socket peer is.
      assert.equal((await (await api.get({ 'X-Forwarded-For': '198.51.100.20, 127.0.0.1' })).json()).ip, '198.51.100.20');
    } finally { await api.close(); }
  });
});

test('without TRUST_PROXY, X-Forwarded-For is ignored entirely', async () => {
  await withEnv({}, async () => {
    const api = await start();
    try {
      assert.equal(api.app.get('trust proxy fn')('127.0.0.1', 0), false);
      assert.equal((await (await api.get({ 'X-Forwarded-For': '6.6.6.6' })).json()).ip, '127.0.0.1');
    } finally { await api.close(); }
  });
  for (const unsafe of ['true', '1', '0.0.0.0/0']) {
    await withEnv({ TRUST_PROXY: unsafe }, async () => {
      const api = await start();
      try { assert.equal((await (await api.get({ 'X-Forwarded-For': '6.6.6.6' })).json()).ip, '127.0.0.1', unsafe); }
      finally { await api.close(); }
    });
  }
});

test('cloudflared mode: CF-Connecting-IP from the local tunnel only; X-Forwarded-For never trusted', async () => {
  await withEnv({ TRUST_PROXY: 'cloudflared' }, async () => {
    const api = await start();
    try {
      assert.equal(api.app.get('trust proxy fn')('127.0.0.1', 0), false, 'Express XFF trust stays off');
      const ip = async headers => (await (await api.get(headers)).json()).ip;
      assert.equal(await ip({ 'CF-Connecting-IP': '198.51.100.20', 'X-Forwarded-For': '6.6.6.6' }), '198.51.100.20');
      assert.equal(await ip({ 'CF-Connecting-IP': '2001:db8::7' }), '2001:db8::7');
      assert.equal(await ip({ 'X-Forwarded-For': '6.6.6.6', 'X-Real-IP': '6.6.6.6', 'True-Client-IP': '6.6.6.6' }), '127.0.0.1');
      for (const bad of ['6.6.6.6, 198.51.100.20', 'not-an-ip', '198.51.100.20:443', ' ']) assert.equal(await ip({ 'CF-Connecting-IP': bad }), '127.0.0.1', bad);
    } finally { await api.close(); }
  });
  // A non-loopback peer (a hypothetical direct connection) can never assert a client IP.
  const { cloudflaredClientIp, isLoopback } = require('../config/client-ip');
  for (const peer of ['203.0.113.7', '10.0.0.5', '172.17.0.1', '::ffff:198.51.100.1', '2001:db8::1']) {
    const req = { socket: { remoteAddress: peer }, get: () => '198.51.100.20' };
    cloudflaredClientIp(req, null, () => {});
    assert.equal(Object.hasOwn(req, 'ip'), false, peer);
    assert.equal(isLoopback(peer), false, peer);
  }
  for (const peer of ['127.0.0.1', '127.0.0.53', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopback(peer), true, peer);
});

test('production CORS allows only the configured frontend origins', async () => {
  const origins = 'https://lumina-staging-frontend.vercel.app,https://shop.example.com';
  await withEnv({ NODE_ENV: 'production', CORS_ORIGINS: origins }, async () => {
    const api = await start();
    try {
      for (const origin of origins.split(',')) {
        const response = await api.get({ Origin: origin });
        assert.equal(response.headers.get('access-control-allow-origin'), origin);
        assert.match(response.headers.get('access-control-expose-headers'), /Retry-After/);
        assert.match(response.headers.get('vary'), /Origin/);
      }
      for (const origin of ['https://evil.example.net', 'http://lumina-staging-frontend.vercel.app', 'http://localhost:4200', 'null']) {
        assert.equal((await api.get({ Origin: origin })).headers.get('access-control-allow-origin'), null, origin);
      }
      assert.equal((await api.get()).status, 200, 'requests without Origin (health checks) still work');
    } finally { await api.close(); }
  });
});

test('development keeps localhost origins; production fails closed on bad configuration', async () => {
  await withEnv({ NODE_ENV: 'development' }, async () => {
    const api = await start();
    try {
      for (const origin of ['http://localhost:4200', 'http://127.0.0.1:4300']) assert.equal((await api.get({ Origin: origin })).headers.get('access-control-allow-origin'), origin);
      assert.equal((await api.get({ Origin: 'https://evil.example.net' })).headers.get('access-control-allow-origin'), null);
    } finally { await api.close(); }
  });
  await withEnv({ NODE_ENV: 'production' }, async () => assert.throws(() => Server.prototype.middlewares.call({ app: express() }), /CORS_ORIGINS is required/));
  for (const bad of ['*', 'https://*.vercel.app', 'http://shop.example.com', 'https://shop.example.com/', 'https://shop.example.com/path']) {
    await withEnv({ NODE_ENV: 'production', CORS_ORIGINS: bad }, async () => assert.throws(() => Server.prototype.middlewares.call({ app: express() }), /exact https origins/, bad));
  }
});
