const { Schema, model } = require('mongoose');
const { PRODUCT_CATEGORIES } = require('../helpers/product-categories');

const ProductSchema = Schema({
    title: {
        type: String,
        required: [true, 'El nombre del producto es obligatorio'],
        minlength: [4, 'El nombre del producto debe contener como mínimo 4 caracteres'],
        trim: true,
    },
    price: {
        type: Number,
        required: [true, 'El precio del producto es obligatorio'],
        min: [0, 'El precio no puede ser negativo'],
    },
    description: {
        type: String,
        required: [true, 'La descripción del producto es obligatoria'],
        minlength: [10, 'La descripción debe contener como mínimo 10 caracteres'],
    },
    stock: {
        type: Number,
        required: [true, 'El stock del producto es obligatorio'],
        min: [0, 'El stock no puede ser negativo'],
        default: 0,
    },
    slug: {
        type: String,
        required: [true, 'El slug del producto es obligatorio'],
        minlength: [3, 'El slug debe tener como mínimo 3 caracteres'],
        trim: true,
    },
    category: {
        type: String,
        required: [true, 'La categoría del producto es obligatoria'],
        enum: PRODUCT_CATEGORIES,
    },
    subcategory: {
        type: Schema.Types.ObjectId,
        ref: 'Subcategory',
        required: [true, 'La subcategoría del producto es obligatoria'],
    },
    brand: {
        type: Schema.Types.ObjectId,
        ref: 'Brand',
        required: [true, 'La marca del producto es obligatoria'],
    },
    images: [{ key: String, url: String }],
    state: { type: Boolean, default: true },
});

ProductSchema.methods.toJSON = function () {
    const { __v, ...data } = this.toObject({ virtuals: true });
    return data;
};

module.exports = model('Product', ProductSchema);
