const fs = require("fs");
const { response } = require("express");

const { uploadFile, deleteFile, getCache, setCache, deleteCache, deleteCacheByPrefix, processImageToWebp } = require("../helpers");
const { Product, User, Sell, SellFinished } = require("../models");
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
    case "sells":
      model = await Sell.findOne({ _id: id, isDeleted: false });
      if (model && model.buyerUser.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          ok: false,
          msg: "No tiene permiso para modificar esta venta",
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

    let updatedModel;

    if (colection === "sells") {
      updatedModel = await Sell.findOneAndUpdate(
        { _id: model._id, buyerUser: req.user._id, isDeleted: false },
        { imgBoleta: { key, url } },
        { new: true }
      );
      await deleteCache("sell", model._id.toString());
      await deleteCacheByPrefix("sells");
      await setCache("sell", model._id.toString(), updatedModel.toObject(), 300);
    } else {
      const newImage = { key, url };
      await model.constructor.updateOne(
        { _id: model._id },
        { $push: { images: newImage } }
      );
      updatedModel = await model.constructor.findById(model._id);

      if (colection === "products") {
        await refreshProductCache(updatedModel, model.slug);
      }
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

const addProductLogoToSell = async (req, res = response) => {
  const { id } = req.params;
  const { lineItemId } = req.body;

  const sell = await Sell.findOne({ _id: id, buyerUser: req.user._id, isDeleted: false });

  if (!sell) {
    return res.status(404).json({
      ok: false,
      msg: `No existe venta con id ${id}`,
    });
  }

  const productLine = sell.products.find(
    (p) => p._id.toString() === lineItemId
  );

  if (!productLine) {
    return res.status(404).json({
      ok: false,
      msg: `No se encontró la línea de producto con id ${lineItemId} en la venta`,
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

    const folder = "uploads/images/sells/products";
    const { key } = await uploadFile(processedFile, folder);

    const url = `${S3_BASE_URL}/${key}`;

    const updatedSell = await Sell.findOneAndUpdate(
      { _id: id, buyerUser: req.user._id, isDeleted: false, "products._id": lineItemId },
      { $set: { "products.$.imgLogo": { key, url } } },
      { new: true }
    );

    await deleteCache("sell", id);
    await deleteCacheByPrefix("sells");

    if (processedFile.tempFilePath && fs.existsSync(processedFile.tempFilePath)) {
      fs.unlinkSync(processedFile.tempFilePath);
    }

    res.json({
      ok: true,
      msg: "Logo del producto actualizado correctamente",
      sell: updatedSell,
    });
  } catch (err) {
    if (req.files?.archivo?.tempFilePath && fs.existsSync(req.files.archivo.tempFilePath)) {
      fs.unlinkSync(req.files.archivo.tempFilePath);
    }

    res.status(500).json({
      ok: false,
      msg: "Error al subir el logo del producto",
      error: err.message,
    });
  }
};

const uploadSellFinishedInvoice = async (req, res = response) => {
  const { id } = req.params;

  const sellFinished = await SellFinished.findById(id);
  if (!sellFinished) {
    return res.status(404).json({ ok: false, msg: `No existe venta finalizada con id ${id}` });
  }

  if (!req.files || !req.files.archivo) {
    return res.status(400).json({ ok: false, msg: "No hay archivos para subir" });
  }

  const file = req.files.archivo;
  if (file.mimetype !== "application/pdf") {
    return res.status(400).json({ ok: false, msg: "Solo se permiten archivos PDF" });
  }

  let newKey = null;
  try {
    const { key } = await uploadFile(file, "uploads/pdf/sell-finished");
    newKey = key;

    const oldKey = sellFinished.invoicePdf;
    sellFinished.invoicePdf = key;
    await sellFinished.save();

    if (oldKey) await deleteFile(oldKey).catch(() => {});

    res.json({ ok: true, msg: "Factura subida correctamente", sellFinished });
  } catch (err) {
    if (newKey) await deleteFile(newKey).catch(() => {});
    res.status(500).json({ ok: false, msg: "Error al subir la factura", error: err.message });
  }
};

const uploadSellFinishedShippingGuide = async (req, res = response) => {
  const { id } = req.params;

  const sellFinished = await SellFinished.findById(id);
  if (!sellFinished) {
    return res.status(404).json({ ok: false, msg: `No existe venta finalizada con id ${id}` });
  }

  if (!req.files || !req.files.archivo) {
    return res.status(400).json({ ok: false, msg: "No hay archivos para subir" });
  }

  const file = req.files.archivo;
  const allowedMimetypes = ["image/jpeg", "image/png", "image/webp"];
  if (!allowedMimetypes.includes(file.mimetype)) {
    return res.status(400).json({ ok: false, msg: "Solo se permiten imágenes (jpeg, png, webp)" });
  }

  let newKey = null;
  try {
    const { key } = await uploadFile(file, "uploads/images/sell-finished");
    newKey = key;

    const oldKey = sellFinished.shippingGuide;
    sellFinished.shippingGuide = key;
    await sellFinished.save();

    if (oldKey) await deleteFile(oldKey).catch(() => {});

    res.json({ ok: true, msg: "Guía de envío subida correctamente", sellFinished });
  } catch (err) {
    if (newKey) await deleteFile(newKey).catch(() => {});
    res.status(500).json({ ok: false, msg: "Error al subir la guía de envío", error: err.message });
  }
};

module.exports = {
  addImageToArray,
  addProductLogoToSell,
  removeImageFromArray,
  uploadSellFinishedInvoice,
  uploadSellFinishedShippingGuide,
};
