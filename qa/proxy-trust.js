// Real Caddy in front of the real Express middleware and recovery routes, rendered from the production
// Caddyfile template. Proves: real client IP reaches Express, forged X-Forwarded-For is discarded, recovery
// IP limits hold through the proxy, the API port is loopback-only, and HTTP redirects to HTTPS.
// Local differences only: Caddy's internal CA (no public DNS here), unprivileged ports, admin socket path.
// Usage: CADDY_BIN=/path/to/caddy node qa/proxy-trust.js   (needs mongod, redis-server, curl, a non-loopback IPv4)
const { spawn, execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { setTimeout: sleep } = require('node:timers/promises');
const { startRecoveryFixture } = require('./recovery-fixture');

const DOMAIN = 'lumina.localhost', HTTPS_PORT = 18443, HTTP_PORT = 18080;
const results = [];
const check = (name, condition, detail) => { results.push({ name, pass: Boolean(condition), detail }); if (!condition) throw new Error(`${name}: ${JSON.stringify(detail)}`); };

(async () => {
  const caddy = process.env.CADDY_BIN || 'caddy';
  const lan = Object.values(os.networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal)?.address;
  if (!lan) throw new Error('A non-loopback IPv4 address is required to play the internet client');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-proxy-'));
  const qa = await startRecoveryFixture();
  let proxy;
  try {
    qa.app.get('/api/probe', (req, res) => res.json({ ip: req.ip, protocol: req.protocol, host: req.get('host'),
      forwardedFor: req.get('x-forwarded-for'), forwardedProto: req.get('x-forwarded-proto') }));
    const upstream = new URL(qa.base).port;
    const template = fs.readFileSync(path.join(__dirname, '../infra/terraform/Caddyfile.tftpl'), 'utf8');
    const caddyfile = template
      .replace('admin unix//run/caddy/admin.sock', `admin unix/${work}/admin.sock\n\thttp_port ${HTTP_PORT}\n\thttps_port ${HTTPS_PORT}\n\tskip_install_trust`)
      .replace('${domain} {', `${DOMAIN} {\n\ttls internal`)
      .replace('${port}', upstream);
    if (caddyfile.includes('${')) throw new Error('Unrendered template placeholder');
    fs.writeFileSync(path.join(work, 'Caddyfile'), caddyfile);
    const env = { ...process.env, XDG_DATA_HOME: work, XDG_CONFIG_HOME: work };
    execFileSync(caddy, ['validate', '--config', path.join(work, 'Caddyfile'), '--adapter', 'caddyfile'], { env, stdio: 'pipe' });
    proxy = spawn(caddy, ['run', '--config', path.join(work, 'Caddyfile'), '--adapter', 'caddyfile'], { env, stdio: 'ignore' });
    const root = path.join(work, 'caddy/pki/authorities/local/root.crt');
    // curl with certificate verification against the issuing CA; the client connects from the LAN address.
    // Async: the API under test runs in this same process.
    const run = promisify(execFile);
    const curl = async (args, from = lan) => (await run('curl', ['--silent', '--show-error', '--max-time', '15', '--cacert', root,
      '--resolve', `${DOMAIN}:${HTTPS_PORT}:${from}`, '--resolve', `${DOMAIN}:${HTTP_PORT}:${from}`, ...args])).stdout;
    const probe = async (headers = [], from) => JSON.parse(await curl([...headers.flatMap(h => ['-H', h]), `https://${DOMAIN}:${HTTPS_PORT}/api/probe`], from));
    for (let i = 0; ; i++) { try { await probe(); break; } catch (error) { if (i > 40) throw error; await sleep(250); } }

    const direct = await probe();
    check('real client IP preserved through Caddy', direct.ip === lan && direct.forwardedFor === lan, direct);
    check('Caddy sends X-Forwarded-Proto https and the original Host', direct.protocol === 'https' && direct.forwardedProto === 'https' && direct.host === `${DOMAIN}:${HTTPS_PORT}`, direct);
    const spoofed = await probe(['X-Forwarded-For: 6.6.6.6', 'X-Real-IP: 6.6.6.6', 'Forwarded: for=6.6.6.6']);
    check('forged X-Forwarded-For from the client is discarded', spoofed.ip === lan && spoofed.forwardedFor === lan, spoofed);
    const spoofedLoopback = await probe(['X-Forwarded-For: 127.0.0.1']);
    check('forged loopback X-Forwarded-For is discarded', spoofedLoopback.ip === lan, spoofedLoopback);

    const recover = async (email, headers = [], from) => {
      const out = await curl(['-o', '/dev/null', '-w', '%{http_code} %header{retry-after}', '-X', 'POST', '-H', 'Content-Type: application/json',
        ...headers.flatMap(h => ['-H', h]), '--data', JSON.stringify({ email }), `https://${DOMAIN}:${HTTPS_PORT}/api/auth/password/request`], from);
      const [status, retryAfter] = out.trim().split(' ');
      return { status: Number(status), retryAfter };
    };
    const statuses = (await Promise.all(Array.from({ length: 30 }, (_, i) =>
      recover(`proxy-${i}@example.com`, [`X-Forwarded-For: 203.0.113.${i + 1}`])))).map(r => r.status);
    check('30 recovery requests from one client with rotating forged IPs are accepted', statuses.every(s => s === 200), statuses);
    const blocked = await recover('proxy-30@example.com', ['X-Forwarded-For: 198.51.100.99']);
    check('31st request is rate limited despite a new forged IP', blocked.status === 429 && blocked.retryAfter === '3600', blocked);
    const digest = value => crypto.createHash('sha256').update(value).digest('hex');
    const counted = await qa.redis.get(`reset:ip:${digest(lan)}`);
    const forgedKeys = (await Promise.all(['203.0.113.1', '198.51.100.99'].map(ip => qa.redis.exists(`reset:ip:${digest(ip)}`)))).reduce((a, b) => a + b, 0);
    check('IP budget is keyed by the real client only', counted === '31' && forgedKeys === 0, { counted, forgedKeys });
    const otherClient = await recover('proxy-other@example.com', [], '127.0.0.1');
    check('a different real client keeps its own budget', otherClient.status === 200, otherClient);

    const redirect = (await curl(['-o', '/dev/null', '-w', '%{http_code} %{redirect_url}', `http://${DOMAIN}:${HTTP_PORT}/api/health`])).trim();
    // Caddy redirects to the default HTTPS port, exactly as production on :443.
    check('HTTP redirects to HTTPS', redirect === `308 https://${DOMAIN}/api/health`, redirect);
    const reachable = await new Promise(resolve => {
      const socket = net.connect({ host: lan, port: Number(upstream), timeout: 2000 });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false)).once('timeout', () => { socket.destroy(); resolve(false); });
    });
    check('API port is not reachable from a non-loopback address', !reachable, { port: upstream, reachable });
    let insecure;
    try { await run('curl', ['--silent', '--max-time', '15', '--resolve', `${DOMAIN}:${HTTPS_PORT}:${lan}`, `https://${DOMAIN}:${HTTPS_PORT}/api/probe`]); insecure = 'accepted'; }
    catch (error) { insecure = `rejected (curl exit ${error.code})`; }
    check('certificate verification is enforced (untrusted issuer rejected without its CA)', insecure.startsWith('rejected'), insecure);
    execFileSync(caddy, ['reload', '--config', path.join(work, 'Caddyfile'), '--adapter', 'caddyfile', '--force'], { env, stdio: 'pipe' });
    check('graceful reload through the Unix admin socket', (await probe()).ip === lan, 'reload ok');
    let tcpAdmin;
    try { await run('curl', ['--silent', '--max-time', '2', 'http://127.0.0.1:2019/config/']); tcpAdmin = 'reachable'; }
    catch { tcpAdmin = 'unreachable'; }
    check('no TCP admin API on localhost:2019', tcpAdmin === 'unreachable', tcpAdmin);
  } finally {
    if (proxy) proxy.kill();
    await qa.close();
    fs.rmSync(work, { recursive: true, force: true });
    for (const result of results) console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name}  ${JSON.stringify(result.detail)}`);
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
