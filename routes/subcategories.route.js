const { Router } = require('express');
const { body, param, query } = require('express-validator');
const { getSubcategories, getSubcategoryById, createSubcategory, updateSubcategory, deleteSubcategory } = require('../controllers/subcategories.controller');
const { PRODUCT_CATEGORIES } = require('../helpers/product-categories');
const { validateFields, validateJWT, isAdminRole } = require('../middlewares');

const router = Router();
const subcategoryFields = (partial = false) => {
    const field = name => partial ? body(name).optional() : body(name);
    return [
        field('name').isString().bail().trim().notEmpty().withMessage('El nombre de la subcategoría es obligatorio'),
        field('slug').isString().bail().trim().notEmpty().withMessage('El slug de la subcategoría es obligatorio'),
        field('category').isString().bail().isIn(PRODUCT_CATEGORIES).withMessage('La categoría no es válida'),
        validateFields,
    ];
};
const idField = () => param('id', 'No es un ID válido').isMongoId();

router.get('/', [query('category', 'La categoría no es válida').optional().isString().bail().isIn(PRODUCT_CATEGORIES), validateFields], getSubcategories);
router.get('/category/:category', [param('category', 'La categoría no es válida').isIn(PRODUCT_CATEGORIES), validateFields], getSubcategories);
router.get('/:id', [idField(), validateFields], getSubcategoryById);
router.post('/', [validateJWT, isAdminRole, ...subcategoryFields()], createSubcategory);
router.patch('/:id', [validateJWT, isAdminRole, idField(), ...subcategoryFields(true)], updateSubcategory);
router.delete('/:id', [validateJWT, isAdminRole, idField(), validateFields], deleteSubcategory);

module.exports = router;
