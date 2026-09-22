const { Schema, model } = require('mongoose');
const { PRODUCT_CATEGORIES } = require('../helpers/product-categories');
const { normalizeCatalogName, CATALOG_COLLATION } = require('../helpers/catalog-normalization');

const SubcategorySchema = Schema({
    name: {
        type: String,
        required: [true, 'El nombre de la subcategoría es obligatorio'],
        trim: true,
        set: normalizeCatalogName,
    },
    category: {
        type: String,
        required: [true, 'La categoría padre es obligatoria'],
        enum: PRODUCT_CATEGORIES,
    },
    slug: {
        type: String,
        required: [true, 'El slug de la subcategoría es obligatorio'],
        trim: true,
        lowercase: true,
    },
    state: { type: Boolean, default: true },
});

SubcategorySchema.index({ category: 1, name: 1 }, {
    unique: true, partialFilterExpression: { state: true }, collation: CATALOG_COLLATION,
});
SubcategorySchema.index({ category: 1, slug: 1 }, {
    unique: true, partialFilterExpression: { state: true },
});

SubcategorySchema.methods.toJSON = function () {
    const { __v, ...data } = this.toObject({ virtuals: true });
    return data;
};

module.exports = model('Subcategory', SubcategorySchema);
