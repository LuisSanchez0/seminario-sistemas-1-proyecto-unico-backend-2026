const crypto = require('crypto');

const {
    setVerificationCode,
    getVerificationCode,
    deleteVerificationCode,
} = require('../helpers/db-redis-codes' );

const { transporter } = require('../config/mailer');
// Ya no necesitas importar redisClient aquí si usas los helpers
// const redisClient = require("../database/config-redis");

//!Generar código de verificación
async function sendVerificationCode(email, name, type) {

    // Generar código de 8 dígitos aleatorio
    const code = crypto.randomInt(10000000, 99999999).toString();

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
                        Aquí está tu código de autenticación:
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

        console.log(
            `Correo de verificación enviado a: ${email}`
        );

    } catch (error) {

        console.error(
            `Error al enviar el correo a ${email}:`,
            error
        );
    }
}


async function validateCode(email, code, type) {
    
    const storedCode = await getVerificationCode(email, type);

    if (!storedCode) {
        throw new Error('Código inválido o expirado');
    }

    if (storedCode !== code) {
        throw new Error('Código enviado es incorrecto');
    }

    await deleteVerificationCode(email, type);

    return true;
}

const logoLocationLabels = {
  LEFT_CHEST: "Pecho izquierdo",
  RIGHT_CHEST: "Pecho derecho",
  RIGHT_SHOULDER: "Hombro derecho",
  SLEEVES: "Mangas",
  UPPER_BACK: "Espalda superior",
  CENTER_CAP: "Centro de gorra",
  NO_LOGO: "Sin logo",
};

const shippingStatusLabels = {
  ORDER_PLACED: "Orden recibida",
  PROCESSING: "En proceso",
  SHIPPED: "Enviado",
  DELIVERED: "Entregado",
};

const paymentStateLabels = {
  EN_ESPERA_DE_PAGO: "En espera de pago",
  PAGO_REALIZADO: "Pago realizado",
  CANCELADO: "Cancelado",
  REEMBOLSADO: "Reembolsado",
};

const orderStateLabels = {
  PENDIENTE: "Pendiente",
  EN_PROCESO: "En proceso",
  PARCIALMENTE_ENVIADO: "Parcialmente enviado",
  ENVIADO: "Enviado",
  COMPLETADO: "Completado",
  CANCELADO: "Cancelado",
  REEMBOLSADO: "Reembolsado",
};

async function sendSellConfirmationEmail(sell) {
  const buyerName  = sell.buyerUser.name  || "Cliente";
  const buyerEmail = sell.buyerUser.email;
  const orderCode  = sell.orderCode;
  const date       = new Date(sell.date).toLocaleDateString("es-GT", {
    year: "numeric", month: "long", day: "numeric",
  });

  const paymentState = paymentStateLabels[sell.paymentState] || sell.paymentState;
  const orderState   = orderStateLabels[sell.orderState]     || sell.orderState;
  const total        = sell.total.toFixed(2);
  const nitHtml      = sell.nit
    ? `<tr><td style="color:#24292e;font-weight:500;padding:5px 0;width:50%;">NIT</td><td style="color:#586069;padding:5px 0;">${sell.nit}</td></tr>`
    : "";

  const productsHtml = sell.products.map((line) => {
    const product       = line.product;
    const title         = product.title || "Producto";
    const productImgUrl = product.images && product.images.length > 0 ? product.images[0].url : null;
    const logoLabel     = logoLocationLabels[line.logoLocation]   || line.logoLocation;
    const statusLabel   = shippingStatusLabels[line.shippingStatus] || line.shippingStatus;

    const productImgHtml = productImgUrl
      ? `<img src="${productImgUrl}" alt="${title}" style="width:80px;height:80px;object-fit:cover;border-radius:4px;border:1px solid #e1e4e8;" />`
      : `<div style="width:80px;height:80px;background-color:#f6f8fa;border:1px solid #e1e4e8;border-radius:4px;text-align:center;line-height:80px;font-size:11px;color:#959da5;">Sin imagen</div>`;

    let logoRowHtml;
    if (line.logoLocation === "NO_LOGO") {
      logoRowHtml = `<tr><td style="color:#24292e;font-weight:500;padding:4px 0;width:50%;">Logo</td><td style="color:#586069;padding:4px 0;">Sin logo</td></tr>`;
    } else if (line.imgLogo && line.imgLogo.url) {
      logoRowHtml = `<tr><td style="color:#24292e;font-weight:500;padding:4px 0;width:50%;">Logo</td><td style="padding:4px 0;"><img src="${line.imgLogo.url}" alt="Logo" style="max-width:56px;max-height:56px;border-radius:3px;border:1px solid #e1e4e8;" /></td></tr>`;
    } else {
      logoRowHtml = `<tr><td style="color:#24292e;font-weight:500;padding:4px 0;width:50%;">Logo</td><td style="color:#959da5;padding:4px 0;font-style:italic;">Logo pendiente de carga</td></tr>`;
    }

    const instructionsHtml = line.specialInstructions
      ? `<div style="background-color:#f6f8fa;border-left:3px solid #0366d6;padding:8px 12px;margin-top:10px;border-radius:0 4px 4px 0;font-size:13px;color:#586069;"><b>Instrucciones especiales:</b> ${line.specialInstructions}</div>`
      : "";

    return `
      <div style="border:1px solid #e1e4e8;border-radius:6px;margin:12px 0;overflow:hidden;">
        <div style="background-color:#f6f8fa;padding:10px 14px;border-bottom:1px solid #e1e4e8;">
          <h3 style="margin:0;font-size:15px;color:#24292e;">${title}</h3>
        </div>
        <div style="padding:14px;">
          <table style="width:100%;border-collapse:collapse;">
            <tr>
              <td style="width:94px;vertical-align:top;padding-right:14px;">${productImgHtml}</td>
              <td style="vertical-align:top;">
                <table style="width:100%;border-collapse:collapse;font-size:14px;">
                  <tr><td style="color:#24292e;font-weight:500;padding:4px 0;">Cantidad</td><td style="color:#586069;padding:4px 0;">${line.quantity}</td></tr>
                  <tr><td style="color:#24292e;font-weight:500;padding:4px 0;">Subtotal</td><td style="color:#586069;padding:4px 0;">Q ${line.subTotal.toFixed(2)}</td></tr>
                  <tr><td style="color:#24292e;font-weight:500;padding:4px 0;">Ubicación del logo</td><td style="color:#586069;padding:4px 0;">${logoLabel}</td></tr>
                  ${logoRowHtml}
                  <tr><td style="color:#24292e;font-weight:500;padding:4px 0;">Estado de envío</td><td style="color:#586069;padding:4px 0;">${statusLabel}</td></tr>
                </table>
                ${instructionsHtml}
              </td>
            </tr>
          </table>
        </div>
      </div>`;
  }).join("");

  const mailOptions = {
    from: '"ProWear" <no-reply@prowear.com>',
    to: buyerEmail,
    subject: `[ProWear] Confirmación de pedido #${orderCode}`,
    html: `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body {
          margin: 0;
          padding: 0;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif;
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
        .header img {
          width: 90px;
          height: 90px;
          margin-bottom: 10px;
        }
        .section-title {
          font-size: 12px;
          font-weight: 600;
          color: #24292e;
          margin: 20px 0 8px 0;
          text-transform: uppercase;
          letter-spacing: 0.6px;
        }
        .footer {
          text-align: center;
          padding: 20px 0 0;
          font-size: 12px;
          color: #959da5;
          border-top: 1px solid #e1e4e8;
          margin-top: 20px;
        }
      </style>
    </head>
    <body>
      <div class="container">

        <div class="header">
          <img src="https://prowear-s3-bucket.s3.us-east-1.amazonaws.com/static/images/f88eb935-70a5-4ffd-a917-334670830b9d.jpeg" alt="Logo de ProWear">
          <h2 style="margin:0;color:#24292e;font-size:20px;">¡Pedido confirmado, ${buyerName}!</h2>
          <p style="margin:8px 0 0;color:#586069;font-size:14px;">Tu pedido fue recibido correctamente.</p>
        </div>

        <div style="padding:20px 0;">

          <p class="section-title">Información del pedido</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <tr><td style="color:#24292e;font-weight:500;padding:5px 0;width:50%;">ID del pedido</td><td style="color:#586069;padding:5px 0;">#${orderCode}</td></tr>
            <tr><td style="color:#24292e;font-weight:500;padding:5px 0;">Fecha</td><td style="color:#586069;padding:5px 0;">${date}</td></tr>
            <tr><td style="color:#24292e;font-weight:500;padding:5px 0;">Estado de pago</td><td style="color:#586069;padding:5px 0;">${paymentState}</td></tr>
            <tr><td style="color:#24292e;font-weight:500;padding:5px 0;">Estado del pedido</td><td style="color:#586069;padding:5px 0;">${orderState}</td></tr>
            <tr><td style="color:#24292e;font-weight:500;padding:5px 0;">Método de pago</td><td style="color:#586069;padding:5px 0;">Transferencia bancaria</td></tr>
            <tr><td style="color:#24292e;font-weight:500;padding:5px 0;">Correo</td><td style="color:#586069;padding:5px 0;">${buyerEmail}</td></tr>
            ${nitHtml}
          </table>

          <p class="section-title">Productos</p>
          ${productsHtml}

          <div style="background-color:#f6f8fa;border:1px solid #e1e4e8;border-radius:6px;padding:16px;margin-top:20px;text-align:right;">
            <div style="font-size:13px;color:#586069;">Total del pedido</div>
            <div style="font-size:24px;font-weight:700;color:#24292e;">Q ${total}</div>
          </div>

          <p style="font-size:13px;color:#586069;margin-top:20px;line-height:1.6;">
            Para procesar tu pedido, recuerda realizar tu transferencia bancaria y subir el comprobante de pago desde la plataforma ProWear.
          </p>

        </div>

        <div class="footer">
          <p>Gracias por tu compra en ProWear.</p>
          <p>Este correo fue generado automáticamente. Por favor no respondas a este mensaje.</p>
        </div>

      </div>
    </body>
    </html>`,
  };

  await transporter.sendMail(mailOptions);
  console.log(`Correo de confirmación de venta enviado a: ${buyerEmail}`);
}

async function sendSellFinishedDocumentationEmail(sell, attachments) {
  const buyerName  = sell.buyerUser?.name  || "Cliente";
  const buyerEmail = sell.buyerUser?.email;
  const orderCode  = sell.orderCode || null;
  const subject    = orderCode
    ? `[ProWear] Documentación de tu pedido #${orderCode}`
    : "[ProWear] Documentación de tu pedido";

  const attachedListHtml = attachments
    .map(a => `<li style="margin:4px 0;color:#586069;">${a.filename}</li>`)
    .join("");

  const mailOptions = {
    from: '"ProWear" <no-reply@prowear.com>',
    to: buyerEmail,
    subject,
    html: `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body {
          margin: 0;
          padding: 0;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif;
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
        .header img {
          width: 90px;
          height: 90px;
          margin-bottom: 10px;
        }
        .footer {
          text-align: center;
          padding: 20px 0 0;
          font-size: 12px;
          color: #959da5;
          border-top: 1px solid #e1e4e8;
          margin-top: 20px;
        }
      </style>
    </head>
    <body>
      <div class="container">

        <div class="header">
          <img src="https://prowear-s3-bucket.s3.us-east-1.amazonaws.com/static/images/f88eb935-70a5-4ffd-a917-334670830b9d.jpeg" alt="Logo de ProWear">
          <h2 style="margin:0;color:#24292e;font-size:20px;">Documentación de tu pedido lista</h2>
          ${orderCode ? `<p style="margin:8px 0 0;color:#586069;font-size:14px;">Pedido <b>#${orderCode}</b></p>` : ""}
        </div>

        <div style="padding:20px 0;">
          <p style="font-size:14px;color:#24292e;margin:0 0 12px 0;">Hola <b>${buyerName}</b>,</p>
          <p style="font-size:14px;color:#586069;line-height:1.6;margin:0 0 16px 0;">
            Te compartimos la documentación correspondiente a tu pedido${orderCode ? ` <b>#${orderCode}</b>` : ""}.
            Los archivos disponibles se encuentran adjuntos a este correo.
          </p>

          <div style="background-color:#f6f8fa;border:1px solid #e1e4e8;border-radius:6px;padding:14px 18px;margin:0 0 20px 0;">
            <p style="font-size:13px;font-weight:600;color:#24292e;margin:0 0 8px 0;">Archivos adjuntos:</p>
            <ul style="margin:0;padding-left:18px;font-size:13px;">
              ${attachedListHtml}
            </ul>
          </div>

          <p style="font-size:14px;color:#586069;line-height:1.6;margin:0 0 20px 0;">
            Si tienes alguna pregunta sobre tu pedido, no dudes en contactarnos.
          </p>

          <p style="font-size:14px;color:#586069;margin:0;">
            Atentamente,<br>
            <b style="color:#24292e;">El equipo de ProWear</b>
          </p>
        </div>

        <div class="footer">
          <p>Gracias por tu compra en ProWear.</p>
          <p>Este correo fue generado automáticamente. Por favor no respondas a este mensaje.</p>
        </div>

      </div>
    </body>
    </html>`,
    attachments,
  };

  await transporter.sendMail(mailOptions);
  console.log(`Correo de documentación de venta finalizada enviado a: ${buyerEmail}`);
}

async function sendAdminSellConfirmationNotificationEmail(sell, recipients) {
  if (!recipients || recipients.length === 0) return;

  const buyerName  = sell.buyerUser?.name  || "Cliente";
  const buyerEmail = sell.buyerUser?.email || "—";
  const orderCode  = sell.orderCode        || "—";
  const date       = new Date(sell.date).toLocaleDateString("es-GT", {
    year: "numeric", month: "long", day: "numeric",
  });

  const paymentStateLabel = paymentStateLabels[sell.paymentState] || sell.paymentState || "—";
  const orderStateLabel   = orderStateLabels[sell.orderState]     || sell.orderState   || "—";
  const total             = (sell.total ?? 0).toFixed(2);

  const productsHtml = (sell.products ?? []).map((line) => {
    const title    = line.product?.title || "Producto";
    const subTotal = (line.subTotal ?? 0).toFixed(2);
    return `
      <tr>
        <td style="padding:7px 10px;border-bottom:1px solid #e1e4e8;font-size:13px;color:#24292e;">${title}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #e1e4e8;font-size:13px;color:#586069;text-align:center;">${line.quantity}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #e1e4e8;font-size:13px;color:#586069;text-align:right;">Q ${subTotal}</td>
      </tr>`;
  }).join("");

  const mailOptions = {
    from: '"ProWear" <no-reply@prowear.com>',
    to: recipients.join(", "),
    subject: `[ProWear Admin] Nueva venta registrada #${orderCode}`,
    html: `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { margin:0; padding:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Roboto","Helvetica Neue",sans-serif; background-color:#f6f8fa; }
        .container { max-width:600px; margin:40px auto; padding:20px; background-color:#ffffff; border:1px solid #e1e4e8; border-radius:6px; box-shadow:0 1px 3px rgba(27,31,35,0.1); }
        .header { text-align:center; padding-bottom:20px; border-bottom:1px solid #e1e4e8; }
        .header img { width:80px; height:80px; margin-bottom:10px; }
        .section-title { font-size:11px; font-weight:600; color:#24292e; margin:20px 0 8px; text-transform:uppercase; letter-spacing:0.6px; }
        .footer { text-align:center; padding:20px 0 0; font-size:12px; color:#959da5; border-top:1px solid #e1e4e8; margin-top:20px; }
      </style>
    </head>
    <body>
      <div class="container">

        <div class="header">
          <img src="https://prowear-s3-bucket.s3.us-east-1.amazonaws.com/static/images/f88eb935-70a5-4ffd-a917-334670830b9d.jpeg" alt="Logo de ProWear" />
          <h2 style="margin:0;color:#24292e;font-size:19px;">Nueva venta registrada</h2>
          <p style="margin:6px 0 0;color:#586069;font-size:13px;">Se ha confirmado un nuevo pedido en la plataforma.</p>
        </div>

        <div style="padding:20px 0;">

          <p class="section-title">Datos del pedido</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <tr><td style="color:#24292e;font-weight:500;padding:5px 0;width:45%;">Código de orden</td><td style="color:#586069;padding:5px 0;">#${orderCode}</td></tr>
            <tr><td style="color:#24292e;font-weight:500;padding:5px 0;">Fecha</td><td style="color:#586069;padding:5px 0;">${date}</td></tr>
            <tr><td style="color:#24292e;font-weight:500;padding:5px 0;">Estado de pago</td><td style="color:#586069;padding:5px 0;">${paymentStateLabel}</td></tr>
            <tr><td style="color:#24292e;font-weight:500;padding:5px 0;">Estado de orden</td><td style="color:#586069;padding:5px 0;">${orderStateLabel}</td></tr>
          </table>

          <p class="section-title">Cliente</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <tr><td style="color:#24292e;font-weight:500;padding:5px 0;width:45%;">Nombre</td><td style="color:#586069;padding:5px 0;">${buyerName}</td></tr>
            <tr><td style="color:#24292e;font-weight:500;padding:5px 0;">Correo</td><td style="color:#586069;padding:5px 0;">${buyerEmail}</td></tr>
          </table>

          <p class="section-title">Productos</p>
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="background-color:#f6f8fa;">
                <th style="padding:7px 10px;font-size:11px;font-weight:600;color:#586069;text-align:left;border-bottom:1px solid #e1e4e8;">Producto</th>
                <th style="padding:7px 10px;font-size:11px;font-weight:600;color:#586069;text-align:center;border-bottom:1px solid #e1e4e8;">Cant.</th>
                <th style="padding:7px 10px;font-size:11px;font-weight:600;color:#586069;text-align:right;border-bottom:1px solid #e1e4e8;">Subtotal</th>
              </tr>
            </thead>
            <tbody>${productsHtml}</tbody>
          </table>

          <div style="background-color:#f6f8fa;border:1px solid #e1e4e8;border-radius:6px;padding:14px 16px;margin-top:20px;text-align:right;">
            <div style="font-size:12px;color:#586069;">Total del pedido</div>
            <div style="font-size:22px;font-weight:700;color:#24292e;">Q ${total}</div>
          </div>

          <p style="font-size:13px;color:#586069;margin-top:20px;line-height:1.6;">
            Puedes revisar y gestionar esta venta desde el <strong>panel administrativo de ProWear</strong>.
          </p>

        </div>

        <div class="footer">
          <p>Este correo fue generado automáticamente por el sistema ProWear.</p>
        </div>

      </div>
    </body>
    </html>`,
  };

  await transporter.sendMail(mailOptions);
  console.log(`Notificación de venta enviada a administradores: ${recipients.join(", ")}`);
}

module.exports = {
  sendVerificationCode,
  validateCode,
  sendSellConfirmationEmail,
  sendSellFinishedDocumentationEmail,
  sendAdminSellConfirmationNotificationEmail,
};
