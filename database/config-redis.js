const { createClient } = require('redis');

const redisClient = createClient({
  url: process.env.REDIS_URL
});

redisClient.on('connect', () => console.log('Conectado a Redis'));
redisClient.on('error', (err) => console.error('Error en Redis:', err));

(async () => {
  if (!redisClient.isOpen) await redisClient.connect();
})();

module.exports = redisClient;