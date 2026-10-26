const bcrypt = require('bcryptjs');
const { User } = require('../models');
const { sendVerificationCode, validateCode } = require('../helpers/email-generator');
const { normalizeEmail, reserveCodeRequest, createResetAuthorization, consumeResetAuthorization,
  deleteVerificationCode, authError, RESET_EXPIRATION, RESEND_COOLDOWN } = require('../helpers/db-redis-codes');
const { setTimeout: delay } = require('node:timers/promises');
const safeMessage = 'Si la cuenta existe, enviaremos un código de recuperación.';
const failure = (res, error) => {
  if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
  return res.status(error.status || 500).json({ ok: false,
    msg: error.status ? error.message : 'Error en el servidor, intenta de nuevo más tarde.',
    ...(error.code && error.status ? { code: error.code } : {}),
    ...(error.attemptsRemaining !== undefined ? { attemptsRemaining: error.attemptsRemaining } : {}),
  });
};
// Support existing mixed-case accounts; escape input before a literal anchored lookup.
const account = email => User.findOne({ email: { $regex: `^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' }, state: true, google: false });
const requestRecovery = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const email = normalizeEmail(req.body.email);
    await reserveCodeRequest(email, 'reset', req.ip);
    const started = Date.now();
    const user = await account(email);
    if (user) {
      try { await sendVerificationCode(email, user.name, 'reset', { reserved: true }); }
      catch { /* Same response for unavailable accounts and email failures. Never log OTP/PII. */ }
    }
    await delay(Math.max(0, 500 - (Date.now() - started)));
    return res.json({ ok: true, msg: safeMessage, retryAfter: RESEND_COOLDOWN });
  } catch (error) { return failure(res, error); }
};
const verifyRecovery = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const email = normalizeEmail(req.body.email);
    await validateCode(email, req.body.code, 'reset');
    const user = await account(email);
    if (!user) throw authError('Código inválido o expirado');
    return res.json({ ok: true, resetToken: await createResetAuthorization(user), expiresIn: RESET_EXPIRATION });
  } catch (error) { return failure(res, error); }
};
const resetPassword = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    // Router validates policy before the single-use authorization is consumed.
    const authorization = await consumeResetAuthorization(req.body.resetToken);
    const password = await bcrypt.hash(req.body.newPassword, 10);
    // Compare-and-swap also invalidates concurrent authorizations against the old password.
    const user = await User.findOneAndUpdate({ _id: authorization.uid, password: authorization.password, state: true, google: false },
      { $set: { password } }, { returnDocument: 'after' });
    if (!user) throw authError('La autorización de recuperación expiró o ya fue utilizada.', 400, 'RESET_EXPIRED');
    await deleteVerificationCode(user.email, 'reset');
    return res.json({ ok: true, msg: 'Contraseña actualizada. Ya puedes iniciar sesión.' });
  } catch (error) { return failure(res, error); }
};
module.exports = { requestRecovery, verifyRecovery, resetPassword };
