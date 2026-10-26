const { Router } = require('express');
const { body, param } = require('express-validator');
const {
    getAddresses, getAddressById, createAddress, updateAddress, deleteAddress,
} = require('../controllers/address.controller');
const { validateFields, validateJWT } = require('../middlewares');

const router = Router();

const text = (name, label, { min = 2, max, required = true } = {}) => {
    const field = required ? body(name) : body(name).optional();
    return field
        .isString().withMessage(`${label} debe ser texto`).bail()
        .trim().isLength({ min, max }).withMessage(`${label} debe tener entre ${min} y ${max} caracteres`);
};

const addressFields = (partial = false) => [
    text('department', 'El departamento', { max: 60, required: !partial }),
    text('municipality', 'El municipio', { max: 60, required: !partial }),
    body('street').optional({ values: 'null' }).isString().withMessage('La calle debe ser texto').bail()
        .trim().isLength({ max: 120 }).withMessage('La calle no puede exceder los 120 caracteres'),
    text('full_address', 'La dirección completa', { min: 5, max: 250, required: !partial }),
    (partial ? body('phoneNumber').optional() : body('phoneNumber'))
        .isString().bail().matches(/^[0-9]{8}$/)
        .withMessage('El número de teléfono debe tener exactamente 8 dígitos numéricos'),
    body('is_default').optional().isBoolean({ strict: true }).withMessage('is_default debe ser booleano'),
    validateFields,
];

const idParam = param('id', 'No es un ID válido').isMongoId();

router.get('/', [validateJWT], getAddresses);
router.post('/', [validateJWT, ...addressFields()], createAddress);
router.put('/delete/:id', [validateJWT, idParam, validateFields], deleteAddress);
router.get('/:id', [validateJWT, idParam, validateFields], getAddressById);
router.patch('/:id', [validateJWT, idParam, ...addressFields(true)], updateAddress);

module.exports = router;
