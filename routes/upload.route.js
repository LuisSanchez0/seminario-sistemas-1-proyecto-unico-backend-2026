const { Router } = require('express');
const { check } = require('express-validator');

const { addImageToArray, addProductLogoToSell, removeImageFromArray, uploadSellFinishedInvoice, uploadSellFinishedShippingGuide } = require('../controllers/uploads.controller');

const { validateFields, validateFiles, validateJWT, isAdminRole } = require('../middlewares');

const { includedColection } = require('../helpers');

const router = Router();

//! Subir imagen de producto — solo ADMIN (debe ir antes de /:colection/:id)
router.post('/products/:id', [
  validateJWT,
  isAdminRole,
  validateFiles,
  check('id', 'El id no es válido').isMongoId(),
  validateFields,
], (req, res, next) => { req.params.colection = 'products'; next(); }, addImageToArray);

//! Logo de producto dentro de una venta — propietario de la venta (debe ir antes de /:colection/:id)
router.post('/sells/:id/product-logo', [
  validateJWT,
  validateFiles,
  check('id', 'El id no es válido').isMongoId(),
  check('lineItemId', 'lineItemId debe ser un ID de MongoDB válido').isMongoId(),
  validateFields,
], addProductLogoToSell);

//! Factura PDF de venta finalizada — solo ADMIN (debe ir antes de /:colection/:id)
router.post('/sell-finished/:id/invoice-pdf', [
  validateJWT,
  isAdminRole,
  validateFiles,
  check('id', 'El id no es válido').isMongoId(),
  validateFields,
], uploadSellFinishedInvoice);

//! Guía de envío de venta finalizada — solo ADMIN (debe ir antes de /:colection/:id)
router.post('/sell-finished/:id/shipping-guide', [
  validateJWT,
  isAdminRole,
  validateFiles,
  check('id', 'El id no es válido').isMongoId(),
  validateFields,
], uploadSellFinishedShippingGuide);

//! Agregar imagen a un modelo — propietario o admin según colección
router.post('/:colection/:id', [
  validateJWT,
  validateFiles,
  check('id', 'El id no es válido').isMongoId(),
  check('colection').custom(c => includedColection(c, ['users', 'sells'])),
  validateFields,
], addImageToArray);

//! Eliminar imagen de producto — solo ADMIN (debe ir antes de /:colection/:id)
router.delete('/products/:id', [
  validateJWT,
  isAdminRole,
  check('id', 'El id no es válido').isMongoId(),
  check('key', 'La key de la imagen es obligatoria').notEmpty().isString(),
  validateFields,
], (req, res, next) => { req.params.colection = 'products'; next(); }, removeImageFromArray);

//! Eliminar imagen de usuario — propietario o admin
router.delete('/:colection/:id', [
  validateJWT,
  check('id', 'El id no es válido').isMongoId(),
  check('colection').custom(c => includedColection(c, ['users'])),
  check('key', 'La key de la imagen es obligatoria').notEmpty().isString(),
  validateFields,
], removeImageFromArray);

module.exports = router;
