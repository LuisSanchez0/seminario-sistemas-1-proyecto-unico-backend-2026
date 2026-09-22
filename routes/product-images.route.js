const { Router } = require('express');
const { body, param } = require('express-validator');
const { addImageToArray, removeImageFromArray } = require('../controllers/uploads.controller');
const { validateFields, validateFiles, validateJWT, isAdminRole } = require('../middlewares');

const router = Router();
const productCollection = (req, res, next) => {
    req.params.colection = 'products';
    next();
};

router.post('/:id', [validateJWT, isAdminRole, validateFiles, param('id').isMongoId(), validateFields, productCollection], addImageToArray);
router.delete('/:id', [validateJWT, isAdminRole, param('id').isMongoId(), body('key').isString().bail().notEmpty(), validateFields, productCollection], removeImageFromArray);

module.exports = router;
