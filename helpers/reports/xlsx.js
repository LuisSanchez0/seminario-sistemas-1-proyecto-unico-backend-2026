// Libro de Excel de reportes (exceljs). Los importes son celdas numéricas con formato de
// moneda, las fechas son fechas reales y los totales son fórmulas SUBTOTAL (respetan el
// autofiltro) con su resultado ya calculado, para que el libro sea analizable y no solo texto.
const ExcelJS = require('exceljs');
const { formatLocalDateTime, toWallClockDate, TIMEZONE } = require('./dates');

const STORE_NAME = 'Lumina Beauty';
const ACCENT = 'FF8A2252';
const ACCENT_SOFT = 'FFF6E7EE';

const FORMATS = {
    money: '"Q"#,##0.00',
    int: '#,##0',
    percent: '0.0%',
    datetime: 'dd/mm/yyyy hh:mm',
};

const cellValue = (type, value) => {
    if (value === null || value === undefined || value === '') return null;
    if (type === 'datetime') return toWallClockDate(new Date(value));
    return value;
};

const applyFormat = (cell, type) => {
    if (FORMATS[type]) cell.numFmt = FORMATS[type];
    cell.alignment = { vertical: 'top', horizontal: ['money', 'int', 'percent'].includes(type) ? 'right' : 'left', wrapText: type === 'text' };
};

const headerStyle = cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ACCENT } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } } };
};

const columnLetter = index => {
    let letter = '';
    let n = index;
    while (n > 0) {
        const rest = (n - 1) % 26;
        letter = String.fromCharCode(65 + rest) + letter;
        n = Math.floor((n - 1) / 26);
    }
    return letter;
};

const displayLength = (type, value) => {
    if (value === null || value === undefined) return 0;
    if (type === 'datetime') return 16;
    if (type === 'money') return String(Number(value).toFixed(2)).length + 5;
    if (type === 'percent') return 7;
    return String(value).length;
};

const writeTitle = (sheet, report, generatedAt, columnCount) => {
    sheet.getCell('A1').value = report.title;
    sheet.getCell('A1').font = { bold: true, size: 16, color: { argb: ACCENT } };
    sheet.getCell('A2').value = STORE_NAME;
    sheet.getCell('A2').font = { bold: true, color: { argb: 'FF6B7280' } };
    sheet.getCell('A3').value = `Generado el ${formatLocalDateTime(generatedAt)} (hora de ${TIMEZONE.split('/')[1]}) · ${report.filters.map(filter => `${filter.label}: ${filter.value}`).join(' · ')}`;
    sheet.getCell('A3').font = { color: { argb: 'FF6B7280' }, size: 9 };
    if (columnCount > 1) sheet.mergeCells(1, 1, 1, columnCount);
};

// Escribe una tabla con encabezado, filas tipadas, autofiltro, panel inmovilizado y totales.
const writeTable = (sheet, { columns, rows, totals, headerRow, emptyMessage }) => {
    columns.forEach((column, index) => {
        const cell = sheet.getCell(headerRow, index + 1);
        cell.value = column.header;
        headerStyle(cell);
    });
    sheet.getRow(headerRow).height = 30;

    rows.forEach((row, rowIndex) => {
        columns.forEach((column, columnIndex) => {
            const cell = sheet.getCell(headerRow + 1 + rowIndex, columnIndex + 1);
            cell.value = cellValue(column.type, row[column.key]);
            applyFormat(cell, column.type);
        });
    });

    const first = headerRow + 1;
    const last = headerRow + rows.length;

    if (!rows.length) {
        const cell = sheet.getCell(first, 1);
        cell.value = emptyMessage ?? 'No se encontraron registros para los filtros seleccionados.';
        cell.font = { italic: true, color: { argb: 'FF6B7280' } };
    }

    if (rows.length && totals) {
        const totalsRow = last + 1;
        const labelCell = sheet.getCell(totalsRow, 1);
        labelCell.value = 'Totales';
        columns.forEach((column, index) => {
            const cell = sheet.getCell(totalsRow, index + 1);
            if (index > 0 && totals[column.key] !== undefined && ['money', 'int'].includes(column.type)) {
                const letter = columnLetter(index + 1);
                cell.value = { formula: `SUBTOTAL(109,${letter}${first}:${letter}${last})`, result: totals[column.key] };
                applyFormat(cell, column.type);
            }
            cell.font = { bold: true };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ACCENT_SOFT } };
            cell.border = { top: { style: 'thin', color: { argb: ACCENT } } };
        });
    }

    sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: columns.length } };
    sheet.views = [{ state: 'frozen', ySplit: headerRow, xSplit: 0 }];

    columns.forEach((column, index) => {
        const longest = Math.max(
            String(column.header).length,
            ...rows.slice(0, 500).map(row => displayLength(column.type, row[column.key])),
        );
        sheet.getColumn(index + 1).width = Math.min(Math.max(longest + 3, 11), column.type === 'text' ? 45 : 24);
    });
};

const pageSetup = sheet => {
    sheet.pageSetup = { paperSize: 1, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
};

const addSummarySheet = (workbook, report, generatedAt) => {
    const sheet = workbook.addWorksheet('Resumen');
    sheet.getColumn(1).width = 34;
    sheet.getColumn(2).width = 34;
    writeTitle(sheet, report, generatedAt, 2);
    let row = 5;

    const section = text => {
        const cell = sheet.getCell(row, 1);
        cell.value = text;
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ACCENT } };
        sheet.getCell(row, 2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ACCENT } };
        row += 1;
    };

    section('Filtros aplicados');
    for (const filter of report.filters) {
        sheet.getCell(row, 1).value = filter.label;
        sheet.getCell(row, 2).value = filter.value;
        sheet.getCell(row, 2).alignment = { horizontal: 'left', wrapText: true };
        row += 1;
    }
    row += 1;
    section('Indicadores');
    for (const kpi of report.kpis) {
        sheet.getCell(row, 1).value = kpi.label;
        const cell = sheet.getCell(row, 2);
        cell.value = kpi.value;
        applyFormat(cell, kpi.type);
        cell.font = { bold: true };
        row += 1;
    }
    row += 1;
    section('Definiciones');
    for (const note of report.notes ?? []) {
        sheet.mergeCells(row, 1, row, 2);
        const cell = sheet.getCell(row, 1);
        cell.value = note;
        cell.alignment = { wrapText: true, vertical: 'top' };
        sheet.getRow(row).height = Math.max(15, Math.ceil(note.length / 62) * 15);
        row += 1;
    }
    pageSetup(sheet);
};

const sheetName = (name, used) => {
    const base = name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Hoja';
    let candidate = base;
    for (let i = 2; used.has(candidate); i += 1) candidate = `${base.slice(0, 28)} ${i}`;
    used.add(candidate);
    return candidate;
};

const renderReportXlsx = async (report, { generatedAt = new Date() } = {}) => {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = STORE_NAME;
    workbook.title = report.title;
    workbook.created = generatedAt;
    workbook.modified = generatedAt;

    const used = new Set(['Resumen', 'Detalle']);
    addSummarySheet(workbook, report, generatedAt);

    const detail = workbook.addWorksheet('Detalle');
    writeTitle(detail, report, generatedAt, Math.min(report.columns.length, 6));
    writeTable(detail, { columns: report.columns, rows: report.rows, totals: report.totals, headerRow: 5 });
    pageSetup(detail);

    for (const breakdown of report.breakdowns ?? []) {
        const sheet = workbook.addWorksheet(sheetName(breakdown.title, used));
        writeTitle(sheet, { ...report, title: `${report.title} - ${breakdown.title}` }, generatedAt, Math.min(breakdown.columns.length, 4));
        writeTable(sheet, { columns: breakdown.columns, rows: breakdown.rows, totals: breakdown.totals, headerRow: 5 });
        pageSetup(sheet);
    }

    return Buffer.from(await workbook.xlsx.writeBuffer());
};

module.exports = { renderReportXlsx };
