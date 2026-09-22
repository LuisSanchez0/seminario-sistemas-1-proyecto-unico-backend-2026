const { CATALOG_COLLATION } = require('../helpers/catalog-normalization');

module.exports = {
    async up(db) {
        await db.collection('brands').createIndex({ name: 1 }, {
            unique: true, partialFilterExpression: { state: true }, collation: CATALOG_COLLATION,
        });
        await db.collection('brands').createIndex({ slug: 1 }, {
            unique: true, partialFilterExpression: { state: true },
        });
        await db.collection('subcategories').createIndex({ category: 1, name: 1 }, {
            unique: true, partialFilterExpression: { state: true }, collation: CATALOG_COLLATION,
        });
        await db.collection('subcategories').createIndex({ category: 1, slug: 1 }, {
            unique: true, partialFilterExpression: { state: true },
        });
    },

    async down(db) {
        await db.collection('brands').dropIndex('name_1');
        await db.collection('brands').dropIndex('slug_1');
        await db.collection('subcategories').dropIndex('category_1_name_1');
        await db.collection('subcategories').dropIndex('category_1_slug_1');
    },
};
