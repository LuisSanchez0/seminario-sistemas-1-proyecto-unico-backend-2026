const { Schema, model } = require('mongoose');

const AddressSchema = Schema({
    department: {
        type: String,
        required: [true, 'El departamento es obligatorio'],
        trim: true,
        maxlength: [60, 'El departamento no puede exceder los 60 caracteres'],
    },
    municipality: {
        type: String,
        required: [true, 'El municipio es obligatorio'],
        trim: true,
        maxlength: [60, 'El municipio no puede exceder los 60 caracteres'],
    },
    street: {
        type: String,
        trim: true,
        maxlength: [120, 'La calle no puede exceder los 120 caracteres'],
    },
    full_address: {
        type: String,
        required: [true, 'La dirección completa es obligatoria'],
        trim: true,
        maxlength: [250, 'La dirección completa no puede exceder los 250 caracteres'],
    },
    // Lo define la tienda, nunca el cliente: ninguna ruta lo acepta en el cuerpo.
    shipping_cost: {
        type: Number,
        default: 0,
        min: [0, 'El costo de envío no puede ser negativo'],
    },
    is_default: { type: Boolean, default: false },
    // false = dirección eliminada (los pedidos conservan su propia copia).
    state: { type: Boolean, default: true },
    phoneNumber: {
        type: String,
        required: [true, 'El número de teléfono es obligatorio'],
        match: [/^[0-9]{8}$/, 'El número de teléfono debe tener exactamente 8 dígitos numéricos'],
    },
    recipient: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: [true, 'El usuario al que está asociada la dirección es obligatorio'],
        index: true,
    },
});

AddressSchema.methods.toJSON = function () {
    const { __v, ...data } = this.toObject();
    return { ...data, id: data._id };
};

module.exports = model('Address', AddressSchema);
