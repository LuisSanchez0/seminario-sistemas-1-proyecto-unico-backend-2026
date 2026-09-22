const { Router } = require('express');
const { body, param, query } = require('express-validator');
const { getProducts, getProductById, getProductBySlug, updateProduct, createProduct, getProductsWithStock, deleteProduct } = require('../controllers/products.controller');
const { PRODUCT_CATEGORIES } = require('../helpers/product-categories');
const { validateFields, validateJWT, isAdminRole } = require('../middlewares');

const router = Router();

const filters = () => [
    query('limit', 'El límite debe ser un entero positivo').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('offset', 'El offset debe ser un entero no negativo').optional().isInt({ min: 0 }).toInt(),
    query('category', 'La categoría no es válida').optional().isString().bail().isIn(PRODUCT_CATEGORIES),
    query('subcategory', 'La subcategoría debe ser un ID válido').optional().isString().bail().isMongoId(),
    query('brand', 'La marca debe ser un ID válido').optional().isString().bail().isMongoId(),
    validateFields,
];

const productFields = (partial = false) => {
    const field = name => partial ? body(name).optional() : body(name);
    return [
        field('title').isString().bail().trim().isLength({ min: 4 }).withMessage('El título debe contener al menos 4 caracteres'),
        field('price').custom(value => typeof value === 'number' && Number.isFinite(value) && value >= 0).withMessage('El precio debe ser un número no negativo'),
        field('description').isString().bail().isLength({ min: 10 }).withMessage('La descripción debe contener al menos 10 caracteres'),
        field('stock').custom(value => typeof value === 'number' && Number.isFinite(value) && value >= 0).withMessage('El stock debe ser un número no negativo'),
        field('slug').isString().bail().trim().isLength({ min: 3 }).withMessage('El slug debe contener al menos 3 caracteres'),
        field('category').isString().bail().isIn(PRODUCT_CATEGORIES).withMessage('La categoría no es válida'),
        field('subcategory').isString().bail().isMongoId().withMessage('La subcategoría debe ser un ID válido'),
        field('brand').isString().bail().isMongoId().withMessage('La marca debe ser un ID válido'),
        validateFields,
    ];
};

router.get('/', filters(), getProducts);
router.get('/stock', filters(), getProductsWithStock);
router.get('/slug/:slug', [param('slug').isString().trim().notEmpty(), validateFields], getProductBySlug);
router.get('/:id', [param('id', 'No es un ID válido').isMongoId(), validateFields], getProductById);
router.post('/', [validateJWT, isAdminRole, ...productFields()], createProduct);
router.patch('/:id', [validateJWT, isAdminRole, param('id', 'No es un ID válido').isMongoId(), ...productFields(true)], updateProduct);
router.delete('/:id', [validateJWT, isAdminRole, param('id', 'No es un ID válido').isMongoId(), validateFields], deleteProduct);

module.exports = router;
