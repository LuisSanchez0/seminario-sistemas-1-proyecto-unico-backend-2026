const crypto = require('node:crypto');
const redisClient = require('../database/config-redis');
const CODE_EXPIRATION = 900;
const RESET_EXPIRATION = 300;
const RESEND_COOLDOWN = 30;
const MAX_ATTEMPTS = 5;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const normalizeEmail = email => email.trim().toLowerCase();
const codeKey = (email, type) => {
  if (!['2fa', 'reset'].includes(type)) throw new Error('Unsupported code purpose');
  return `${type}:${normalizeEmail(email)}`;
};
const authError = (msg, status = 400, code = 'INVALID_CODE') => Object.assign(new Error(msg), { status, code });
// Atomic limits: 30 requests/IP/hour, 5 sends/account/hour, 30 seconds between sends.
const reserveCodeRequest = async (email, type, ip = 'internal') => {
  const key = codeKey(email, type);
  const result = await redisClient.eval(`
    local ipCount = redis.call('INCR', KEYS[3])
    if ipCount == 1 then redis.call('EXPIRE', KEYS[3], 3600) end
    if ipCount > 30 then return 3600 end
    local ttl = redis.call('TTL', KEYS[1])
    if ttl > 0 then return ttl end
    local count = tonumber(redis.call('GET', KEYS[2]) or '0')
    if count >= 5 then return math.max(1, redis.call('TTL', KEYS[2])) end
    count = redis.call('INCR', KEYS[2])
    if count == 1 then redis.call('EXPIRE', KEYS[2], 3600) end
    redis.call('SET', KEYS[1], '1', 'EX', ARGV[1])
    return 0
  `, { keys: [`${key}:cooldown`, `${key}:requests`, `${type}:ip:${digest(ip)}`], arguments: [String(RESEND_COOLDOWN)] });
  if (result > 0) throw Object.assign(authError('Demasiadas solicitudes. Espera antes de solicitar otro código.', 429, 'RATE_LIMITED'), { retryAfter: result });
};
const setVerificationCode = (email, code, type) => redisClient.set(codeKey(email, type), digest(code), { EX: CODE_EXPIRATION });
const getVerificationCode = (email, type) => redisClient.get(codeKey(email, type));
const deleteVerificationCode = (email, type) => redisClient.del(codeKey(email, type));
// Atomic compare/count/consume; attempt budget survives resend for its original 15-minute window.
const consumeVerificationCode = async (email, code, type) => {
  const key = codeKey(email, type);
  const result = await redisClient.eval(`
    local attempts = tonumber(redis.call('GET', KEYS[2]) or '0')
    if attempts >= tonumber(ARGV[2]) then return -2 end
    local stored = redis.call('GET', KEYS[1])
    if not stored then return -1 end
    if stored ~= ARGV[1] then
      attempts = redis.call('INCR', KEYS[2])
      if attempts == 1 then redis.call('EXPIRE', KEYS[2], ARGV[3]) end
      if attempts >= tonumber(ARGV[2]) then
        redis.call('DEL', KEYS[1])
        return -2
      end
      return tonumber(ARGV[2]) - attempts
    end
    redis.call('DEL', KEYS[1])
    return 0
  `, { keys: [key, `${key}:attempts`], arguments: [digest(code), String(MAX_ATTEMPTS), String(CODE_EXPIRATION)] });
  if (result === -1) throw authError('Código inválido o expirado', 400, 'CODE_EXPIRED');
  if (result === -2) throw authError('Demasiados intentos. Espera 15 minutos y solicita otro código.', 429, 'TOO_MANY_ATTEMPTS');
  if (result > 0) throw Object.assign(authError(`Código enviado es incorrecto. Intentos restantes: ${result}`), { attemptsRemaining: result });
  return true;
};
const createResetAuthorization = async user => {
  const token = crypto.randomBytes(32).toString('hex');
  await redisClient.set(`reset:authorization:${digest(token)}`, JSON.stringify({ uid: String(user._id), password: user.password }), { EX: RESET_EXPIRATION });
  return token;
};
const consumeResetAuthorization = async token => {
  const data = await redisClient.getDel(`reset:authorization:${digest(token)}`);
  if (!data) throw authError('La autorización de recuperación expiró o ya fue utilizada. Solicita otro código.', 400, 'RESET_EXPIRED');
  return JSON.parse(data);
};
module.exports = { CODE_EXPIRATION, RESET_EXPIRATION, RESEND_COOLDOWN, MAX_ATTEMPTS, normalizeEmail, authError,
  reserveCodeRequest, setVerificationCode, getVerificationCode, deleteVerificationCode, consumeVerificationCode,
  createResetAuthorization, consumeResetAuthorization };
