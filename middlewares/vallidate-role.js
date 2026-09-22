const { request, response } = require("express");

const isAdminRole = ( req = request, res = response, next ) => {

    if( !req.user ) {
        return res.status(500).json({
            msg: 'Se quiere verificar el rol sin validar el token primero',
            ok: false
        });
    }

    const { role, name } = req.user;

    if( role !== 'ADMIN_ROLE' ){
        return res.status( 401 ).json({
            msg: `${ name } no es administrador - No puede hacer esto`,
            ok: false
        });
    }

    next();
}

const isCommonRole = ( req = request, res = response, next ) => {

    if( !req.user ) {
        return res.status(500).json({
            msg: 'Se quiere verificar el rol sin validar el token primero',
            ok: false
        });
    }

    const { role, name } = req.usuario;

    if( role !== 'COMMON_ROLE' ){
        return res.status( 401 ).json({
            msg: `${ name } no es un usuario común - No puede hacer esto`,
            ok: false
        });
    }

    next();
}

const hasRole = ( ...roles ) => {

    return ( req, res = response , next ) => {

        if( !req.user ) {
            return res.status(500).json({
                msg: 'Se quiere verificar el role sin validar el token primero',
                ok: false
            });
        }

        if( !roles.includes( req.user.role ) ) {
            return res.status( 401 ).json({
                msg: `El servicio requiere uno de estos roles: ${ roles }`,
                ok: false
            });
        }

        next();
    }
}

module.exports = {
    isAdminRole,
    isCommonRole,
    hasRole,
}