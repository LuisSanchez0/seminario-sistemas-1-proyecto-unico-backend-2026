const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

const redisClient = createClient({
  url: REDIS_URL
});

redisClient.on('connect', () => console.log('Conectado a Redis:', REDIS_URL));
redisClient.on('error', (err) => console.error('Error en Redis:', err.code || err.message || err));

(async () => {
  try {
    if (!redisClient.isOpen) await redisClient.connect();
  } catch (err) {
    console.error(`No se pudo conectar a Redis (${REDIS_URL}):`, err.code || err.message || err);
  }
})();

module.exports = redisClient;
