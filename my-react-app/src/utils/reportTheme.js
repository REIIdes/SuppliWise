/**
 * Shared visual language for the printable SuppliWise reports.
 *
 * jsPDF's built-in Helvetica font is intentionally limited to a small,
 * Windows-safe character set.  Keeping the colour tokens and text cleanup in
 * one place prevents the admin security report and the wellness report from
 * slowly drifting into two different products.
 */

export const REPORT_COLORS = Object.freeze({
  navy: [15, 23, 42],
  deep: [8, 47, 73],
  emerald: [5, 150, 105],
  teal: [13, 148, 136],
  cyan: [6, 182, 212],
  indigo: [79, 70, 229],
  violet: [139, 92, 246],
  amber: [245, 158, 11],
  orange: [249, 115, 22],
  rose: [244, 63, 94],
  red: [225, 29, 72],
  ink: [15, 23, 42],
  muted: [100, 116, 139],
  line: [226, 232, 240],
  white: [255, 255, 255],
  emeraldLight: [236, 253, 245],
  tealLight: [240, 253, 250],
  indigoLight: [238, 242, 255],
  violetLight: [245, 243, 255],
  amberLight: [255, 251, 235],
  roseLight: [255, 241, 242],
  slateLight: [248, 250, 252],
});

export const REPORT_LAYOUT = Object.freeze({
  pageWidth: 210,
  pageHeight: 297,
  margin: 15,
  contentWidth: 180,
  footerHeight: 11,
  firstContentTop: 67,
  continuationContentTop: 27,
});

/**
 * Convert arbitrary AI/user text to a string that the standard PDF font can
 * render without replacement glyphs.  Nullish values are intentionally kept
 * nullish so callers can decide whether to render a fallback.
 */
export function cleanReportText(value) {
  if (value === null || value === undefined) return value;
  return String(value)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[àáâãäå]/gi, 'a')
    .replace(/[èéêë]/gi, 'e')
    .replace(/[ìíîï]/gi, 'i')
    .replace(/[òóôõö]/gi, 'o')
    .replace(/[ùúûü]/gi, 'u')
    .replace(/[ýÿ]/gi, 'y')
    .replace(/ñ/gi, 'n')
    .replace(/ç/gi, 'c')
    .replace(/ß/g, 'ss')
    .replace(/œ/gi, 'oe')
    .replace(/æ/gi, 'ae')
    .replace(/•/g, '-')
    .replace(/·/g, '-')
    .replace(/→/g, '->')
    .replace(/←/g, '<-')
    .replace(/×/g, 'x')
    .replace(/÷/g, '/')
    .replace(/°/g, ' degrees')
    .replace(/±/g, '+/-')
    .replace(/©/g, '(c)')
    .replace(/®/g, '(R)')
    .replace(/™/g, '(TM)')
    // Common UTF-8/Windows-1252 mojibake seen in older assessment rows.
    .replace(/ΓÇô|ΓÇö|ΓÇò/g, '-')
    .replace(/â€™|â€œ|â€/g, "'")
    .replace(/â€“|â€”/g, '-')
    .replace(/�/g, '')
    .replace(/½/g, '1/2')
    .replace(/¼/g, '1/4')
    .replace(/¾/g, '3/4')
    // Keep tabs/newlines for intentional line breaks in table cells.
    // eslint-disable-next-line no-control-regex -- the allowed control range is intentional
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
}

export function reportText(value, fallback = '-') {
  const cleaned = cleanReportText(value);
  return cleaned === null || cleaned === undefined || String(cleaned).trim() === ''
    ? fallback
    : String(cleaned);
}

export function formatReportDate(value, withTime = false) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Not available';
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: true } : {}),
  });
}

export function safeFilenamePart(value, fallback = 'report') {
  const cleaned = cleanReportText(value)
    ?.replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return cleaned || fallback;
}

/**
 * Draw the branded report header.  The first page uses the tall cover header;
 * continuation pages use a compact bar so auto-table rows never sit underneath
 * the brand block.
 */
export function drawReportHeader(doc, {
  title = 'SuppliWise',
  subtitle = 'Personalized report',
  preparedFor = '',
  dateLabel = '',
  dateValue = '',
  badge = '',
  pageNumber = 1,
  compact = false,
  status = '',
  statusColor = REPORT_COLORS.emerald,
} = {}) {
  const width = doc.internal.pageSize.getWidth();

  if (compact) {
    doc.setFillColor(...REPORT_COLORS.deep);
    doc.rect(0, 0, width, 20, 'F');
    doc.setFillColor(...REPORT_COLORS.emerald);
    doc.rect(0, 0, width * 0.36, 2, 'F');
    doc.setFillColor(...REPORT_COLORS.indigo);
    doc.rect(width * 0.36, 0, width * 0.34, 2, 'F');
    doc.setFillColor(...REPORT_COLORS.rose);
    doc.rect(width * 0.70, 0, width * 0.30, 2, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...REPORT_COLORS.white);
    doc.text(reportText(title, 'SuppliWise'), 15, 8.5);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(203, 213, 225);
    doc.text(reportText(subtitle, ''), 15, 15);
    doc.text(`PAGE ${pageNumber}`, width - 15, 12, { align: 'right' });
    return;
  }

  const height = 58;
  doc.setFillColor(...REPORT_COLORS.navy);
  doc.rect(0, 0, width, height, 'F');

  // A four-colour rail gives the monochrome PDF a recognisable, vibrant brand
  // cue without relying on a browser gradient (which jsPDF does not support).
  doc.setFillColor(...REPORT_COLORS.emerald);
  doc.rect(0, 0, width, 4, 'F');
  doc.setFillColor(...REPORT_COLORS.teal);
  doc.rect(0, 4, width * 0.31, 2, 'F');
  doc.setFillColor(...REPORT_COLORS.indigo);
  doc.rect(width * 0.31, 4, width * 0.39, 2, 'F');
  doc.setFillColor(...REPORT_COLORS.rose);
  doc.rect(width * 0.70, 4, width * 0.30, 2, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(24);
  doc.setTextColor(...REPORT_COLORS.white);
  doc.text(reportText(title, 'SuppliWise'), 15, 22);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  doc.setTextColor(209, 250, 229);
  doc.text(reportText(subtitle, ''), 15, 31);

  doc.setFontSize(8.5);
  doc.setTextColor(203, 213, 225);
  if (preparedFor) doc.text(`Prepared for ${reportText(preparedFor)}`, 15, 41);
  if (dateLabel) doc.text(reportText(dateLabel, ''), 15, 48);

  // Metadata card / confidentiality badge.
  const cardX = width - 66;
  doc.setFillColor(...REPORT_COLORS.indigo);
  doc.roundedRect(cardX, 11, 51, 35, 3, 3, 'F');
  doc.setFillColor(...REPORT_COLORS.violet);
  doc.roundedRect(cardX, 11, 51, 8, 3, 3, 'F');
  doc.setFillColor(...REPORT_COLORS.indigo);
  doc.rect(cardX, 15, 51, 4, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(...REPORT_COLORS.white);
  doc.text(badge ? reportText(badge, 'REPORT').toUpperCase() : 'REPORT', cardX + 25.5, 16.3, { align: 'center' });

  doc.setFontSize(6.5);
  doc.setTextColor(224, 231, 255);
  doc.text('GENERATED', cardX + 5, 24);
  doc.setFontSize(7.6);
  doc.setTextColor(...REPORT_COLORS.white);
  const cardDate = dateValue || (dateLabel ? reportText(dateLabel, '').replace(/^Assessment:\s*/i, '').split('  ')[0] : 'Today');
  doc.text(cardDate, cardX + 5, 30, { maxWidth: 41 });
  if (status) {
    doc.setFontSize(6.5);
    doc.setTextColor(224, 231, 255);
    doc.text('STATUS', cardX + 5, 35);
    doc.setFontSize(7.2);
    const safeStatusColor = Array.isArray(statusColor) && statusColor.length >= 3 ? statusColor : REPORT_COLORS.white;
    doc.setFillColor(...safeStatusColor);
    doc.circle(cardX + 6, 40, 1.2, 'F');
    doc.setTextColor(...REPORT_COLORS.white);
    doc.text(reportText(status, ''), cardX + 10, 41, { maxWidth: 36 });
  }

  doc.setFillColor(...REPORT_COLORS.emerald);
  doc.rect(0, height - 1.5, width, 1.5, 'F');
}

export function addReportPage(doc, options = {}) {
  doc.addPage();
  const pageNumber = doc.internal.getNumberOfPages();
  drawReportHeader(doc, { ...options, compact: true, pageNumber });
  return REPORT_LAYOUT.continuationContentTop;
}

export function drawReportFooter(doc, {
  leftText = 'SuppliWise | Confidential report',
} = {}) {
  const { pageWidth, pageHeight, margin, footerHeight } = REPORT_LAYOUT;
  const total = doc.internal.getNumberOfPages();
  for (let page = 1; page <= total; page += 1) {
    doc.setPage(page);
    doc.setFillColor(...REPORT_COLORS.navy);
    doc.rect(0, pageHeight - footerHeight, pageWidth, footerHeight, 'F');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(226, 232, 240);
    doc.text(reportText(leftText, ''), margin, pageHeight - 3.5, { maxWidth: pageWidth - margin * 2 - 28 });
    doc.text(`${page} / ${total}`, pageWidth - margin, pageHeight - 3.5, { align: 'right' });
  }
}

export function drawSectionHeading(doc, label, y, accent = REPORT_COLORS.emerald) {
  const { margin, contentWidth } = REPORT_LAYOUT;
  const safeY = Number.isFinite(Number(y)) ? Number(y) : 0;
  const safeAccent = Array.isArray(accent) && accent.length >= 3 ? accent : REPORT_COLORS.emerald;
  doc.setFillColor(...safeAccent);
  doc.roundedRect(margin, safeY, 3.5, 8, 1.2, 1.2, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12.5);
  doc.setTextColor(...REPORT_COLORS.ink);
  doc.text(reportText(label, '').toUpperCase(), margin + 8, safeY + 6.1);
  doc.setDrawColor(...REPORT_COLORS.line);
  doc.setLineWidth(0.35);
  doc.line(margin, safeY + 10, margin + contentWidth, safeY + 10);
  return safeY + 15;
}

export function drawPill(doc, text, x, y, width, color, { height = 8, fontSize = 7.5 } = {}) {
  doc.setFillColor(...color);
  doc.roundedRect(x, y, width, height, height / 2, height / 2, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(fontSize);
  doc.setTextColor(...REPORT_COLORS.white);
  doc.text(reportText(text, '').toUpperCase(), x + width / 2, y + height * 0.68, {
    align: 'center',
    maxWidth: width - 3,
  });
}

export function downloadPdf(doc, filename) {
  const safeName = safeFilenamePart(filename, 'suppliwise-report.pdf').replace(/-pdf$/i, '') + '.pdf';
  const saveWithLink = () => {
    if (typeof document === 'undefined') throw new Error('PDF download is unavailable in this runtime.');
    const link = document.createElement('a');
    link.href = doc.output('datauristring');
    link.download = safeName;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Capacitor's Android WebView does not consistently implement the browser
  // download shortcut. Use an explicit anchor there; desktop gets jsPDF's
  // native save path, with the anchor retained as a fallback.
  const isNativeWebView = typeof window !== 'undefined'
    && Boolean(window.Capacitor?.isNativePlatform?.() || window.Capacitor);
  if (isNativeWebView) {
    saveWithLink();
    return safeName;
  }

  try {
    doc.save(safeName);
    return safeName;
  } catch {
    saveWithLink();
    return safeName;
  }
}
