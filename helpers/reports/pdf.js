// PDF de reportes (pdfkit). Recibe el reporte ya calculado (todas las filas filtradas) y lo
// dibuja con encabezado, filtros, indicadores, tablas con encabezado repetido, totales y
// numeración de páginas. Tamaño Carta, horizontal cuando la tabla tiene muchas columnas.
const PDFDocument = require('pdfkit');
const { formatLocalDateTime, TIMEZONE } = require('./dates');

const STORE_NAME = 'Lumina Beauty';
const ACCENT = '#8a2252';
const ACCENT_SOFT = '#f6e7ee';
const TEXT = '#1f2937';
const MUTED = '#6b7280';
const LINE = '#d1d5db';
const STRIPE = '#f9fafb';

const MARGIN = 36;
const CELL_PAD_X = 4;
const CELL_PAD_Y = 3.5;
const FONT = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';

const number = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// Las fuentes estándar de PDF solo cubren Latin-1: se evita imprimir símbolos que saldrían rotos.
const safe = value => String(value ?? '')
    .normalize('NFC')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/[^\u0020-\u007E\u00A0-\u00FF]/g, '?');

const formatValue = (type, value) => {
    if (value === null || value === undefined || value === '') return '';
    if (type === 'money') return `Q${number.format(value)}`;
    if (type === 'int') return integer.format(value);
    if (type === 'percent') return `${percent.format(value * 100)} %`;
    if (type === 'datetime') return formatLocalDateTime(new Date(value));
    return safe(value);
};

const alignOf = type => (['money', 'int', 'percent'].includes(type) ? 'right' : 'left');

// Reparte el ancho según el peso de cada columna, pero las columnas numéricas nunca se hacen más
// angostas que su valor más largo (incluido el total en negrita): una cifra partida en dos líneas
// es ilegible y puede confundirse con dos importes.
const columnWidths = (doc, columns, rows, totals, totalWidth, fontSize) => {
    const weights = columns.map(column => column.width ?? 10);
    const needs = columns.map((column, index) => {
        if (!['money', 'int', 'percent'].includes(column.type)) return 0;
        doc.font(FONT).fontSize(fontSize);
        let longest = Math.max(0, ...rows.map(row => doc.widthOfString(formatValue(column.type, row[column.key]))));
        if (totals && index > 0 && totals[column.key] !== undefined) {
            doc.font(FONT_BOLD).fontSize(fontSize);
            longest = Math.max(longest, doc.widthOfString(formatValue(column.type, totals[column.key])));
        }
        return longest ? longest + CELL_PAD_X * 2 + 1 : 0;
    });
    const pinned = new Set();
    let widths;
    for (let pass = 0; pass <= columns.length; pass += 1) {
        const free = totalWidth - [...pinned].reduce((sum, index) => sum + needs[index], 0);
        const weight = weights.reduce((sum, value, index) => (pinned.has(index) ? sum : sum + value), 0);
        widths = weights.map((value, index) => (pinned.has(index) ? needs[index] : (value / weight) * free));
        const grown = widths.findIndex((value, index) => !pinned.has(index) && needs[index] > value);
        if (grown === -1 || free <= 0) break;
        pinned.add(grown);
    }
    return widths;
};

const drawTable = (doc, { title, columns, rows, totals, fontSize: baseFontSize = 8, emptyMessage, x, width: fixedWidth }) => {
    const left = x ?? doc.page.margins.left;
    const width = fixedWidth ?? doc.page.width - doc.page.margins.left - doc.page.margins.right;
    // Si las cifras largas dejan sin sitio al texto, se baja la letra (hasta 7 pt) antes de partir líneas.
    let fontSize = baseFontSize;
    let widths = columnWidths(doc, columns, rows, totals, width, fontSize);
    const weightTotal = columns.reduce((sum, column) => sum + (column.width ?? 10), 0);
    const squeezed = list => list.some((value, index) => ['text', 'datetime'].includes(columns[index].type)
        && value < 0.95 * ((columns[index].width ?? 10) / weightTotal) * width);
    while (squeezed(widths) && fontSize > baseFontSize - 1) {
        fontSize -= 0.5;
        widths = columnWidths(doc, columns, rows, totals, width, fontSize);
    }
    const bottom = () => doc.page.height - doc.page.margins.bottom - 6; // deja sitio al pie de página

    const heightOf = (cells, bold) => {
        doc.font(bold ? FONT_BOLD : FONT).fontSize(fontSize);
        return Math.max(...cells.map((text, index) => doc.heightOfString(text, {
            width: widths[index] - CELL_PAD_X * 2, align: alignOf(columns[index].type),
        }))) + CELL_PAD_Y * 2;
    };

    const headerCells = columns.map(column => safe(column.header));
    const headerHeight = heightOf(headerCells, true);

    const drawHeader = () => {
        const y = doc.y;
        doc.save().rect(left, y, width, headerHeight).fill(ACCENT).restore();
        let x = left;
        doc.font(FONT_BOLD).fontSize(fontSize).fillColor('#ffffff');
        headerCells.forEach((text, index) => {
            doc.text(text, x + CELL_PAD_X, y + CELL_PAD_Y, {
                width: widths[index] - CELL_PAD_X * 2, align: alignOf(columns[index].type),
            });
            x += widths[index];
        });
        doc.y = y + headerHeight;
        doc.x = left;
    };

    const drawRow = (cells, height, { bold = false, fill, topLine = false } = {}) => {
        const y = doc.y;
        if (fill) doc.save().rect(left, y, width, height).fill(fill).restore();
        if (topLine) doc.save().moveTo(left, y).lineTo(left + width, y).lineWidth(1).strokeColor(ACCENT).stroke().restore();
        let x = left;
        doc.font(bold ? FONT_BOLD : FONT).fontSize(fontSize).fillColor(TEXT);
        cells.forEach((text, index) => {
            doc.text(text, x + CELL_PAD_X, y + CELL_PAD_Y, {
                width: widths[index] - CELL_PAD_X * 2, align: alignOf(columns[index].type),
            });
            x += widths[index];
        });
        doc.save().moveTo(left, y + height).lineTo(left + width, y + height).lineWidth(0.4).strokeColor(LINE).stroke().restore();
        doc.y = y + height;
        doc.x = left;
    };

    const ensureSpace = needed => {
        if (doc.y + needed > bottom()) {
            doc.addPage();
            return true;
        }
        return false;
    };

    if (title) {
        // El título no puede quedar solo al final de una página: se exige sitio para al menos una fila.
        const sampleRow = rows[0] ? columns.map(column => formatValue(column.type, rows[0][column.key])) : headerCells;
        ensureSpace(22 + headerHeight + heightOf(sampleRow, false));
        doc.font(FONT_BOLD).fontSize(10.5).fillColor(ACCENT).text(safe(title), left, doc.y, { width });
        doc.moveDown(0.3);
    }

    if (!rows.length) {
        ensureSpace(headerHeight + 24);
        drawHeader();
        doc.font(FONT).fontSize(fontSize + 1).fillColor(MUTED)
            .text(emptyMessage ?? 'No se encontraron registros para los filtros seleccionados.', left + CELL_PAD_X, doc.y + 8, { width });
        doc.moveDown(1);
        return;
    }

    const totalCells = totals
        ? columns.map((column, index) => (index === 0 ? 'Totales' : formatValue(column.type, totals[column.key])))
        : null;
    const totalsHeight = totalCells ? heightOf(totalCells, true) : 0;

    const firstCells = columns.map(column => formatValue(column.type, rows[0][column.key]));
    ensureSpace(headerHeight + heightOf(firstCells, false));
    drawHeader();

    rows.forEach((row, rowIndex) => {
        const cells = columns.map(column => formatValue(column.type, row[column.key]));
        const height = heightOf(cells, false);
        // La última fila viaja siempre junto a la fila de totales.
        const needed = rowIndex === rows.length - 1 ? height + totalsHeight : height;
        if (ensureSpace(needed)) drawHeader();
        drawRow(cells, height, { fill: rowIndex % 2 ? STRIPE : undefined });
    });

    if (totalCells) drawRow(totalCells, totalsHeight, { bold: true, fill: ACCENT_SOFT, topLine: true });
    doc.moveDown(0.8);
};

// Alto aproximado de una tabla pequeña (título + encabezado + filas + totales).
const estimateTableHeight = table => 22 + 20 + (table.rows.length + (table.totals ? 1 : 0)) * 17;

// Los desgloses (2 tablas pequeñas) van lado a lado en horizontal y apilados en vertical.
const drawBreakdowns = (doc, breakdowns) => {
    const tables = breakdowns.filter(item => item.rows.length);
    if (!tables.length) return;
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const pairable = doc.page.layout === 'landscape' && tables.length === 2;
    if (!pairable) {
        for (const table of tables) drawTable(doc, { ...table, fontSize: 8 });
        return;
    }
    const gap = 16;
    const half = (width - gap) / 2;
    const tallest = Math.max(...tables.map(estimateTableHeight));
    if (doc.y + tallest > doc.page.height - doc.page.margins.bottom - 6) doc.addPage();
    const startY = doc.y;
    let endY = startY;
    tables.forEach((table, index) => {
        doc.y = startY;
        drawTable(doc, { ...table, fontSize: 8, x: left + index * (half + gap), width: half });
        endY = Math.max(endY, doc.y);
    });
    doc.x = left;
    doc.y = endY;
};

const drawKpis = (doc, kpis) => {
    const left = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const perRow = width > 600 ? 5 : 3;
    const gap = 8;
    const cardWidth = (width - gap * (perRow - 1)) / perRow;
    const cardHeight = 38;
    let y = doc.y;

    kpis.forEach((kpi, index) => {
        const column = index % perRow;
        if (column === 0 && index > 0) y += cardHeight + gap;
        if (y + cardHeight > doc.page.height - doc.page.margins.bottom - 6) {
            doc.addPage();
            y = doc.y;
        }
        const x = left + column * (cardWidth + gap);
        doc.save().roundedRect(x, y, cardWidth, cardHeight, 4).fillAndStroke(ACCENT_SOFT, LINE).restore();
        doc.font(FONT).fontSize(7.5).fillColor(MUTED)
            .text(safe(kpi.label), x + 7, y + 6, { width: cardWidth - 14, lineBreak: false, ellipsis: true });
        doc.font(FONT_BOLD).fontSize(13).fillColor(TEXT)
            .text(formatValue(kpi.type, kpi.value), x + 7, y + 18, { width: cardWidth - 14, lineBreak: false, ellipsis: true });
    });
    doc.x = left;
    doc.y = y + cardHeight + 10;
};

const drawHeaderBlock = (doc, report, generatedAt) => {
    const left = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    doc.font(FONT_BOLD).fontSize(9).fillColor(ACCENT).text(STORE_NAME.toUpperCase(), left, doc.y, { characterSpacing: 2, width });
    doc.font(FONT_BOLD).fontSize(19).fillColor(TEXT).text(safe(report.title), left, doc.y + 2, { width });
    doc.font(FONT).fontSize(8.5).fillColor(MUTED)
        .text(`Generado el ${formatLocalDateTime(generatedAt)} (hora de ${TIMEZONE.split('/')[1]})`, left, doc.y + 2, { width });
    doc.moveDown(0.5);
    doc.save().moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(1.5).strokeColor(ACCENT).stroke().restore();
    doc.moveDown(0.6);

    // Filtros aplicados, en dos columnas.
    doc.font(FONT_BOLD).fontSize(9).fillColor(TEXT).text('Filtros aplicados', left, doc.y, { width });
    doc.moveDown(0.25);
    const colWidth = (width - 12) / 2;
    const startY = doc.y;
    const heights = [0, 0];
    report.filters.forEach((filter, index) => {
        const column = index % 2;
        const x = left + column * (colWidth + 12);
        const y = startY + heights[column];
        doc.font(FONT_BOLD).fontSize(8.5).fillColor(MUTED).text(`${safe(filter.label)}: `, x, y, { continued: true, width: colWidth });
        doc.font(FONT).fillColor(TEXT).text(safe(filter.value), { width: colWidth });
        heights[column] = doc.y - startY + 1.5;
    });
    doc.x = left;
    doc.y = startY + Math.max(...heights) + 8;
};

const drawFooters = (doc, report) => {
    const range = doc.bufferedPageRange();
    for (let index = 0; index < range.count; index += 1) {
        doc.switchToPage(range.start + index);
        const left = doc.page.margins.left;
        const width = doc.page.width - left - doc.page.margins.right;
        const y = doc.page.height - 30;
        // El pie va dentro del margen inferior: se anula para que pdfkit no agregue páginas.
        const bottomMargin = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.save().moveTo(left, y - 4).lineTo(left + width, y - 4).lineWidth(0.4).strokeColor(LINE).stroke().restore();
        doc.font(FONT).fontSize(8).fillColor(MUTED)
            .text(`${STORE_NAME} - ${safe(report.title)}`, left, y, { width: width / 2, lineBreak: false });
        doc.text(`Página ${index + 1} de ${range.count}`, left + width / 2, y, { width: width / 2, align: 'right', lineBreak: false });
        doc.page.margins.bottom = bottomMargin;
    }
};

const renderReportPdf = (report, { generatedAt = new Date() } = {}) => new Promise((resolve, reject) => {
    const landscape = report.columns.length > 7;
    const doc = new PDFDocument({
        size: 'LETTER',
        layout: landscape ? 'landscape' : 'portrait',
        margins: { top: MARGIN, bottom: MARGIN + 12, left: MARGIN, right: MARGIN },
        bufferPages: true,
        info: {
            Title: safe(report.title),
            Author: STORE_NAME,
            Subject: report.filters.map(filter => `${filter.label}: ${filter.value}`).join(' | ').slice(0, 500),
            Creator: STORE_NAME,
        },
    });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
        drawHeaderBlock(doc, report, generatedAt);
        drawKpis(doc, report.kpis);
        drawBreakdowns(doc, report.breakdowns ?? []);
        drawTable(doc, {
            title: 'Detalle',
            columns: report.columns,
            rows: report.rows,
            totals: report.rows.length ? report.totals : null,
            fontSize: landscape ? 7.8 : 8.2,
        });
        if (report.notes?.length) {
            if (doc.y + 60 > doc.page.height - doc.page.margins.bottom - 6) doc.addPage();
            const left = doc.page.margins.left;
            const width = doc.page.width - left - doc.page.margins.right;
            doc.font(FONT_BOLD).fontSize(8.5).fillColor(TEXT).text('Definiciones', left, doc.y, { width });
            doc.font(FONT).fontSize(8).fillColor(MUTED);
            for (const note of report.notes) doc.text(`- ${safe(note)}`, left, doc.y + 1, { width });
        }
        drawFooters(doc, report);
        doc.end();
    } catch (error) {
        reject(error);
    }
});

module.exports = { renderReportPdf, formatValue };
