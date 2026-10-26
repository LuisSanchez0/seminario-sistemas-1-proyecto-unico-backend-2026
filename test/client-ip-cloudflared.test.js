const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startRecoveryFixture } = require('../qa/recovery-fixture');

// Quick Tunnel path: Browser -> Cloudflare edge (sets CF-Connecting-IP) -> local cloudflared -> 127.0.0.1 API.
// The loopback test client plays cloudflared; real recovery routes, Redis limits and MongoDB.
test('cloudflared mode: recovery IP limit keys on CF-Connecting-IP and ignores forged X-Forwarded-For', { timeout: 90000 }, async t => {
  const qa = await startRecoveryFixture(0, { trustProxy: 'cloudflared' }); t.after(qa.close);
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const recover = (email, headers) => qa.request('/password/request', { email }, headers);
  const viaTunnel = client => ({ 'CF-Connecting-IP': client, 'X-Forwarded-For': `203.0.113.${crypto.randomInt(1, 255)}` });

  await t.test('30 requests from one client with rotating forged X-Forwarded-For are accepted, the 31st is limited', async () => {
    const statuses = (await Promise.all(Array.from({ length: 30 }, (_, i) => recover(`cf-${i}@example.com`, viaTunnel('198.51.100.20'))))).map(r => r.status);
    assert.deepEqual([...new Set(statuses)], [200]);
    const blocked = await recover('cf-30@example.com', viaTunnel('198.51.100.20'));
    assert.equal(blocked.status, 429); assert.equal(blocked.headers.get('retry-after'), '3600');
    assert.equal(await qa.redis.get(`reset:ip:${digest('198.51.100.20')}`), '31');
  });
  await t.test('a different Cloudflare-reported client keeps its own budget', async () => {
    assert.equal((await recover('cf-other@example.com', viaTunnel('2001:db8::42'))).status, 200);
    assert.equal(await qa.redis.get(`reset:ip:${digest('2001:db8::42')}`), '1');
  });
  await t.test('without CF-Connecting-IP, forged X-Forwarded-For values all land in the local peer bucket', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await recover(`no-cf-${i}@example.com`, { 'X-Forwarded-For': `192.0.2.${i + 1}` })).status, 200);
    assert.equal(await qa.redis.get(`reset:ip:${digest('127.0.0.1')}`), '3');
    for (let i = 1; i <= 3; i++) assert.equal(await qa.redis.exists(`reset:ip:${digest(`192.0.2.${i}`)}`), 0);
  });
});
