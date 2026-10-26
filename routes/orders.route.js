const { Router } = require('express');
const { body, param, query } = require('express-validator');
const controller = require('../controllers/orders.controller');
const { validateFields, validateFiles, validateJWT, isAdminRole } = require('../middlewares');
const { PAYMENT_STATES, ORDER_STATES, SHIPPING_STATUSES, PAYMENT_METHODS, ORDER_FILTERS } = require('../helpers/order-states');

const router = Router();

const idParam = param('id', 'No es un ID válido').isMongoId();
const integer = (value, min, max) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

const pagination = [
    query('limit', 'El límite debe ser un entero entre 1 y 50').optional().isInt({ min: 1, max: 50 }),
    query('offset', 'El offset debe ser un entero no negativo').optional().isInt({ min: 0 }),
];

const checkoutRules = [
    body('items', 'El pedido debe incluir entre 1 y 50 productos').isArray({ min: 1, max: 50 }),
    body('items.*.product', 'Cada producto debe tener un ID válido').isString().bail().isMongoId(),
    body('items.*.quantity', 'La cantidad de cada producto debe ser un entero entre 1 y 999')
        .custom(value => integer(value, 1, 999)),
    body('shippingAddress', 'Selecciona una dirección de envío válida').isString().bail().isMongoId(),
    body('paymentMethod', `El método de pago debe ser ${PAYMENT_METHODS.join(' o ')}`).isIn(PAYMENT_METHODS),
    body('nit', 'El NIT no tiene un formato válido').optional({ values: 'falsy' })
        .isString().bail().matches(/^(CF|[0-9]+-?[0-9K])$/i),
    body('notes', 'Las notas no pueden exceder los 500 caracteres').optional({ values: 'falsy' })
        .isString().bail().isLength({ max: 500 }),
    body('checkoutKey', 'La llave de checkout no es válida').optional()
        .isString().bail().matches(/^[A-Za-z0-9_-]{8,80}$/),
];

// ── Administración (antes de /:id para que "admin" no se tome como un ID) ──
router.get('/admin', [
    validateJWT, isAdminRole,
    ...pagination,
    query('orderCode').optional().isString().isLength({ max: 40 }),
    query('customer').optional().isString().isLength({ max: 80 }),
    query('paymentState', 'El estado de pago no es válido').optional().isString().bail().isIn(PAYMENT_STATES),
    query('orderState', 'El estado del pedido no es válido').optional().isString().bail().isIn(ORDER_STATES),
    query('startDate', 'La fecha inicial no es válida').optional().isString(),
    query('endDate', 'La fecha final no es válida').optional().isString(),
    validateFields,
], controller.listAdmin);

router.get('/admin/:id', [validateJWT, isAdminRole, idParam, validateFields], controller.getAdmin);

router.patch('/admin/:id/payment-state', [
    validateJWT, isAdminRole, idParam,
    body('paymentState', 'El estado de pago no es válido').isString().bail().isIn(PAYMENT_STATES),
    body('paymentReference', 'La referencia de pago no puede exceder los 120 caracteres').optional({ values: 'falsy' })
        .isString().bail().trim().isLength({ max: 120 }),
    body('reason', 'El motivo no puede exceder los 300 caracteres').optional({ values: 'falsy' })
        .isString().bail().trim().isLength({ max: 300 }),
    validateFields,
], controller.setPaymentState);

router.patch('/admin/:id/shipping-status', [
    validateJWT, isAdminRole, idParam,
    body('items', 'Envía entre 1 y 50 productos a actualizar').isArray({ min: 1, max: 50 }),
    body('items.*.itemId', 'Cada producto debe tener un ID válido').isString().bail().isMongoId(),
    body('items.*.shippingStatus', 'El estado de envío no es válido').isString().bail().isIn(SHIPPING_STATUSES),
    body('items').custom(items => new Set(items.map(item => item.itemId)).size === items.length)
        .withMessage('No se puede actualizar el mismo producto dos veces en una solicitud'),
    validateFields,
], controller.setShippingStatus);

// ── Cliente ──
router.post('/', [validateJWT, ...checkoutRules, validateFields], controller.create);

router.get('/mine', [
    validateJWT,
    ...pagination,
    query('filter', `El filtro debe ser: ${Object.keys(ORDER_FILTERS).join(', ')}`).optional()
        .isString().bail().isIn(Object.keys(ORDER_FILTERS)),
    validateFields,
], controller.listMine);

router.get('/:id', [validateJWT, idParam, validateFields], controller.getMine);

router.post('/:id/cancel', [
    validateJWT, idParam,
    body('reason', 'El motivo no puede exceder los 300 caracteres').optional({ values: 'falsy' })
        .isString().bail().trim().isLength({ max: 300 }),
    validateFields,
], controller.cancelMine);

router.post('/:id/payment-receipt', [validateJWT, idParam, validateFields, validateFiles], controller.uploadReceipt);

module.exports = router;
