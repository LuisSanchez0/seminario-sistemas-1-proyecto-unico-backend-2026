const { Schema, model } = require('mongoose');
const { normalizeCatalogName, CATALOG_COLLATION } = require('../helpers/catalog-normalization');

const BrandSchema = Schema({
    name: {
        type: String,
        required: [true, 'El nombre de la marca es obligatorio'],
        trim: true,
        set: normalizeCatalogName,
    },
    slug: {
        type: String,
        required: [true, 'El slug de la marca es obligatorio'],
        trim: true,
        lowercase: true,
    },
    state: { type: Boolean, default: true },
});

BrandSchema.index({ name: 1 }, {
    unique: true, partialFilterExpression: { state: true }, collation: CATALOG_COLLATION,
});
BrandSchema.index({ slug: 1 }, { unique: true, partialFilterExpression: { state: true } });

BrandSchema.methods.toJSON = function () {
    const { __v, ...data } = this.toObject({ virtuals: true });
    return data;
};

module.exports = model('Brand', BrandSchema);
