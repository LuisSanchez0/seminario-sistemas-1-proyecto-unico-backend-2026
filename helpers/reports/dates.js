// Fechas de negocio de los reportes. La tienda opera en Guatemala (UTC-6, sin horario de
// verano), así que "hoy", "esta semana" y "este mes" se calculan en esa zona y nunca con el
// día UTC del servidor. Un día es el intervalo semiabierto [00:00 de ese día, 00:00 del siguiente).

const TIMEZONE = 'America/Guatemala';
const UTC_OFFSET = '-06:00';
const UTC_OFFSET_MS = -6 * 60 * 60 * 1000;

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = value => String(value).padStart(2, '0');

const isValidDay = value => {
    const match = DAY_PATTERN.exec(String(value ?? ''));
    if (!match) return false;
    const [, year, month, day] = match.map(Number);
    const check = new Date(Date.UTC(year, month - 1, day));
    return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
};

// 'YYYY-MM-DD' de Guatemala para un instante.
const dayInTimezone = (instant = new Date()) => new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(instant);

const addDays = (day, amount) => {
    const [year, month, date] = day.split('-').map(Number);
    const shifted = new Date(Date.UTC(year, month - 1, date + amount));
    return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
};

const dayStart = day => new Date(`${day}T00:00:00.000${UTC_OFFSET}`);

// Límites [from, toExclusive) en instantes UTC para un rango inclusivo de días locales.
const rangeBounds = (startDate, endDate) => ({
    from: dayStart(startDate),
    toExclusive: dayStart(addDays(endDate, 1)),
});

const daysBetween = (startDate, endDate) =>
    Math.round((dayStart(endDate) - dayStart(startDate)) / 86400000) + 1;

const PERIODS = ['today', 'week', 'month', 'custom'];

const PERIOD_LABELS = { today: 'Hoy', week: 'Esta semana', month: 'Este mes', custom: 'Rango personalizado' };

/**
 * Resuelve un período del dashboard a un rango de días locales.
 *   today -> el día actual
 *   week  -> de lunes al día actual (la semana empieza el lunes)
 *   month -> del día 1 del mes al día actual
 */
const resolvePeriod = (period, { startDate, endDate } = {}, now = new Date()) => {
    const today = dayInTimezone(now);
    if (period === 'today') return { key: 'today', startDate: today, endDate: today };
    if (period === 'week') {
        const [year, month, date] = today.split('-').map(Number);
        const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay(); // 0 = domingo
        return { key: 'week', startDate: addDays(today, -((weekday + 6) % 7)), endDate: today };
    }
    if (period === 'month') return { key: 'month', startDate: `${today.slice(0, 8)}01`, endDate: today };
    return { key: 'custom', startDate, endDate };
};

// Fecha y hora local para PDF/pantalla: dd/mm/aaaa hh:mm (24 h).
const formatLocalDateTime = instant => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('es-GT', {
        timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(instant).map(part => [part.type, part.value]));
    return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
};

const formatLocalDay = day => {
    const [year, month, date] = day.split('-');
    return `${date}/${month}/${year}`;
};

// Excel no guarda zonas horarias: se escribe la hora de pared de Guatemala como si fuera UTC
// para que la celda muestre exactamente la hora local del pedido.
const toWallClockDate = instant => new Date(instant.getTime() + UTC_OFFSET_MS);

module.exports = {
    TIMEZONE,
    UTC_OFFSET,
    PERIODS,
    PERIOD_LABELS,
    isValidDay,
    dayInTimezone,
    addDays,
    dayStart,
    rangeBounds,
    daysBetween,
    resolvePeriod,
    formatLocalDateTime,
    formatLocalDay,
    toWallClockDate,
};
