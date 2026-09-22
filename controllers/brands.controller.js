const { response } = require('express');
const { Brand, Product } = require('../models');
const { invalidateCatalogProductCache } = require('../helpers/product-cache');
const { catalogErrorResponse } = require('../helpers/catalog-error');

const getBrands = async (req, res = response) => {
  try {
    const brands = await Brand.find({ state: true }).sort({ name: 1 });
    return res.json({ ok: true, brands });
  } catch (error) {
    return catalogErrorResponse(res, error, 'Error al obtener las marcas');
  }
};

const getBrandById = async (req, res = response) => {
  try {
    const brand = await Brand.findOne({ _id: req.params.id, state: true });
    if (!brand) return res.status(404).json({ ok: false, msg: 'No se encontró la marca activa' });
    return res.json({ ok: true, brand });
  } catch (error) {
    return catalogErrorResponse(res, error, 'Error al obtener la marca');
  }
};

const createBrand = async (req, res = response) => {
  try {
    const { name, slug } = req.body;
    const brand = new Brand({ name, slug });
    await brand.save();
    return res.status(201).json({ ok: true, brand });
  } catch (error) {
    return catalogErrorResponse(res, error, 'Error al crear la marca');
  }
};

const updateBrand = async (req, res = response) => {
  try {
    const brand = await Brand.findOne({ _id: req.params.id, state: true });
    if (!brand) return res.status(404).json({ ok: false, msg: 'No se encontró la marca activa' });
    for (const field of ['name', 'slug']) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) brand[field] = req.body[field];
    }
    await brand.save();
    await invalidateCatalogProductCache();
    return res.json({ ok: true, brand });
  } catch (error) {
    return catalogErrorResponse(res, error, 'Error al actualizar la marca');
  }
};

const deleteBrand = async (req, res = response) => {
  try {
    const brand = await Brand.findOne({ _id: req.params.id, state: true });
    if (!brand) return res.status(404).json({ ok: false, msg: 'No se encontró la marca activa' });
    if (await Product.exists({ brand: brand._id, state: true })) {
      return res.status(409).json({ ok: false, msg: 'No se puede eliminar la marca porque existen productos asociados' });
    }
    brand.state = false;
    await brand.save();
    await invalidateCatalogProductCache();
    return res.json({ ok: true, msg: 'Marca eliminada correctamente' });
  } catch (error) {
    return catalogErrorResponse(res, error, 'Error al eliminar la marca');
  }
};

module.exports = { getBrands, getBrandById, createBrand, updateBrand, deleteBrand };
