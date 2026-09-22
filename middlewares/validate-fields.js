const { validationResult } = require("express-validator");

const validateFields = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    const firstError = errors.array()[0]; // obtenemos el primer error
    return res.status(400).json({
      ok: false,
      msg: firstError.msg,  // solo el mensaje del primer error
    });
  }

  next();
};

module.exports = {
  validateFields,
};
