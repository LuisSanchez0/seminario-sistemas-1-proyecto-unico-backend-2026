const { Router } = require('express');
const { param } = require('express-validator');
const controller = require('../controllers/reports.controller');
const { validateFields, validateJWT, isAdminRole } = require('../middlewares');
const { REPORT_TYPES } = require('../helpers/reports/filters');

const router = Router();

// Todo lo que cuelga de /api/admin exige sesión y rol de administrador (guardia en cada ruta).
const adminOnly = [validateJWT, isAdminRole];

const typeParam = param('type', `El reporte debe ser: ${REPORT_TYPES.join(', ')}`).isIn(REPORT_TYPES);

router.get('/dashboard', adminOnly, controller.getDashboard);
router.get('/reports/:type', [...adminOnly, typeParam, validateFields], controller.getReport);
router.get('/reports/:type/export', [...adminOnly, typeParam, validateFields], controller.downloadReport);

module.exports = router;
