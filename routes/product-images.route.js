const { Router } = require('express');
const { body, param } = require('express-validator');
const { addImageToArray, removeImageFromArray, reorderProductImages } = require('../controllers/uploads.controller');
const { validateFields, validateFiles, validateJWT, isAdminRole } = require('../middlewares');
const { uniqueImageKeys } = require('../helpers/db-validators');

const router = Router();
const productCollection = (req, res, next) => {
    req.params.colection = 'products';
    next();
};

//! Reordenar las imágenes de un producto — solo ADMIN (debe ir antes de /:id)
router.patch('/:id/images/order', [
    validateJWT,
    isAdminRole,
    param('id', 'El id no es válido').isMongoId(),
    body('keys', 'keys debe ser un arreglo con las keys de las imágenes del producto').isArray(),
    body('keys.*', 'Cada key debe ser un texto no vacío').isString().bail().notEmpty(),
    body('keys').custom(uniqueImageKeys),
    validateFields,
    productCollection,
], reorderProductImages);

router.post('/:id', [validateJWT, isAdminRole, validateFiles, param('id').isMongoId(), validateFields, productCollection], addImageToArray);
router.delete('/:id', [validateJWT, isAdminRole, param('id').isMongoId(), body('key').isString().bail().notEmpty(), validateFields, productCollection], removeImageFromArray);

module.exports = router;
