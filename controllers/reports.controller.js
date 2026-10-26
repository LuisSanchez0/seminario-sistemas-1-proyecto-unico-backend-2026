const { response } = require('express');
const { buildScreenReport, exportReport, ReportError } = require('../helpers/reports');
const { buildDashboard } = require('../helpers/reports/dashboard');
const { PERIODS, isValidDay, daysBetween } = require('../helpers/reports/dates');
const { DEFAULT_LOW_STOCK_THRESHOLD, MAX_RANGE_DAYS } = require('../helpers/reports/filters');

// Nunca se devuelve el mensaje de una excepción inesperada: solo los errores de validación propios.
const failure = (res, error, fallback) => {
    if (error instanceof ReportError) return res.status(error.status).json({ ok: false, msg: error.message });
    console.error(fallback, error);
    return res.status(500).json({ ok: false, msg: fallback });
};

const getReport = async (req, res = response) => {
    try {
        const { filters, report, limit, offset } = await buildScreenReport(req.params.type, req.query);
        return res.status(200).json({
            ok: true,
            filters,
            report,
            count: report.rowCount,
            limit,
            offset,
            pages: Math.ceil(report.rowCount / limit),
        });
    } catch (error) {
        return failure(res, error, 'No se pudo generar el reporte');
    }
};

const downloadReport = async (req, res = response) => {
    try {
        const { buffer, contentType, fileName } = await exportReport(req.params.type, req.query.format, req.query);
        res.set({
            'Content-Type': contentType,
            'Content-Length': buffer.length,
            'Content-Disposition': `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
            'Cache-Control': 'no-store',
            'Access-Control-Expose-Headers': 'Content-Disposition',
            'X-Content-Type-Options': 'nosniff',
        });
        return res.status(200).end(buffer);
    } catch (error) {
        return failure(res, error, 'No se pudo exportar el reporte');
    }
};

const getDashboard = async (req, res = response) => {
    try {
        const { period = 'month', startDate, endDate } = req.query;
        if (!PERIODS.includes(period)) throw new ReportError(400, 'El período no es válido');
        if (period === 'custom') {
            if (!isValidDay(startDate) || !isValidDay(endDate)) throw new ReportError(400, 'El rango de fechas no es válido (usa AAAA-MM-DD)');
            if (startDate > endDate) throw new ReportError(400, 'La fecha inicial no puede ser mayor que la fecha final');
            if (daysBetween(startDate, endDate) > MAX_RANGE_DAYS) throw new ReportError(400, 'El rango de fechas no puede exceder 5 años');
        }
        const rawThreshold = req.query.lowStockThreshold;
        const lowStockThreshold = rawThreshold === undefined ? DEFAULT_LOW_STOCK_THRESHOLD : Number(rawThreshold);
        if (!Number.isInteger(lowStockThreshold) || lowStockThreshold < 1 || lowStockThreshold > 1000) {
            throw new ReportError(400, 'El umbral de stock bajo debe ser un entero entre 1 y 1000');
        }
        const dashboard = await buildDashboard({ period, startDate, endDate, lowStockThreshold });
        return res.status(200).json({ ok: true, ...dashboard });
    } catch (error) {
        return failure(res, error, 'No se pudo cargar el panel');
    }
};

module.exports = { getReport, downloadReport, getDashboard };
