const { response } = require('express');
const { Product } = require('../models');
const { getCache, setCache } = require('../helpers/db-redis-cache');
const { existingBrand, validateSubcategoryForCategory } = require('../helpers/db-validators');
const { PRODUCT_POPULATE, refreshProductCache } = require('../helpers/product-cache');
const { catalogErrorResponse } = require('../helpers/catalog-error');

const productData = body => {
  const data = {};
  for (const field of ['title', 'price', 'description', 'stock', 'slug', 'category', 'subcategory', 'brand']) {
    if (Object.prototype.hasOwnProperty.call(body, field)) data[field] = body[field];
  }
  return data;
};

const listProducts = async (req, res, withStock = false) => {
  try {
    const { limit = 5, offset = 0, category, subcategory, brand } = req.query;
    const query = { state: true };
    if (withStock) query.stock = { $gt: 0 };
    if (category) query.category = category;
    if (subcategory) query.subcategory = subcategory;
    if (brand) query.brand = brand;

    const key = `${Number(limit)}:${Number(offset)}:${category || 'ALL'}:${subcategory || 'ALL'}:${brand || 'ALL'}${withStock ? ':WITH_STOCK' : ''}`;
    const cached = await getCache('products', key);
    if (cached) return res.status(200).json(cached);

    const [count, products] = await Promise.all([
      Product.countDocuments(query),
      Product.find(query).sort({ _id: 1 }).limit(Number(limit)).skip(Number(offset)).populate(PRODUCT_POPULATE),
    ]);
    const data = { ok: true, count, pages: Math.ceil(count / Number(limit)), products: products.map(product => product.toJSON()) };
    await setCache('products', key, data, 300);
    return res.status(200).json(data);
  } catch (error) {
    return catalogErrorResponse(res, error, 'Error al obtener los productos');
  }
};

const getProducts = (req, res = response) => listProducts(req, res);
const getProductsWithStock = (req, res = response) => listProducts(req, res, true);

const findProduct = async (filter, key, res) => {
  try {
    const cached = await getCache('product', key);
    if (cached && cached.state === true) return res.status(200).json({ ok: true, ...cached });
    const product = await Product.findOne({ ...filter, state: true }).populate(PRODUCT_POPULATE);
    if (!product) return res.status(404).json({ ok: false, msg: 'No se encontró el producto' });
    const data = product.toJSON();
    await setCache('product', key, data, 300);
    return res.status(200).json({ ok: true, ...data });
  } catch (error) {
    return catalogErrorResponse(res, error, 'Error al obtener el producto');
  }
};

const getProductById = (req, res = response) => findProduct({ _id: req.params.id }, req.params.id, res);
const getProductBySlug = (req, res = response) => findProduct({ slug: req.params.slug }, req.params.slug, res);

const createProduct = async (req, res = response) => {
  try {
    const data = productData(req.body);
    await validateSubcategoryForCategory(data.subcategory, data.category);
    await existingBrand(data.brand);
    const product = new Product(data);
    await product.save();
    await refreshProductCache(product);
    return res.status(201).json({ ok: true, ...product.toJSON() });
  } catch (error) {
    return catalogErrorResponse(res, error, 'Error al crear el producto');
  }
};

const updateProduct = async (req, res = response) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, state: true });
    if (!product) return res.status(404).json({ ok: false, msg: 'No se encontró el producto activo' });
    const oldSlug = product.slug;
    product.set(productData(req.body));
    // Validar el resultado completo permite PATCH de solo categoría o subcategoría.
    await validateSubcategoryForCategory(product.subcategory, product.category);
    await existingBrand(product.brand);
    await product.save();
    await refreshProductCache(product, oldSlug);
    return res.status(200).json({ ok: true, ...product.toJSON() });
  } catch (error) {
    return catalogErrorResponse(res, error, 'Error al actualizar el producto');
  }
};

const deleteProduct = async (req, res = response) => {
  try {
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, state: true },
      { $set: { state: false } },
      { new: true, runValidators: true }
    );
    if (!product) return res.status(404).json({ ok: false, msg: 'No se encontró el producto activo' });
    await refreshProductCache(product);
    return res.status(200).json({ ok: true, msg: 'Producto eliminado correctamente' });
  } catch (error) {
    return catalogErrorResponse(res, error, 'Error al eliminar el producto');
  }
};

module.exports = { createProduct, getProducts, getProductsWithStock, getProductById, getProductBySlug, updateProduct, deleteProduct };
