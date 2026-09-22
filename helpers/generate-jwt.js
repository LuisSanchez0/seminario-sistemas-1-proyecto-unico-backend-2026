const jwt = require('jsonwebtoken');

const generateJWT = ( uid = '' ) => {

    return new Promise( ( res, rej ) => {   

        //!El user id es lo único que se almacena en el payload del JWT
        const payload = { uid };

        jwt.sign( payload, process.env.SECRETEORPRIVATEKEY, {
            expiresIn: '4h'
        }, ( err, token ) => {
            if ( err ) {
                console.log( err );
                return rej( 'No se pudo resolver el token' );
            }
            res( token );
        });
    });

}

module.exports = {
    generateJWT
}