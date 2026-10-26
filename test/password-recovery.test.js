const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { startRecoveryFixture } = require('../qa/recovery-fixture');

test('password recovery: real HTTP, MongoDB, Redis and QA SMTP', { timeout: 90000 }, async t => {
  const qa = await startRecoveryFixture(); t.after(qa.close);
  const { request, redis, user, other, User } = qa;
  const email = user.email;
  const codes = require('../helpers/db-redis-codes');
  const requestCode = async () => { await redis.del(`reset:${email}:cooldown`); return request('/password/request', { email }); };
  const issue = async () => { await codes.setVerificationCode(email, '12345678', 'reset'); return request('/password/verify', { email, code: '12345678' }); };
  const reset = (token, password = 'NewPassword123', extra = {}) => request('/password/reset', { resetToken: token, newPassword: password, confirmPassword: password, ...extra });
  await t.test('health verifies Mongo/Redis readiness and deployed revision', async () => {
    process.env.APP_VERSION = 'qa-recovery-version';
    const response = await fetch(qa.base.replace('/auth', '/health'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, version: 'qa-recovery-version' });
  });
  await t.test('request delivers branded email, stores digest with 900s TTL and exposes no OTP', async () => {
    const result = await requestCode(); assert.equal(result.status, 200); assert.equal(result.body.ok, true);
    assert.equal(result.body.code, undefined); assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.match(qa.mails.at(-1), /LuminaBeauty/); assert.match(qa.latestCode(), /^\d{8}$/);
    assert.notEqual(await redis.get(`reset:${email}`), qa.latestCode());
    assert.ok(await redis.ttl(`reset:${email}`) > 890);
  });
  await t.test('unknown, disabled and Google-only accounts get identical responses', async () => {
    const missing = await request('/password/request', { email: 'missing@example.com' });
    const existing = await requestCode(); assert.deepEqual(existing.body, missing.body);
    await User.create({ email: 'disabled@example.com', name: 'Disabled', password: 'unused', state: false });
    await User.create({ email: 'google@example.com', name: 'Google', password: 'unused', google: true });
    for (const value of ['disabled@example.com', 'google@example.com']) assert.deepEqual((await request('/password/request', { email: value })).body, missing.body);
  });
  await t.test('normalizes email, including legacy request-code reset alias', async () => {
    await redis.del(`reset:${email}:cooldown`);
    const result = await request('/request-code', { email: email.toUpperCase(), type: 'reset' }); assert.equal(result.status, 200);
  });
  await t.test('cooldown enforced on new and legacy request routes', async () => {
    for (const route of ['/password/request', '/request-code']) {
      const result = await request(route, { email, type: 'reset' }); assert.equal(result.status, 429); assert.ok(Number(result.headers.get('retry-after')) > 0);
    }
  });
  await t.test('invalid code returns remaining attempts without consuming valid code', async () => {
    const result = await request('/password/verify', { email, code: '00000000' });
    assert.equal(result.status, 400); assert.equal(result.body.attemptsRemaining, 4); assert.ok(await redis.get(`reset:${email}`));
  });
  let authorization;
  await t.test('delivered code verifies once and creates five-minute reset authorization', async () => {
    const result = await request('/password/verify', { email, code: qa.latestCode() });
    assert.equal(result.status, 200); authorization = result.body.resetToken; assert.match(authorization, /^[a-f0-9]{64}$/);
    assert.equal(result.body.expiresIn, 300); assert.equal(await redis.get(`reset:${email}`), null);
    assert.ok(await redis.ttl(`reset:authorization:${crypto.createHash('sha256').update(authorization).digest('hex')}`) > 290);
  });
  await t.test('replayed code rejected', async () => assert.equal((await request('/password/verify', { email, code: qa.latestCode() })).status, 400));
  await t.test('password policy and confirmation validated before consuming authorization', async () => {
    assert.equal((await reset(authorization, 'abc')).status, 400);
    assert.equal((await reset(authorization, 'NewPassword123', { confirmPassword: 'different' })).status, 400);
    assert.equal((await reset(authorization, 12345)).status, 400);
  });
  await t.test('reset changes only authorized account, hashes password, ignores forged identity', async () => {
    const previousOther = (await User.findById(other._id)).password;
    assert.equal((await reset(authorization, 'NewPassword123', { email: other.email, uid: other.id, verified: true })).status, 200);
    const updated = await User.findById(user._id); assert.notEqual(updated.password, 'NewPassword123');
    assert.equal(await bcrypt.compare('NewPassword123', updated.password), true);
    assert.equal((await User.findById(other._id)).password, previousOther);
  });
  await t.test('old password rejected by actual login endpoint; new password accepted', async () => {
    assert.equal((await request('/login', { email, password: 'OldPassword123' })).status, 400);
    const result = await request('/login', { email, password: 'NewPassword123' }); assert.equal(result.status, 200); assert.ok(result.body.token);
  });
  await t.test('reset replay and frontend verified=true forgery rejected', async () => {
    assert.equal((await reset(authorization)).status, 400);
    assert.equal((await request('/password/reset', { email, verified: true, newPassword: 'Forged123' })).status, 400);
  });
  await t.test('expired code rejected using actual Redis TTL', async () => {
    await codes.setVerificationCode(email, '12345678', 'reset'); await redis.pExpire(`reset:${email}`, 1);
    await new Promise(resolve => setTimeout(resolve, 10));
    const result = await request('/password/verify', { email, code: '12345678' }); assert.equal(result.body.code, 'CODE_EXPIRED');
  });
  await t.test('2fa code cannot authorize reset and reset code cannot verify 2fa', async () => {
    await codes.setVerificationCode(email, '87654321', '2fa');
    assert.equal((await request('/password/verify', { email, code: '87654321' })).status, 400);
    await codes.setVerificationCode(email, '12345678', 'reset');
    assert.equal((await request('/2fa/verify', { email, code: '12345678' })).status, 400);
  });
  await t.test('expired reset authorization rejected', async () => {
    const result = await issue(); const token = result.body.resetToken;
    await redis.pExpire(`reset:authorization:${crypto.createHash('sha256').update(token).digest('hex')}`, 1);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await reset(token)).body.code, 'RESET_EXPIRED');
  });
  await t.test('concurrent code verification only issues one authorization', async () => {
    await codes.setVerificationCode(email, '12345678', 'reset');
    const results = await Promise.all([1, 2].map(() => request('/password/verify', { email, code: '12345678' })));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
  });
  await t.test('concurrent authorizations can update the account only once', async () => {
    const first = await issue(), second = await issue();
    const results = await Promise.all([reset(first.body.resetToken, 'Concurrent123'), reset(second.body.resetToken, 'Concurrent456')]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
  });
  await t.test('attempt limit blocks correct code too and survives resends', async () => {
    await redis.del(`reset:${email}:attempts`); await codes.setVerificationCode(email, '12345678', 'reset');
    for (let i = 0; i < 5; i++) await request('/password/verify', { email, code: '00000000' });
    await codes.setVerificationCode(email, '12345678', 'reset');
    const result = await request('/password/verify', { email, code: '12345678' }); assert.equal(result.status, 429); assert.equal(result.body.code, 'TOO_MANY_ATTEMPTS');
  });
  await t.test('hourly send budget enforced even if cooldown elapsed', async () => {
    await redis.set(`reset:${email}:requests`, '5', { EX: 3600 });
    assert.equal((await requestCode()).status, 429);
  });
  await t.test('IP budget follows the proxy-reported client; forged X-Forwarded-For prefixes cannot bypass it', async () => {
    // The trusted hop appends the real peer last; anything a client prepends is ignored.
    const via = client => ({ 'X-Forwarded-For': `203.0.113.${crypto.randomInt(1, 255)}, ${client}` });
    const first = await Promise.all(Array.from({ length: 30 }, (_, i) => request('/password/request', { email: `ip-limit-${i}@example.com` }, via('198.51.100.20'))));
    assert.deepEqual([...new Set(first.map(r => r.status))], [200]);
    const blocked = await request('/password/request', { email: 'ip-limit-30@example.com' }, via('198.51.100.20'));
    assert.equal(blocked.status, 429); assert.equal(blocked.headers.get('retry-after'), '3600');
    assert.equal((await request('/password/request', { email: 'ip-limit-31@example.com' }, via('198.51.100.21'))).status, 200);
  });
  await t.test('invalid DTOs rejected and combined legacy reset cannot bypass security', async () => {
    assert.equal((await request('/password/request', { email: {} })).status, 400);
    assert.equal((await request('/password/verify', { email, code: 'abcdefgh' })).status, 400);
    assert.equal((await request('/password/verify-reset', { email, code: '12345678', newPassword: 'New123' })).status, 410);
  });
});
