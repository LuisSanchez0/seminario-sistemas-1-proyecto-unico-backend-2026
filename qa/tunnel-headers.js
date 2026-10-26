// Live audit of Cloudflare Quick Tunnel semantics against the real Express client-IP middleware.
// WARNING: opens a short-lived PUBLIC https://<random>.trycloudflare.com tunnel to a local probe route only
// (no application routes, database or secrets). Run it deliberately, e.g. once before the first demo deploy:
//   CLOUDFLARED_BIN=/path/to/cloudflared node qa/tunnel-headers.js
// Checks: URL discovery via the /quicktunnel metrics endpoint, delivered headers, spoofed client headers do not change
// req.ip, req.ip equals Cloudflare's CF-Connecting-IP, and a cloudflared restart rotates the hostname.
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const Server = require('../models/server');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const SPOOF = '203.0.113.250';

(async () => {
  process.env.TRUST_PROXY = 'cloudflared';
  process.env.NODE_ENV = 'development';
  const app = express();
  Server.prototype.middlewares.call({ app });
  app.get('/probe', (req, res) => res.json({ ip: req.ip, peer: req.socket.remoteAddress, headers: req.headers }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-tunnel-audit-'));
  const metrics = '127.0.0.1:20299';
  let tunnel;
  const start = () => { tunnel = spawn(process.env.CLOUDFLARED_BIN || 'cloudflared', ['tunnel', '--no-autoupdate', '--metrics', metrics,
    '--url', `http://127.0.0.1:${server.address().port}`], { env: { ...process.env, HOME: home }, stdio: 'ignore' }); };
  const hostname = async previous => {
    for (let i = 0; i < 60; i++) {
      try { const { hostname: h } = await (await fetch(`http://${metrics}/quicktunnel`)).json(); if (h && h !== previous) return h; } catch { /* starting */ }
      await sleep(1000);
    }
    throw new Error('No hostname from /quicktunnel');
  };
  const probe = async (host, headers = {}) => {
    for (let i = 0; i < 45; i++) {
      try { const r = await fetch(`https://${host}/probe`, { headers, signal: AbortSignal.timeout(10000) }); if (r.ok) return r.json(); } catch { /* edge propagation */ }
      await sleep(2000);
    }
    throw new Error(`Tunnel ${host} never served the probe`);
  };
  try {
    start();
    const first = await hostname();
    if (!/^[a-z0-9]+(-[a-z0-9]+)*\.trycloudflare\.com$/.test(first)) throw new Error(`Unexpected hostname ${first}`);
    const plain = await probe(first);
    const spoofed = await probe(first, { 'X-Forwarded-For': SPOOF, 'CF-Connecting-IP': SPOOF, 'True-Client-IP': SPOOF, 'X-Real-IP': SPOOF, Forwarded: `for=${SPOOF}` });
    const pick = h => Object.fromEntries(Object.entries(h).filter(([k]) => /^(cf-|x-forwarded|x-real-ip|true-client-ip|forwarded|host)/.test(k)));
    console.log('hostname (via /quicktunnel):', first);
    console.log('plain   :', JSON.stringify({ ip: plain.ip, peer: plain.peer, headers: pick(plain.headers) }));
    console.log('spoofed :', JSON.stringify({ ip: spoofed.ip, peer: spoofed.peer, headers: pick(spoofed.headers) }));
    const checks = {
      'peer is local cloudflared (loopback)': /^(127\.|::1$|::ffff:127\.)/.test(spoofed.peer),
      'CF-Connecting-IP delivered': Boolean(plain.headers['cf-connecting-ip']),
      'req.ip equals CF-Connecting-IP': plain.ip === plain.headers['cf-connecting-ip'],
      'spoofed CF-Connecting-IP overwritten by Cloudflare': spoofed.headers['cf-connecting-ip'] !== SPOOF,
      'spoofed headers do not change req.ip': spoofed.ip === plain.ip && spoofed.ip !== SPOOF,
    };
    tunnel.kill(); await once(tunnel, 'exit');
    start();
    const second = await hostname(first);
    await probe(second);
    checks['restart rotates the hostname'] = second !== first;
    let oldServes = false;
    try { oldServes = (await fetch(`https://${first}/probe`, { signal: AbortSignal.timeout(10000) })).ok; } catch { /* gone */ }
    checks['old hostname no longer reaches the origin'] = !oldServes;
    console.log('rotated hostname:', second);
    for (const [name, pass] of Object.entries(checks)) console.log(pass ? 'PASS' : 'FAIL', ' ', name);
    if (Object.values(checks).includes(false)) process.exitCode = 1;
  } finally {
    tunnel?.kill(); server.close(); fs.rmSync(home, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
