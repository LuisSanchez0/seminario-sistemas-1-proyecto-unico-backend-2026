const { response } = require('express');
const { Subcategory, Product } = require('../models');
const { invalidateCatalogProductCache } = require('../helpers/product-cache');
const { catalogErrorResponse } = require('../helpers/catalog-error');

// Sirve tanto /?category=... como /category/:category.
const getSubcategories = async (req, res = response) => {
  try {
    const category = req.params.category || req.query.category;
    const query = { state: true };
    if (category) query.category = category;
    const subcategories = await Subcategory.find(query).sort({ name: 1 });
    return res.json({ ok: true, subcategories });
  } catch (error) {
    return catalogErrorResponse(res, error, 'Error al obtener las subcategorías');
  }
};

const getSubcategoryById = async (req, res = response) => {
  try {
    const subcategory = await Subcategory.findOne({ _id: req.params.id, state: true });
    if (!subcategory) return res.status(404).json({ ok: false, msg: 'No se encontró la subcategoría activa' });
    return res.json({ ok: true, subcategory });
  } catch (error) {
    return catalogErrorResponse(res, error, 'Error al obtener la subcategoría');
  }
};

const createSubcategory = async (req, res = response) => {
  try {
    const { name, slug, category } = req.body;
    const subcategory = new Subcategory({ name, slug, category });
    await subcategory.save();
    return res.status(201).json({ ok: true, subcategory });
  } catch (error) {
    return catalogErrorResponse(res, error, 'Error al crear la subcategoría');
  }
};

const updateSubcategory = async (req, res = response) => {
  try {
    const subcategory = await Subcategory.findOne({ _id: req.params.id, state: true });
    if (!subcategory) return res.status(404).json({ ok: false, msg: 'No se encontró la subcategoría activa' });
    if (req.body.category !== undefined && req.body.category !== subcategory.category &&
        await Product.exists({ subcategory: subcategory._id, state: true })) {
      return res.status(409).json({ ok: false, msg: 'No se puede cambiar la categoría porque existen productos asociados' });
    }
    for (const field of ['name', 'slug', 'category']) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) subcategory[field] = req.body[field];
    }
    await subcategory.save();
    await invalidateCatalogProductCache();
    return res.json({ ok: true, subcategory });
  } catch (error) {
    return catalogErrorResponse(res, error, 'Error al actualizar la subcategoría');
  }
};

const deleteSubcategory = async (req, res = response) => {
  try {
    const subcategory = await Subcategory.findOne({ _id: req.params.id, state: true });
    if (!subcategory) return res.status(404).json({ ok: false, msg: 'No se encontró la subcategoría activa' });
    if (await Product.exists({ subcategory: subcategory._id, state: true })) {
      return res.status(409).json({ ok: false, msg: 'No se puede eliminar la subcategoría porque existen productos asociados' });
    }
    subcategory.state = false;
    await subcategory.save();
    await invalidateCatalogProductCache();
    return res.json({ ok: true, msg: 'Subcategoría eliminada correctamente' });
  } catch (error) {
    return catalogErrorResponse(res, error, 'Error al eliminar la subcategoría');
  }
};

module.exports = { getSubcategories, getSubcategoryById, createSubcategory, updateSubcategory, deleteSubcategory };
