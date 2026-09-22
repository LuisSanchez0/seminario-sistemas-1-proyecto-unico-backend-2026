const { request, response } = require('express');
const jwt = require('jsonwebtoken');
const { User } = require('../models');

const validateJWT = async (req = request, res = response, next) => {
  try {
    const authHeader = req.header('Authorization');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        ok: false,
        msg: 'Token no enviado en el encabezado Authorization',
      });
    }

    const token = authHeader.split(' ')[1];

    let payload;
    try {
      payload = jwt.verify(token, process.env.SECRETEORPRIVATEKEY);
    } catch (err) {
      const msg = err.name === 'TokenExpiredError'
        ? 'Token expirado, por favor vuelve a iniciar sesión'
        : 'Token inválido';
      return res.status(401).json({ ok: false, msg });
    }

    const { uid } = payload;
   
    const user = await User.findById(uid);
    if (!user) {
      return res.status(401).json({
        ok: false,
        msg: 'Token no válido - usuario no existe en la base de datos',
      });
    }

    if (!user.state) {
      return res.status(401).json({
        ok: false,
        msg: 'Token no válido - usuario desactivado',
      });
    }

    req.user = user;
    next();

  } catch (err) {
    console.error('Error inesperado en validateJWT:', err.message);
    return res.status(500).json({
      ok: false,
      msg: 'Error interno del servidor al validar JWT',
    });
  }
};

module.exports = { validateJWT };
