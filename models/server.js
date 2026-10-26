const cors = require('cors');
const express = require('express');
const fileUpload = require('express-fileupload');

const { dbConnection } = require( '../database/config' );
const { corsOptions } = require( '../config/cors' );
const { applyClientIpPolicy } = require( '../config/client-ip' );


class Server{

    constructor() {
        this.app = express();
        this.port = process.env.PORT;
        //?Producción: 127.0.0.1 detrás de cloudflared o Caddy en la misma instancia; sin HOST escucha en todas las interfaces (desarrollo)
        this.host = process.env.HOST;

        this.paths = {
            address      : '/api/address',
            auth         : '/api/auth',
            products     : '/api/products',
            brands       : '/api/brands',
            subcategories: '/api/subcategories',
            productImages: '/api/upload/products',
            orders       : '/api/orders',
            admin        : '/api/admin',
        }

        //!Middlewares Funciones que se ejecutan cuando levantemos el servidor
        this.middlewares();

        //?Conectar a base de datos
        this.conectarDB();

        //*Rutas de mi aplicación
        this.routes();
    };

    async conectarDB () {
        await dbConnection();
    }

    middlewares(){
        //?IP del cliente: solo el proxy local (Caddy por loopback o cloudflared). Nunca `true`: un encabezado
        //?falsificado desde internet no debe cambiar req.ip (límites por IP de recuperación de contraseña).
        applyClientIpPolicy( this.app );

        //?Cors: orígenes exactos de producción (CORS_ORIGINS); localhost solo fuera de producción
        this.app.use( cors( corsOptions() ) );

        //?Lectura y parseo del Body
        this.app.use( express.json() );

        //?Directorio público
        this.app.use( express.static( 'public' ));

        //?Fileupload - Carga de archivos
        this.app.use( fileUpload ({
            useTempFiles    : true,
            tempFileDir     : '/tmp/',
            createParentPath: true
        }));
    }

    routes() {
        this.app.get('/api/health', async (_req, res) => {
            try {
                const mongo = require('mongoose');
                const redis = require('../database/config-redis');
                if (mongo.connection.readyState !== 1 || !redis.isReady) throw new Error('Not ready');
                await Promise.all([mongo.connection.db.admin().ping(), redis.ping()]);
                res.set('Cache-Control', 'no-store').json({ ok: true, version: process.env.APP_VERSION || 'development' });
            } catch { res.status(503).json({ ok: false }); }
        });
        this.app.use( this.paths.address, require('../routes/address.route'));
        this.app.use( this.paths.auth, require('../routes/auth.route'));
        this.app.use( this.paths.products, require('../routes/products.route'));
        this.app.use( this.paths.brands, require('../routes/brands.route'));
        this.app.use( this.paths.subcategories, require('../routes/subcategories.route'));
        this.app.use( this.paths.productImages, require('../routes/product-images.route'));
        this.app.use( this.paths.orders, require('../routes/orders.route'));
        this.app.use( this.paths.admin, require('../routes/admin.route'));
    };

    listen(){
        this.app.listen( { port: this.port, host: this.host }, () => console.log('Servidor corriendo en', this.host || '*', 'puerto', this.port) );
    };

}

module.exports = Server;
