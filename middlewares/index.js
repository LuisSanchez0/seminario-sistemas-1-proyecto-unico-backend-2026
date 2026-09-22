const validateFields = require('./validate-fields');
const validateFiles = require('./validate-files');
const validateJWT = require('./validate-jwt');
const validateRole = require('./vallidate-role');


module.exports = {
    ...validateFields,
    ...validateFiles,
    ...validateJWT,
    ...validateRole,
}