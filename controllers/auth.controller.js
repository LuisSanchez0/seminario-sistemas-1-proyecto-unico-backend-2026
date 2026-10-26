const { response, request } = require("express");
const bcryptjs = require("bcryptjs");

const { User } = require("../models");
const {
  generateJWT,
  googleVerify,
  sendVerificationCode,
  validateCode,
} = require("../helpers");

const revalidateToken = async (req, res = response) => {
  try {
    const user = req.user;
    const token = await generateJWT(user._id);

    return res.status(200).json({
      ok: true,
      user,
      token,
    });
  } catch (err) {
    return res.status(500).json({
      msg: "Error en el servidor, contacte a administración",
      ok: false,
    });
  }
  //! Generation JWT
};

const creatingNewUser = async (req, res = response) => {
  //!Extrayendo data de la request
  try {
    const { email, password, name } = req.body;

    const user = new User({ email, password, name });

    //!Encriptando la contraseña
    const salt = bcryptjs.genSaltSync();
    user.password = bcryptjs.hashSync(password, salt);

    //!Guardando el usuario
    await user.save();

    //!Generando el JWT
    const token = await generateJWT(user._id);

    return res.status(201).json({
      ok: true,
      user,
      token,
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({
      msg: "Error en el servidor, contacte a administración",
      ok: false,
    });
  }
};

const emailExists = async (req, res = response) => {
  const { email } = req.query;

  try {
    const user = await User.findOne({ email });
    if (user) {
      return res.status(400).json({
        msg: "El email ingresado, ya esta asociado a otra cuenta",
        ok: false,
      });
    }

    return res.status(200).json({
      ok: true,
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({
      ok: false,
      msg: "Error en el servidor, contacte a administración",
    });
  }
};

const login = async (req = request, res = response) => {
  try {
    const { email, password } = req.body;

    //!Verifico si el email ya esta registrado
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(400).json({
        msg: "El emaiil ingresado no existe",
        ok: false,
      });
    }

    //?Si el usuario existe
    if (!user.state) {
      return res.status(401).json({
        msg: "El usuario ya no tiene acceso al sistema",
        ok: false,
      });
    }

    //!Validar la constraseña
    const validPassword = bcryptjs.compareSync(password, user.password);

    if (!validPassword) {
      return res.status(400).json({
        msg: "La contraseña ingresada no es correcta",
        ok: false,
      });
    }

    //*Generar el JWT
    const token = await generateJWT(user.id);

    res.json({
      user,
      token,
      ok: true,
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({
      msg: "Error en el servidor, contacte a administración",
      ok: false,
    });
  }
};

const googleAuth = async (req = request, res = response) => {
  const { id_token } = req.body;

  try {
    //!Extraemos el correo y el nombre de la paersona de google
    const { email, name } = await googleVerify(id_token);

    //? Buscamos si existe el usuario registrado
    let user = await User.findOne({ email });

    if (user) {
      //!Verificamos si el usuario no fue creado a traves de una cuenta de Google
      if (!user.google) {
        return res.status(400).json({
          ok: false,
          msg: "Ya existe una cuenta con este email. Por favor, inicia sesión de la forma habitual.",
        });
      }

      //!Comprobomas si este aun tiene acceso al sistema
      if (!user.state) {
        return res.status(401).json({
          ok: false,
          msg: "El acceso a su cuenta ha sido deshabilitado. Por favor, contacte a soporte técnico.",
        });
      }

      //!Si este ya fue registrado con google, solo lo logueamos
      const token = await generateJWT(user.id);
      return res.status(200).json({
        ok: true,
        user,
        token,
      });
    } else {
      const newUser = new User({
        email,
        password: require("node:crypto").randomBytes(32).toString("hex"),
        name,
        google: true,
        isAuthenticated: true
      });
      const salt = bcryptjs.genSaltSync();
      newUser.password = bcryptjs.hashSync(newUser.password, salt);

      await newUser.save();

      const token = await generateJWT(newUser.id);

      return res.status(201).json({
        ok: true,
        user: newUser,
        token,
      });
    }
  } catch (err) {
    console.log(err);
    return res.status(500).json({
      msg: "Error en el servidor, contacte a administración",
      ok: false,
    });
  }
};

const requestCode = async (req = request, res = response) => {
  const { email, type } = req.body;
  if (type === "reset") return require("./password-recovery.controller").requestRecovery(req, res);

  if (!type)
    return res.status(400).json({
      ok: false,
      msg: "Tipo de código no especificado",
    });

  //! Verificamos si el usuario existe
  const user = await User.findOne({ email });
  if (!user) {
    return res.status(400).json({
      ok: false,
      msg: "Usuario no encontrado",
    });
  }

  try {
    if (type === "2fa") {
      await sendVerificationCode(email, user.name, "2fa", { ip: req.ip });
      res.json({
        ok: true,
        msg: "Código 2FA enviado a tu correo",
      });
    }
  } catch (error) {
    if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
    res.status(error.status || 500).json({
      ok: false,
      msg: error.status ? error.message : "Error al enviar el correo",
    });
  }
};

const verify2FACode = async (req, res) => {
  const { email, code } = req.body;

  const user = await User.findOne({ email });
  if (!user)
    return res.status(400).json({
      ok: false,
      msg: "Usuario no encontrado",
    });

  try {
    await validateCode(email, code, "2fa");

    //!Validamos que el usuario se autentico
    const newUser = await User.findByIdAndUpdate(user._id, {
      isAuthenticated: true,
    });
    res.json({
      user: newUser,
      ok: true,
      msg: "Código 2FA válido",
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      msg: error.message,
    });
  }
};

module.exports = {
  creatingNewUser,
  emailExists,
  googleAuth,
  login,
  requestCode,
  revalidateToken,
  verify2FACode,
};
