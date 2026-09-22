module.exports = {
    async up(db) {
        await db.createCollection('users');

        await db.collection('users').createIndex(
            { email: 1 },
            {
                unique: true,
                name: 'idx_users_email_unique'
            }
        );
    },

    async down(db) {
        await db.collection('users').drop();
    }
};