// src/helpers/cache.helper.js
const redisClient = require('../database/config-redis');

const DEFAULT_TTL = 300;

const buildKey = (prefix, key) => (prefix ? `${prefix}:${key}` : key);
const toStr = (v) => (typeof v === 'string' ? v : String(v));
const hasWildcard = (s) => /[*?\[\]]/.test(s);

const setCache = async (prefix, key, value, ttl = DEFAULT_TTL) => {
  const fullKey = buildKey(prefix, toStr(key));
  const data = JSON.stringify(value);
  await redisClient.set(fullKey, data, { EX: ttl });
};

const getCache = async (prefix, key) => {
  const fullKey = buildKey(prefix, toStr(key));
  const data = await redisClient.get(fullKey);
  return data ? JSON.parse(data) : null;
};

const deleteCache = async (prefix, keyOrPattern = '*') => {
  try {
    if (!prefix || typeof prefix !== 'string') {
      console.error('deleteCache: prefijo inválido ->', prefix);
      return 0;
    }

    const kp = toStr(keyOrPattern);
    const fullKey = buildKey(prefix, kp);

    if (!hasWildcard(fullKey)) {
      const deleted = await redisClient.del(fullKey);
      return deleted;
    }

    const keys = [];

    for await (const key of redisClient.scanIterator({ MATCH: fullKey, COUNT: 100 })) {
      if (typeof key === 'string' && key.length > 0) {
        keys.push(key);
      }
    }

    if (keys.length === 0) {
      return 0;
    }

    const deleted = await redisClient.del(keys);
    return deleted;
  } catch (error) {
    console.error('Error in deleteCache:', error.message);
    return 0;
  }
};

const deleteCacheByPrefix = async (prefix) => {
  try {
    const keys = await redisClient.keys(`${prefix}:*`);
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
  } catch (err) {
    console.error(`[CACHE] Error clearing prefix "${prefix}":`, err);
  }
};

module.exports = {
  setCache,
  getCache,
  deleteCache,
  deleteCacheByPrefix
};