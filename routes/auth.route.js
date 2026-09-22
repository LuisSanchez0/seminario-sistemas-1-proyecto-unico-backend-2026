const { Router } = require('express');
const { check } = require('express-validator');

const { creatingNewUser,
        emailExists,
        googleAuth,
        login,
        revalidateToken,
        requestCode,
        verifyResetCode,
        verify2FACode,
        checkAuthStatus,} = require('../controllers/auth.controller');

const { existingGoogleUser,
        registerEmail,
        existingUser} = require('../helpers');

const { validateFields,
        validateJWT } = require('../middlewares');

const router = Router();

router.post('/login', [
    check('email', 'El email de ingreso es obligatorio').notEmpty(),
    check('email', 'El email ingresado no es valido').isEmail(),
    check('password', 'La contraseña es obligatoria').notEmpty(),
    check('email').custom( existingUser ),
    check('email').custom( existingGoogleUser ),
    validateFields
], login );

router.post('/google-sign-in', [
    check('id_token', 'El id_token es obligaotio para poder iniciar sesión con google'),
    validateFields
], googleAuth )

router.post('/register', [
    check('email', 'El email de ingreso es obligatorio').notEmpty(),
    check('email', 'El email ingresado no es valido').isEmail(),
    check('name', 'El nombre es obligatorio').notEmpty(),
    check('name', 'El nombre de usuario debe de tener al menos 3 caracteres').isLength( { min: 3 } ),
    check('password', 'El password es obligatorio y debe de contener al menos 4 caracteres').isLength( { min: 4 } ),
    check('email').custom( registerEmail ),
    check('email').custom( existingGoogleUser ),
    validateFields
], creatingNewUser );

router.get('/validate-email', [
    check('email', 'El email de ingreso es obligatorio').not().isEmpty(),
    check('email', 'El email ingresado no es valido').isEmail(),
    validateFields
], emailExists );

router.post('/request-code', [
    check('email', 'El email es obligatorio').not().isEmpty(),
    check('email', 'El email no es válido').isEmail(),
    check('type', 'El tipo de código es obligatorio').not().isEmpty(),
    check('type', 'El tipo de código no es válido').isIn(['2fa', 'reset']),
    validateFields,
], requestCode );

router.post('/2fa/verify', [
    check('email', 'El email es obligatorio').not().isEmpty(),
    check('email', 'El email no es válido').isEmail(),
    check('code', 'El código de verificación es obligatorio').not().isEmpty(),
    check('code', 'El código debe tener 8 dígitos').isLength({ min: 8, max: 8 }),
    validateFields,
], verify2FACode);

router.post('/password/verify-reset', [
    check('email', 'El email es obligatorio').not().isEmpty(),
    check('email', 'El email no es válido').isEmail(),
    check('code', 'El código de verificación es obligatorio').not().isEmpty(),
    check('code', 'El código debe tener 8 dígitos').isLength({ min: 8, max: 8 }),
    check('newPassword', 'La nueva contraseña debe tener al menos 4 caracteres').isLength({ min: 4 }),
    validateFields,
], verifyResetCode);

// Validar y revalidar token
router.get( '/check-status', validateJWT , revalidateToken  );

module.exports = router;