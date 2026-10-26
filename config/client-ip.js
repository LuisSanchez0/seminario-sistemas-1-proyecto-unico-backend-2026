const net = require('node:net');

// TRUST_PROXY selects how req.ip (used by the password-recovery per-IP limit) is derived:
//   loopback    - same-host Caddy (direct HTTPS mode): Express trusts X-Forwarded-For only from 127.0.0.0/8 / ::1.
//   cloudflared - Cloudflare Tunnel: the API is bound to 127.0.0.1, so local cloudflared is the only possible peer.
//                 Cloudflare's edge sets CF-Connecting-IP to the connecting client; it is honoured only from a
//                 loopback peer, and X-Forwarded-For is ignored entirely.
//   unset/other - no proxy trust; req.ip is the socket peer.
const isLoopback = address => net.isIPv4(address) ? address.startsWith('127.')
  : address === '::1' || /^::ffff:127\./i.test(address || '');

const cloudflaredClientIp = (req, _res, next) => {
  const header = (req.get('cf-connecting-ip') || '').trim();
  // A missing or malformed header keeps the socket peer: limits get stricter, never bypassable.
  if (isLoopback(req.socket.remoteAddress) && net.isIP(header)) {
    Object.defineProperty(req, 'ip', { value: header, configurable: true, enumerable: true });
  }
  next();
};

const applyClientIpPolicy = app => {
  const mode = process.env.TRUST_PROXY;
  app.set('trust proxy', mode === 'loopback' ? 'loopback' : false);
  if (mode === 'cloudflared') app.use(cloudflaredClientIp);
};

module.exports = { applyClientIpPolicy, cloudflaredClientIp, isLoopback };
