const { deleteCache, deleteCacheByPrefix, setCache } = require('./db-redis-cache');

const PRODUCT_POPULATE = [
  { path: 'subcategory', select: 'name slug category state' },
  { path: 'brand', select: 'name slug state' },
];

// Usar la misma representación en respuestas directas, listas y Redis.
const refreshProductCache = async (product, oldSlug) => {
  const id = product._id.toString();
  await deleteCache('product', id);
  for (const slug of new Set([oldSlug, product.slug].filter(Boolean))) {
    await deleteCache('product', slug);
  }
  await deleteCacheByPrefix('products');

  if (product.state) {
    await product.populate(PRODUCT_POPULATE);
    const data = product.toJSON();
    await setCache('product', id, data, 300);
    await setCache('product', product.slug, data, 300);
  }
};

// Los nombres/slugs poblados también aparecen en las cachés de productos.
const invalidateCatalogProductCache = async () => {
  await deleteCacheByPrefix('product');
  await deleteCacheByPrefix('products');
};

module.exports = { PRODUCT_POPULATE, refreshProductCache, invalidateCatalogProductCache };
