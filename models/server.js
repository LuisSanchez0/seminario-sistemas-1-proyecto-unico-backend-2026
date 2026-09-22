const cors = require('cors');
const express = require('express');
const fileUpload = require('express-fileupload');

const { dbConnection } = require( '../database/config' );


class Server{

    constructor() {
        this.app = express();
        this.port = process.env.PORT;

        this.paths = {
        //     address      : '/api/address',
        //     auth         : '/api/auth',
        //     products     : '/api/products',
        //     sells        : '/api/sells',
        //     sellFinished : '/api/sell-finished',
        //     stats        : '/api/stats',
        //     upload       : '/api/upload',
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
        //?Cors
        this.app.use( cors() );

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
        // this.app.use( this.paths.address, require('../routes/address.route'));
        // this.app.use( this.paths.auth, require('../routes/auth.route'));
        // this.app.use( this.paths.products, require('../routes/products.route'));
        // this.app.use( this.paths.sells, require('../routes/sell.route'));
        // this.app.use( this.paths.sellFinished, require('../routes/sell-finished.route'));
        // this.app.use( this.paths.stats, require('../routes/stats.route'));
        // this.app.use( this.paths.upload, require('../routes/upload.route'));
    };

    listen(){
        this.app.listen( this.port, () => console.log('Servidor corriendo en puerto', this.port) );
    };

}

module.exports = Server;