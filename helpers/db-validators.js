const { isObjectIdOrHexString } = require('mongoose');
const { User, Product, Brand, Subcategory, Address, Sell } = require('../models');

const registerEmail = async ( email = '' ) => {

    const user = await User.findOne( { email } );

    if( user ){
        throw new Error( `El email: ${ email } ya está registrado` );
    }
}

const existingUser = async ( email = '' ) => {

    const user = await User.findOne( { email } );

    if( !user ){
        throw new Error( `El email: ${ email } no está registrado` );
    }
}

const existingGoogleUser = async( email = '' ) => {
    const user = await User.findOne( { email } );
    if ( user?.google ) {
        throw new Error( `El email ${ email } ya fue registrado previamente con Google, Inicia Sesión a través de Google`);
    }
}

const includedColection = ( coleccion = '', allowCollection = [] ) => {

    const included = allowCollection.includes( coleccion );

    if( !included ){
        throw new Error(`La colección ${ coleccion } no es permitida, ${ allowCollection }`)
    }

    return true;
}

const existingProduct = async( id = '' ) => {
    const productExists = await Product.findOne({ _id: id, state: true });
    if( !productExists ){
        throw new Error(`El id no pertence a ningun producto ${ id }`)
    }
}

const catalogValidationError = msg => Object.assign(new Error(msg), { status: 400 });

const existingBrand = async (id = '') => {
    if (!isObjectIdOrHexString(id)) {
        throw catalogValidationError('El ID de la marca no es válido');
    }
    const brand = await Brand.findOne({ _id: id, state: true });
    if (!brand) throw catalogValidationError('La marca no existe o está inactiva');
    return brand;
};

const existingSubcategory = async (id = '') => {
    if (!isObjectIdOrHexString(id)) {
        throw catalogValidationError('El ID de la subcategoría no es válido');
    }
    const subcategory = await Subcategory.findOne({ _id: id, state: true });
    if (!subcategory) throw catalogValidationError('La subcategoría no existe o está inactiva');
    return subcategory;
};

const validateSubcategoryForCategory = async (id, category) => {
    const subcategory = await existingSubcategory(id);
    if (subcategory.category !== category) {
        throw catalogValidationError('La subcategoría seleccionada no pertenece a la categoría del producto');
    }
    return subcategory;
};

const validatePhoneNumber = async (phone = '') => {
  const regex = /^[0-9]{8}$/;

  if (!regex.test(phone)) {
    throw new Error('El número de teléfono debe tener exactamente 8 dígitos numéricos');
  }

  return true;
};

const existsAddress = async( id = '' ) => {
    const addressExists = await Address.findById( id );
    if( !addressExists ){
        throw new Error(`El id no pertence a ninguna dirección ${ id }`)
    }
}

const existingUserById = async ( id = '' ) => {
    const user = await User.findById( id );
    if( !user ){
        throw new Error(`No existe un usuario con el id ${ id }`)
    }
}

const existingSell = async ( id = '' ) => {
    const sell = await Sell.findOne({ _id: id, isDeleted: false });
    if( !sell ){
        throw new Error(`No se encontró la venta con id ${ id }`)
    }
}

module.exports = {
    existingBrand,
    existingSubcategory,
    validateSubcategoryForCategory,
    existsAddress,
    existingGoogleUser,
    existingProduct,
    existingSell,
    existingUser,
    existingUserById,
    includedColection,
    registerEmail,
    validatePhoneNumber,
}
