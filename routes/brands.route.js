const { Router } = require('express');
const { body, param } = require('express-validator');
const { getBrands, getBrandById, createBrand, updateBrand, deleteBrand } = require('../controllers/brands.controller');
const { validateFields, validateJWT, isAdminRole } = require('../middlewares');

const router = Router();
const brandFields = (partial = false) => {
    const field = name => partial ? body(name).optional() : body(name);
    return [
        field('name').isString().bail().trim().notEmpty().withMessage('El nombre de la marca es obligatorio'),
        field('slug').isString().bail().trim().notEmpty().withMessage('El slug de la marca es obligatorio'),
        validateFields,
    ];
};
const idField = () => param('id', 'No es un ID válido').isMongoId();

router.get('/', getBrands);
router.get('/:id', [idField(), validateFields], getBrandById);
router.post('/', [validateJWT, isAdminRole, ...brandFields()], createBrand);
router.patch('/:id', [validateJWT, isAdminRole, idField(), ...brandFields(true)], updateBrand);
router.delete('/:id', [validateJWT, isAdminRole, idField(), validateFields], deleteBrand);

module.exports = router;
