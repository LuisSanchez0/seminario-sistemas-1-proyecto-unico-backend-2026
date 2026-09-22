const redisClient = require('../database/config-redis');

const CODE_EXPIRATION = 15 * 60; // segundos

const setVerificationCode = async (email, code, type) => {
    const key = `${type}:${email}`;
    // redis@5 usa set con objeto de opciones
    await redisClient.set(key, code, { EX: CODE_EXPIRATION });
};

const getVerificationCode = async (email, type) => {
    const key = `${type}:${email}`;
    return await redisClient.get(key);
};

const deleteVerificationCode = async (email, type) => {
    const key = `${type}:${email}`;
    await redisClient.del(key);
};

module.exports = {
    setVerificationCode,
    getVerificationCode,
    deleteVerificationCode
};