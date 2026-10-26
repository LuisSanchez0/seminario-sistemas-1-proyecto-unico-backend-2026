// Real Chrome + compiled Angular + Express routes + MongoDB/Redis + local SMTP.
// Run with Node 22 and FRONTEND_DIR pointing to the frontend repository.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const assert = require('node:assert/strict');
const { startRecoveryFixture } = require('./recovery-fixture');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const frontend = path.resolve(process.env.FRONTEND_DIR || '../seminario-sistemas-1-proyecto-unico-frontend-2026');
  const output = path.join(frontend, 'dist/luminabeauty-app/browser');
  await fs.access(path.join(output, 'index.html'));
  const qa = await startRecoveryFixture();
  const profile = await fs.mkdtemp('/tmp/lumina-chrome-');
  let browser, server, socket;
  const evidence = [];
  const pass = name => { evidence.push(name); console.log('PASS:', name); };
  try {
    server = http.createServer(async (req, res) => {
      try {
        if (req.url.startsWith('/api/')) {
          const body = []; for await (const chunk of req) body.push(chunk);
          const target = new URL(req.url, qa.base).toString();
          const response = await fetch(target, { method: req.method, headers: { 'content-type': 'application/json', ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) }, ...(body.length ? { body: Buffer.concat(body) } : {}) });
          res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer())); return;
        }
        const route = decodeURIComponent(new URL(req.url, 'http://local').pathname);
        let file = path.resolve(output, '.' + route);
        if (!file.startsWith(output + path.sep)) file = path.join(output, 'index.html');
        let bytes;
        try { bytes = await fs.readFile(file); } catch { file = path.join(output, 'index.html'); bytes = await fs.readFile(file); }
        const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(file)] || 'application/octet-stream';
        res.writeHead(200, { 'content-type': type }); res.end(bytes);
      } catch { res.writeHead(500); res.end(); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    browser = spawn('google-chrome', ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
    let port;
    for (let i = 0; i < 100; i++) { try { port = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await sleep(100); } }
    assert.ok(port, 'Chrome startup');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
    let sequence = 0, resetPayload;
    const pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) { const wait = pending.get(message.id); pending.delete(message.id); if (message.error) wait.reject(new Error(message.error.message)); else wait.resolve(message.result); }
      if (message.method === 'Network.requestWillBeSent' && message.params.request.url.endsWith('/password/reset')) resetPayload = JSON.parse(message.params.request.postData);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    const waitFor = async (expression, description) => {
      for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await sleep(100); }
      throw new Error('Timed out: ' + description);
    };
    const fill = (id, value) => evaluate(`(() => { const input=document.getElementById(${JSON.stringify(id)}); input.value=${JSON.stringify(value)}; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    const submit = () => evaluate('document.querySelector("form").requestSubmit()');
    const axeSource = await fs.readFile(path.join(frontend, 'node_modules/axe-core/axe.min.js'), 'utf8');
    const accessibility = async step => {
      await evaluate(axeSource);
      const violations = await evaluate('(async () => (await axe.run(document.querySelector("app-restore-password-page"))).violations.map(v=>({id:v.id,impact:v.impact})))()');
      assert.deepEqual(violations, [], `axe ${step}`); pass(`Chrome axe including contrast: ${step}`);
    };
    await send('Network.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/auth/login` });
    await waitFor('!!document.querySelector("a[href=\'/auth/restore\']")', 'login'); pass('1. Open actual login');
    await evaluate('document.querySelector("a[href=\'/auth/restore\']").click()');
    await waitFor('!!document.getElementById("recoveryEmail")', 'recovery navigation'); pass('2. Forgot-password navigation');
    await accessibility('identifier');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true); pass('Mobile layout without horizontal overflow');
    await fill('recoveryEmail', 'recovery@example.com'); pass('3. Enter isolated QA account');
    await submit(); await waitFor('!!document.getElementById("code")', 'code step'); pass('4. Request code through browser');
    const code = qa.latestCode(); assert.match(code, /^\d{8}$/); pass('5. Real SMTP code delivery to local capture server');
    await fill('code', '00000000'); await submit();
    await waitFor('document.body.textContent.includes("Intentos restantes: 4")', 'visible invalid-code error'); pass('6. Wrong code produces visible error');
    await accessibility('code with error');
    await fill('code', code); await submit(); await waitFor('!!document.getElementById("newPassword")', 'new password'); pass('7. Delivered code verifies');
    await accessibility('new password');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true); pass('Desktop layout without horizontal overflow');
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile('/tmp/lumina-recovery-browser.png', Buffer.from(screenshot.data, 'base64'));
    await fill('newPassword', 'BrowserPassword123'); await fill('confirmPassword', 'BrowserPassword123'); pass('8. Enter and confirm new password');
    await submit(); await waitFor('location.pathname === "/auth/login" && document.body.textContent.includes("Contraseña actualizada")', 'successful reset'); pass('9. Reset succeeds and returns to login');
    await fill('email', 'recovery@example.com'); await fill('password', 'OldPassword123'); await submit();
    await waitFor('document.body.textContent.includes("La contraseña ingresada no es correcta")', 'old password rejected'); pass('10. Old password rejected in browser login');
    await fill('password', 'BrowserPassword123'); await submit(); await waitFor('location.pathname === "/" && !!localStorage.getItem("token")', 'new password login'); pass('11. New password logs in through browser');
    assert.ok(resetPayload?.resetToken);
    assert.equal((await qa.request('/password/reset', resetPayload)).status, 400);
    assert.equal((await qa.request('/password/verify', { email: qa.user.email, code })).status, 400); pass('12. Observed code and authorization cannot be replayed');
    await fs.writeFile('/tmp/lumina-recovery-browser-results.json', JSON.stringify({ passed: evidence.length, failed: 0, scenarios: evidence, screenshot: '/tmp/lumina-recovery-browser.png' }, null, 2));
  } finally {
    socket?.close();
    if (browser && browser.exitCode === null) { const exit = once(browser, 'exit'); browser.kill(); await exit; }
    if (server) await new Promise(resolve => server.close(resolve));
    await qa.close(); await fs.rm(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
