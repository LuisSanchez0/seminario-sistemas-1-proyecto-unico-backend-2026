const crypto = require('crypto');

const { setVerificationCode, deleteVerificationCode, consumeVerificationCode, reserveCodeRequest } = require('./db-redis-codes');

const { transporter } = require('../config/mailer');
// Ya no necesitas importar redisClient aquí si usas los helpers
// const redisClient = require("../database/config-redis");

//!Generar código de verificación
async function sendVerificationCode(email, name, type, { reserved = false, ip } = {}) {
    if (!reserved) await reserveCodeRequest(email, type, ip);
    name = String(name).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

    // Generar código de 8 dígitos aleatorio
    const code = crypto.randomInt(10000000, 100000000).toString();

    // Guardar en Redis
    await setVerificationCode(email, code, type);

    const typeForEmail =
        type === '2fa'
            ? 'Factor de Autenticación'
            : 'Recuperación de Contraseña';

    const mailOptions = {
        from: '"LuminaBeauty" <no-reply@luminabeauty.com>',
        to: email,
        subject: `[LuminaBeauty] Código para ${typeForEmail}`,

        html: `
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">

            <meta
                name="viewport"
                content="width=device-width, initial-scale=1.0"
            >

            <style>
                body {
                    margin: 0;
                    padding: 0;
                    font-family:
                        -apple-system,
                        BlinkMacSystemFont,
                        "Segoe UI",
                        Roboto,
                        Helvetica,
                        Arial,
                        sans-serif;

                    background-color: #f6f8fa;
                }

                .container {
                    max-width: 600px;
                    margin: 40px auto;
                    padding: 20px;
                    background-color: #ffffff;

                    border: 1px solid #e1e4e8;
                    border-radius: 6px;

                    box-shadow: 0 1px 3px rgba(27, 31, 35, 0.1);
                }

                .header {
                    text-align: center;
                    padding-bottom: 20px;
                    border-bottom: 1px solid #e1e4e8;
                }

                .content {
                    padding: 20px;
                    text-align: center;
                }

                .code-box {
                    background-color: #f6f8fa;
                    border: 1px dashed #e1e4e8;
                    border-radius: 6px;

                    padding: 15px;
                    margin: 20px 0;
                }

                .code {
                    font-size: 32px;
                    font-weight: 600;

                    color: #0366d6;

                    letter-spacing: 4px;
                    margin: 0;
                }

                .info-text {
                    font-size: 14px;
                    color: #586069;
                    line-height: 1.5;
                }

                .warning {
                    color: #d73a49;
                    font-weight: 600;
                }

                .signature {
                    font-size: 14px;
                    color: #586069;
                    margin-top: 20px;
                }

                .footer {
                    max-width: 600px;
                    margin: 0 auto;

                    text-align: center;

                    padding: 20px;

                    font-size: 12px;
                    line-height: 1.5;

                    color: #959da5;
                }

                @media (max-width: 640px) {
                    .container {
                        margin: 10px;
                        padding: 15px;
                    }

                    .content {
                        padding: 15px 5px;
                    }

                    .code {
                        font-size: 28px;
                    }
                }
            </style>
        </head>

        <body>

            <div class="container">

                <div class="header">

                    <img
                        src="https://lumina-beauty-bucket.s3.us-east-1.amazonaws.com/static/images/lumina-beauty-logo.png"
                        alt="Logo de LuminaBeauty"
                        width="160"
                        style="
                            display: block;
                            width: 160px;
                            max-width: 160px;
                            height: auto;
                            margin: 0 auto 20px auto;
                        "
                    >

                    <h2 style="
                        margin: 0;
                        color: #24292e;
                        font-size: 22px;
                        line-height: 1.4;
                    ">
                        Por favor, verifica tu identidad, ${name}
                    </h2>

                </div>

                <div class="content">

                    <p class="info-text">
                        Aquí está tu código para ${typeForEmail}:
                    </p>

                    <div class="code-box">
                        <p class="code">
                            ${code}
                        </p>
                    </div>

                    <p class="info-text">
                        Este código es válido por
                        <b>15 minutos</b>
                        y solo puede usarse una vez.
                    </p>

                    <p class="info-text warning">
                        Por favor, no compartas este código con nadie:
                        nunca te lo pediremos por teléfono o correo.
                    </p>

                    <p class="signature">
                        Gracias,<br>
                        El equipo de LuminaBeauty
                    </p>

                </div>

            </div>

            <div class="footer">
                <p>
                    Estás recibiendo este correo porque se solicitó un
                    código de verificación para tu cuenta de LuminaBeauty.

                    Si no fuiste tú, por favor ignora este correo.
                </p>
            </div>

        </body>
        </html>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
    } catch (error) {
        await deleteVerificationCode(email, type);
        throw error;
    }
}

async function validateCode(email, code, type) {
    return consumeVerificationCode(email, code, type);
}

module.exports = {
  sendVerificationCode,
  validateCode,
};
