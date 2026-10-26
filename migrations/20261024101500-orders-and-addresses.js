// Índices de pedidos y direcciones. Mismas especificaciones que declaran los modelos de Mongoose,
// para que ejecutar la migración y el autoIndex del servidor sean equivalentes.
module.exports = {
    async up(db) {
        const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(({ name }) => name));
        for (const name of ['orders', 'addresses']) {
            if (!existing.has(name)) await db.createCollection(name);
        }

        const orders = db.collection('orders');
        await orders.createIndex({ orderCode: 1 }, { unique: true });
        await orders.createIndex({ buyerUser: 1, createdAt: -1 });
        await orders.createIndex({ buyerUser: 1, checkoutKey: 1 }, {
            unique: true, partialFilterExpression: { checkoutKey: { $type: 'string' } },
        });
        await orders.createIndex({ paymentState: 1, orderState: 1, createdAt: -1 });
        await db.collection('addresses').createIndex({ recipient: 1 });
    },

    // Solo se retiran los índices: nunca se borran colecciones con datos de clientes.
    async down(db) {
        const orders = db.collection('orders');
        for (const name of ['orderCode_1', 'buyerUser_1_createdAt_-1', 'buyerUser_1_checkoutKey_1', 'paymentState_1_orderState_1_createdAt_-1']) {
            await orders.dropIndex(name).catch(() => {});
        }
        await db.collection('addresses').dropIndex('recipient_1').catch(() => {});
    },
};
