const { BUILDERS } = require('./data');
const { renderReportPdf } = require('./pdf');
const { renderReportXlsx } = require('./xlsx');
const { parseReportFilters, parsePaging, ReportError, REPORT_TYPES } = require('./filters');

const EXPORT_FORMATS = {
    pdf: { extension: 'pdf', contentType: 'application/pdf', render: renderReportPdf },
    xlsx: {
        extension: 'xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        render: renderReportXlsx,
    },
};

// Reporte para la pantalla: resumen completo y una página de filas.
const buildScreenReport = async (type, query, now = new Date()) => {
    const filters = parseReportFilters(type, query);
    const { limit, offset } = parsePaging(query);
    const report = await BUILDERS[type](filters, { all: false, limit, offset }, now);
    return { filters, report, limit, offset };
};

// Reporte para exportar: SIEMPRE todas las filas del filtro, sin importar la paginación.
const exportReport = async (type, format, query, now = new Date()) => {
    const target = EXPORT_FORMATS[format];
    if (!target) throw new ReportError(400, 'El formato debe ser pdf o xlsx');
    const filters = parseReportFilters(type, query);
    const report = await BUILDERS[type](filters, { all: true }, now);
    const buffer = await target.render(report, { generatedAt: now });
    return {
        buffer,
        contentType: target.contentType,
        fileName: `${report.fileBase}.${target.extension}`,
        report,
    };
};

module.exports = { buildScreenReport, exportReport, EXPORT_FORMATS, REPORT_TYPES, ReportError };
