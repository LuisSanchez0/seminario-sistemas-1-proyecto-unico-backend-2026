const dbValidators = require('./db-validators');
const dbRedisCache = require('./db-redis-cache');
const emailGenerator = require('./email-generator');
const generateJWT = require('./generate-jwt');
const googleVerify = require('./google-verify');
const imageProcessor = require('./image-processor');
const s3 = require('./s3');

module.exports = {
    ...dbValidators,
    ...dbRedisCache,
    ...emailGenerator,
    ...generateJWT,
    ...googleVerify,
    ...imageProcessor,
    ...s3,
}