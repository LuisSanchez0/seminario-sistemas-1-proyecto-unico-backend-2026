const mongoose = require('mongoose');
const { response } = require('express');
const { Address } = require('../models');
const { catalogErrorResponse } = require('../helpers/catalog-error');

const MAX_ADDRESSES = 10;
const FIELDS = ['department', 'municipality', 'street', 'full_address', 'phoneNumber', 'is_default'];

const addressData = body => {
    const data = {};
    for (const field of FIELDS) {
        if (Object.prototype.hasOwnProperty.call(body, field)) data[field] = body[field];
    }
    return data;
};

const notFound = res => res.status(404).json({ ok: false, msg: 'No se encontró la dirección' });

const getAddresses = async (req, res = response) => {
    try {
        const addresses = await Address.find({ recipient: req.user._id, state: true })
            .sort({ is_default: -1, _id: -1 });
        return res.status(200).json({ ok: true, addresses });
    } catch (error) {
        return catalogErrorResponse(res, error, 'Error al obtener las direcciones');
    }
};

const getAddressById = async (req, res = response) => {
    try {
        const address = await Address.findOne({ _id: req.params.id, recipient: req.user._id, state: true });
        if (!address) return notFound(res);
        return res.status(200).json({ ok: true, address });
    } catch (error) {
        return catalogErrorResponse(res, error, 'Error al obtener la dirección');
    }
};

const createAddress = async (req, res = response) => {
    try {
        const data = addressData(req.body);
        const address = await mongoose.connection.transaction(async session => {
            const active = await Address.find({ recipient: req.user._id, state: true }).session(session);
            if (active.length >= MAX_ADDRESSES) {
                throw Object.assign(new Error(`Solo puedes guardar hasta ${MAX_ADDRESSES} direcciones`), { status: 409 });
            }
            // La primera dirección siempre queda como predeterminada.
            const isDefault = active.length === 0 || data.is_default === true;
            if (isDefault) {
                await Address.updateMany({ recipient: req.user._id, state: true }, { $set: { is_default: false } }, { session });
            }
            const [created] = await Address.create([{ ...data, is_default: isDefault, recipient: req.user._id }], { session });
            return created;
        });
        return res.status(201).json({ ok: true, address });
    } catch (error) {
        if (error.status === 409) return res.status(409).json({ ok: false, msg: error.message });
        return catalogErrorResponse(res, error, 'Error al crear la dirección');
    }
};

const updateAddress = async (req, res = response) => {
    try {
        const data = addressData(req.body);
        const address = await mongoose.connection.transaction(async session => {
            const current = await Address.findOne({ _id: req.params.id, recipient: req.user._id, state: true }).session(session);
            if (!current) return null;
            // Quitar la marca de predeterminada sin elegir otra dejaría al cliente sin predeterminada.
            if (data.is_default === false && current.is_default) delete data.is_default;
            if (data.is_default === true) {
                await Address.updateMany(
                    { recipient: req.user._id, state: true, _id: { $ne: current._id } },
                    { $set: { is_default: false } },
                    { session },
                );
            }
            current.set(data);
            await current.save({ session });
            return current;
        });
        if (!address) return notFound(res);
        return res.status(200).json({ ok: true, address });
    } catch (error) {
        return catalogErrorResponse(res, error, 'Error al actualizar la dirección');
    }
};

const deleteAddress = async (req, res = response) => {
    try {
        const removed = await mongoose.connection.transaction(async session => {
            const address = await Address.findOneAndUpdate(
                { _id: req.params.id, recipient: req.user._id, state: true },
                { $set: { state: false, is_default: false } },
                { returnDocument: 'before', session },
            );
            if (!address) return false;
            if (address.is_default) {
                const next = await Address.findOne({ recipient: req.user._id, state: true }).sort({ _id: -1 }).session(session);
                if (next) await Address.updateOne({ _id: next._id }, { $set: { is_default: true } }, { session });
            }
            return true;
        });
        if (!removed) return notFound(res);
        return res.status(200).json({ ok: true, msg: 'Dirección eliminada correctamente' });
    } catch (error) {
        return catalogErrorResponse(res, error, 'Error al eliminar la dirección');
    }
};

module.exports = { getAddresses, getAddressById, createAddress, updateAddress, deleteAddress };
