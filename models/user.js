const { Schema, model } = require('mongoose');

const UserSchema = Schema({
    email: {
        type: String,
        required: [true, 'El email es un campo obligatorio'],
        unique: true,
        match: [
            /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
            'El email ingresado no es valido'
        ],
    },

    password: {
        type: String,
        required: [true, 'La contraseña es obligatoria'],
        minlength: [4, 'La contraseña debe de contener como minimo 4 caracteres'],
    },

    role: {
        type: String,
        required: [true, 'El rol para la asignación es obligatorio'],
        enum: ['COMMON_ROLE', 'ADMIN_ROLE'],
        default: 'COMMON_ROLE'
    },

    name: {
        type: String,
        required: [true, 'El nombre del usuario es obligatorio'],
        minlength: [3, 'El nombre debe de contener como minimo 3 caracteres'],
        match: [
            /^[a-zA-ZáéíóúÁÉÍÓÚñÑ\s]+$/,
            'El nombre ingresado no es válido'
        ],
    },

    state: {
        type: Boolean,
        default: true,
    },

    google: {
        type: Boolean,
        default: false,
    },

    isAuthenticated: {
        type: Boolean,
        default: false,
    },
});

UserSchema.methods.toJSON = function () {
    const { __v, password, _id, ...user } = this.toObject();

    user.uid = _id;

    return user;
};

module.exports = model('User', UserSchema);