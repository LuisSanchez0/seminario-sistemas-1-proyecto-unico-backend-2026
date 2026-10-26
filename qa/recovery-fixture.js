const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const mongoose = require('mongoose');
const express = require('express');
const bcrypt = require('bcryptjs');
const freePort = async () => {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
};
async function startRecoveryFixture(port = 0, { trustProxy = 'loopback' } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumina-recovery-'));
  const children = [];
  let smtp, server, redis;
  const mails = [];
  const close = async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (smtp) await new Promise(resolve => smtp.close(resolve));
    if (redis?.isOpen) redis.destroy();
    await mongoose.disconnect();
    for (const child of children.reverse()) {
      if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill(); await done; }
    }
    await fs.rm(directory, { recursive: true, force: true });
  };
  const start = async (command, args, ready) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`${command} startup timeout`)), 20000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`${command} exited during startup`)); });
      const read = data => { output += data; if (ready.test(output)) { clearTimeout(timer); resolve(); } };
      child.stdout.on('data', read); child.stderr.on('data', read);
    });
  };
  try {
    const mongoPort = await freePort(), redisPort = await freePort();
    await start('mongod', ['--dbpath', directory, '--port', String(mongoPort), '--bind_ip', '127.0.0.1', '--nounixsocket'], /Waiting for connections/);
    await start('redis-server', ['--port', String(redisPort), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--dir', directory], /Ready to accept connections/i);
    // Real local SMTP delivery, no production mailbox or test API for retrieving codes.
    smtp = net.createServer(socket => {
      socket.write('220 localhost QA SMTP\r\n');
      let buffer = '', dataMode = false, message = '';
      socket.on('data', chunk => {
        buffer += chunk.toString();
        let index;
        while ((index = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          if (dataMode) {
            if (line === '.') { mails.push(message); message = ''; dataMode = false; socket.write('250 accepted\r\n'); }
            else message += line + '\r\n';
          } else if (/^EHLO|^HELO/i.test(line)) socket.write('250 localhost\r\n');
          else if (/^DATA/i.test(line)) { dataMode = true; socket.write('354 send message\r\n'); }
          else if (/^QUIT/i.test(line)) socket.end('221 bye\r\n');
          else socket.write('250 OK\r\n');
        }
      });
    });
    smtp.listen(0, '127.0.0.1'); await once(smtp, 'listening');
    process.env.NODE_ENV = 'test'; process.env.QA_SMTP_PORT = String(smtp.address().port);
    process.env.REDIS_URL = `redis://127.0.0.1:${redisPort}`;
    process.env.SECRETEORPRIVATEKEY = require('node:crypto').randomBytes(32).toString('hex');
    await mongoose.connect(`mongodb://127.0.0.1:${mongoPort}/recovery_qa`);
    const { User } = require('../models');
    await User.init();
    redis = require('../database/config-redis'); if (!redis.isReady) await once(redis, 'ready');
    const user = await User.create({ email: 'recovery@example.com', name: 'Cuenta QA', password: await bcrypt.hash('OldPassword123', 10) });
    const other = await User.create({ email: 'other@example.com', name: 'Otra Cuenta', password: await bcrypt.hash('OtherPassword123', 10) });
    // Real CORS/client-IP middleware; the loopback client plays the same-host proxy (Caddy or cloudflared on EC2).
    process.env.TRUST_PROXY = trustProxy;
    const app = express();
    require('../models/server').prototype.middlewares.call({ app });
    require('../models/server').prototype.routes.call({ app, paths: { auth: '/api/auth', address: '/api/address', products: '/api/products', brands: '/api/brands', subcategories: '/api/subcategories', productImages: '/api/upload/products', orders: '/api/orders', admin: '/api/admin' } });
    server = app.listen(port, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api/auth`;
    const request = async (route, body, headers = {}) => {
      const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json(), headers: response.headers };
    };
    const latestCode = () => {
      const decoded = mails.at(-1)?.replace(/=\r\n/g, '').replace(/=3D/g, '=');
      const match = decoded?.match(/<p class="code">\s*(\d{8})\s*</);
      if (!match) throw new Error('No OTP found in delivered QA email');
      return match[1];
    };
    return { close, request, redis, user, other, User, mails, latestCode, base, app };
  } catch (error) { await close(); throw error; }
}
module.exports = { startRecoveryFixture };
