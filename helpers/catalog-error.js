const catalogErrorResponse = (res, error, message) => {
  if (error.code === 11000) {
    return res.status(409).json({ ok: false, msg: 'Ya existe un registro activo con ese nombre o slug' });
  }
  if (error.status === 400 || error.name === 'ValidationError' || error.name === 'CastError') {
    return res.status(400).json({ ok: false, msg: error.message });
  }
  console.error(message, error);
  return res.status(500).json({ ok: false, msg: message });
};

module.exports = { catalogErrorResponse };
