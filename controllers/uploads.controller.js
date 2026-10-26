const fs = require("fs");
const { response } = require("express");

const { uploadFile, deleteFile, processImageToWebp } = require("../helpers");
const { Product, User } = require("../models");
const { refreshProductCache } = require('../helpers/product-cache');

const S3_BASE_URL = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com`;

const addImageToArray = async (req, res = response) => {
  const { id, colection } = req.params;

  let model;
  switch (colection) {
    case "products":
      model = await Product.findOne({ _id: id, state: true });
      break;
    case "users":
      model = await User.findById(id);
      if (model && req.user._id.toString() !== id && req.user.role !== "ADMIN_ROLE") {
        return res.status(403).json({
          ok: false,
          msg: "No tiene permiso para modificar este usuario",
        });
      }
      break;
    default:
      return res.status(400).json({
        ok: false,
        msg: "Colección no permitida",
      });
  }

  if (!model) {
    return res.status(404).json({
      ok: false,
      msg: `No existe ${colection} con id ${id}`,
    });
  }

  try {
    if (!req.files || !req.files.archivo) {
      return res.status(400).json({
        ok: false,
        msg: "No hay archivos para subir",
      });
    }

    const processedFile = await processImageToWebp(req.files.archivo);

    const folder = `uploads/images/${colection}`;
    const { key } = await uploadFile(processedFile, folder);

    const url = `${S3_BASE_URL}/${key}`;

    const newImage = { key, url };
    await model.constructor.updateOne(
      { _id: model._id },
      { $push: { images: newImage } }
    );
    const updatedModel = await model.constructor.findById(model._id);

    if (colection === "products") {
      await refreshProductCache(updatedModel, model.slug);
    }

    if (processedFile.tempFilePath && fs.existsSync(processedFile.tempFilePath)) {
      fs.unlinkSync(processedFile.tempFilePath);
    }

    res.json({
      ok: true,
      msg: "Imagen convertida a WebP y agregada correctamente",
      model: updatedModel,
    });

  } catch (err) {
    if (req.files?.archivo?.tempFilePath && fs.existsSync(req.files.archivo.tempFilePath)) {
      fs.unlinkSync(req.files.archivo.tempFilePath);
    }

    res.status(500).json({
      ok: false,
      msg: "Error al subir la imagen",
      error: err.message,
    });
  }
};

const removeImageFromArray = async (req, res = response) => {
  const { id, colection } = req.params;
  const { key } = req.body;

  let model;
  switch (colection) {
    case "products":
      model = await Product.findOne({ _id: id, state: true });
      break;
    case "users":
      model = await User.findById(id);
      if (model && req.user._id.toString() !== id && req.user.role !== "ADMIN_ROLE") {
        return res.status(403).json({
          ok: false,
          msg: "No tiene permiso para modificar este usuario",
        });
      }
      break;
    default:
      return res.status(400).json({ ok: false, msg: "Colección no permitida" });
  }

  if (!model) {
    return res.status(404).json({
      ok: false,
      msg: `No existe ${colection} con id ${id}`,
    });
  }

  try {
    const imageIndex = model.images.findIndex((img) => img.key === key);
    if (imageIndex === -1) {
      return res.status(404).json({
        ok: false,
        msg: "La imagen no se encontró en el arreglo",
      });
    }

    await deleteFile(key);

    model.images.splice(imageIndex, 1);
    await model.save();

    if (colection === "products") {
      await refreshProductCache(model);
    }

    res.json({
      ok: true,
      msg: "Imagen eliminada correctamente",
      images: model.images,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      msg: "Error al eliminar la imagen",
      error: err.message,
    });
  }
};

const reorderProductImages = async (req, res = response) => {
  const { id } = req.params;
  const { keys } = req.body;

  const product = await Product.findOne({ _id: id, state: true });

  if (!product) {
    return res.status(404).json({
      ok: false,
      msg: `No existe el producto con id ${id}`,
    });
  }

  try {
    //! Solo se aceptan keys ya persistidas: nunca objetos de imagen del cliente.
    if (!Array.isArray(keys)) {
      return res.status(400).json({
        ok: false,
        msg: "keys debe ser un arreglo con las keys de las imágenes del producto",
      });
    }

    if (keys.some((key) => typeof key !== "string" || key.trim() === "")) {
      return res.status(400).json({
        ok: false,
        msg: "Cada key debe ser un texto no vacío",
      });
    }

    if (new Set(keys).size !== keys.length) {
      return res.status(400).json({
        ok: false,
        msg: "No se permiten keys de imagen duplicadas",
      });
    }

    //? El orden del arreglo es la fuente de verdad: images[0] es la portada del catálogo.
    const imagesByKey = new Map(product.images.map((image) => [image.key, image]));

    const unknownKey = keys.find((key) => !imagesByKey.has(key));
    if (unknownKey) {
      return res.status(400).json({
        ok: false,
        msg: `La key ${unknownKey} no pertenece a las imágenes del producto`,
      });
    }

    if (keys.length !== imagesByKey.size) {
      return res.status(400).json({
        ok: false,
        msg: `Se deben enviar exactamente las ${imagesByKey.size} keys de las imágenes del producto`,
      });
    }

    //* Validado el conjunto completo, se reordena conservando key y url persistidos.
    product.images = keys.map((key) => {
      const image = imagesByKey.get(key);
      return { _id: image._id, key: image.key, url: image.url };
    });
    await product.save();

    await refreshProductCache(product);

    res.json({
      ok: true,
      msg: "Orden de imágenes actualizado correctamente",
      model: product,
      images: product.images,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      msg: "Error al reordenar las imágenes",
      error: err.message,
    });
  }
};

module.exports = {
  addImageToArray,
  removeImageFromArray,
  reorderProductImages,
};
