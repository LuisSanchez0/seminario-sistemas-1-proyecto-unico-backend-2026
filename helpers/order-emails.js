const { transporter } = require('../config/mailer');

const LOGO_URL = 'https://lumina-beauty-bucket.s3.us-east-1.amazonaws.com/static/images/lumina-beauty-logo.png';
const ACCENT = '#0f6e4a';

const PAYMENT_LABELS = {
    EN_ESPERA_DE_PAGO: 'En espera de pago',
    PAGO_REALIZADO: 'Pago confirmado',
    CANCELADO: 'Cancelado',
    REEMBOLSADO: 'Reembolsado',
};

const ORDER_LABELS = {
    PENDIENTE: 'Pedido recibido',
    EN_PROCESO: 'Preparando tu pedido',
    PARCIALMENTE_ENVIADO: 'Parcialmente enviado',
    ENVIADO: 'Enviado',
    COMPLETADO: 'Entregado',
    CANCELADO: 'Cancelado',
    REEMBOLSADO: 'Reembolsado',
};

// Momentos del pedido que notifican al cliente.
const MESSAGES = {
    created: {
        subject: code => `Recibimos tu pedido ${code}`,
        title: '¡Gracias por tu compra!',
        intro: 'Recibimos tu pedido. Lo prepararemos en cuanto confirmemos tu transferencia, por lo que es importante que hayas subido el comprobante de pago.',
    },
    payment: {
        subject: code => `Pago confirmado — pedido ${code}`,
        title: 'Confirmamos tu pago',
        intro: 'Verificamos tu comprobante. Ya empezamos a preparar tus productos.',
    },
    shipped: {
        subject: code => `Tu pedido ${code} va en camino`,
        title: 'Tu pedido fue enviado',
        intro: 'Ya enviamos tus productos de belleza. Puedes seguir el avance desde Mis pedidos.',
    },
    partial: {
        subject: code => `Enviamos parte de tu pedido ${code}`,
        title: 'Enviamos parte de tu pedido',
        intro: 'Una parte de tus productos ya va en camino. Te avisaremos cuando salga el resto.',
    },
    completed: {
        subject: code => `Pedido ${code} entregado`,
        title: 'Tu pedido fue entregado',
        intro: 'Tu pedido quedó completado. ¡Esperamos que disfrutes tus productos!',
    },
    cancelled: {
        subject: code => `Pedido ${code} cancelado`,
        title: 'Tu pedido fue cancelado',
        intro: 'El pedido se canceló y los productos volvieron a estar disponibles. Si ya habías pagado, comunícate con la tienda.',
    },
    refunded: {
        subject: code => `Pedido ${code} reembolsado`,
        title: 'Registramos el reembolso de tu pedido',
        intro: 'El pedido se canceló y el reembolso fue registrado por la tienda. El dinero se devuelve por el mismo medio de pago, de forma manual.',
    },
};

const escapeHtml = (value = '') => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const money = value => `Q ${Number(value).toFixed(2)}`;

const renderOrderEmail = (order, buyer, kind) => {
    const message = MESSAGES[kind];
    const rows = order.items.map(item => `
        <tr>
            <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:14px;color:#111827;">
                ${escapeHtml(item.title)}${item.brandName ? `<br><span style="font-size:12px;color:#6b7280;">${escapeHtml(item.brandName)}</span>` : ''}
            </td>
            <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:14px;color:#374151;text-align:center;">${item.quantity}</td>
            <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:14px;color:#374151;text-align:right;">${money(item.subtotal)}</td>
        </tr>`).join('');
    const address = order.shippingAddress;

    return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:600px;margin:24px auto;background:#ffffff;border-radius:8px;border:1px solid #e5e7eb;padding:24px;">
        <div style="text-align:center;padding-bottom:16px;border-bottom:1px solid #e5e7eb;">
            <img src="${LOGO_URL}" alt="Lumina Beauty" style="height:64px;width:auto;">
            <h2 style="margin:12px 0 4px;font-size:20px;color:${ACCENT};">${escapeHtml(message.title)}</h2>
            <p style="margin:0;font-size:14px;color:#4b5563;">Hola ${escapeHtml(buyer.name || 'cliente')}, ${escapeHtml(message.intro)}</p>
        </div>
        <table style="width:100%;font-size:14px;margin-top:16px;border-collapse:collapse;">
            <tr><td style="padding:4px 0;color:#6b7280;">Pedido</td><td style="padding:4px 0;text-align:right;font-weight:600;color:#111827;">${escapeHtml(order.orderCode)}</td></tr>
            <tr><td style="padding:4px 0;color:#6b7280;">Pago</td><td style="padding:4px 0;text-align:right;color:#111827;">${escapeHtml(PAYMENT_LABELS[order.paymentState] || order.paymentState)}</td></tr>
            <tr><td style="padding:4px 0;color:#6b7280;">Estado</td><td style="padding:4px 0;text-align:right;color:#111827;">${escapeHtml(ORDER_LABELS[order.orderState] || order.orderState)}</td></tr>
        </table>
        <table style="width:100%;margin-top:16px;border-collapse:collapse;">
            <thead><tr>
                <th style="text-align:left;font-size:12px;color:#6b7280;padding-bottom:6px;">Producto</th>
                <th style="text-align:center;font-size:12px;color:#6b7280;padding-bottom:6px;">Cant.</th>
                <th style="text-align:right;font-size:12px;color:#6b7280;padding-bottom:6px;">Subtotal</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>
        <p style="text-align:right;font-size:18px;font-weight:700;color:#111827;margin:12px 0 0;">Total ${money(order.total)}</p>
        <p style="font-size:13px;color:#4b5563;margin:16px 0 0;line-height:1.5;">
            <strong>Entrega en:</strong> ${escapeHtml(address.full_address)}, ${escapeHtml(address.municipality)}, ${escapeHtml(address.department)}
        </p>
        <p style="font-size:12px;color:#9ca3af;text-align:center;margin:24px 0 0;">Lumina Beauty · Este correo se generó automáticamente.</p>
    </div>
</body>
</html>`;
};

/**
 * Envía el correo de un momento del pedido. Es de mejor esfuerzo: nunca debe romper la
 * operación del pedido, así que quien lo llama debe tratar el rechazo como un aviso.
 */
const sendOrderEmail = async (order, buyer, kind) => {
    if (!buyer?.email || !MESSAGES[kind]) return;
    await transporter.sendMail({
        from: '"Lumina Beauty" <no-reply@luminabeauty.com>',
        to: buyer.email,
        subject: `[Lumina Beauty] ${MESSAGES[kind].subject(order.orderCode)}`,
        html: renderOrderEmail(order, buyer, kind),
    });
};

module.exports = { sendOrderEmail, renderOrderEmail, escapeHtml };
