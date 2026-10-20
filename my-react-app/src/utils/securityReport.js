import {
  REPORT_COLORS as C,
  REPORT_LAYOUT as L,
  cleanReportText,
  downloadPdf,
  drawParagraph,
  drawPill,
  drawReportFooter,
  drawReportHeader,
  drawSectionHeading,
  formatReportDate,
  measureParagraph,
  reportText,
} from './reportTheme.js';
import { isStaleChunkError, markChunkReloadHealthy, reloadOnceForStaleChunk } from './chunkReload.js';

// jsPDF (+ autotable) is ~350 KB of module code that this report needs only
// when an admin actually exports. Statically importing it put the library in
// the /admin route chunk, so the dashboard had to parse a PDF engine before
// its first render. Loading it here keeps it out of the dashboard entirely.
let pdfLibPromise;

function loadPdfLib() {
  if (!pdfLibPromise) {
    pdfLibPromise = Promise.all([import('jspdf'), import('jspdf-autotable')])
      .then(([jsPDFNS, autoTableNS]) => {
        markChunkReloadHealthy();
        // Mirror exactly what the old static `import x from '...'` bound, so
        // both interop shapes (ESM default, CJS double-default) resolve the
        // same way they did before the import became dynamic.
        const jsPDFModule = jsPDFNS?.default;
        const autoTableModule = autoTableNS?.default;
        return {
          JsPDF: jsPDFModule?.jsPDF || jsPDFModule?.default || jsPDFModule,
          renderAutoTable: typeof autoTableModule === 'function'
            ? autoTableModule
            : autoTableModule?.default || autoTableModule?.autoTable,
        };
      });
    // A failed chunk load must not poison every later attempt.
    pdfLibPromise.catch(() => { pdfLibPromise = undefined; });
  }
  return pdfLibPromise;
}

const asArray = (value) => (Array.isArray(value) ? value : []);

const titleCase = (value) => {
  const text = reportText(value, '').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Unknown';
};

const statusKey = (value) => reportText(value, 'unknown').trim().toLowerCase();

const statusColor = (value) => {
  switch (statusKey(value)) {
    case 'secure':
    case 'healthy':
      return C.emerald;
    case 'warning':
    case 'vulnerable':
      return C.amber;
    case 'critical':
    case 'error':
      return C.rose;
    default:
      return C.muted;
  }
};

const statusLabel = (value) => {
  const key = statusKey(value);
  if (key === 'secure' || key === 'healthy') return 'Secure';
  if (key === 'vulnerable' || key === 'warning') return 'Vulnerable';
  if (key === 'critical') return 'Critical';
  if (key === 'error') return 'Error';
  return titleCase(value);
};

const monitorFramework = (key) => {
  const map = {
    login: 'Auth / JWT',
    account_creation: 'Auth / Email',
    email_otp: 'STRIDE',
    totp: 'STRIDE',
    database: 'Infrastructure',
    openrouter: 'AI / API',
    delete_account: 'OWASP',
    input_sanitization: 'OWASP',
    password_hashing: 'OWASP',
    salting: 'OWASP',
    xss_stored: 'OWASP',
    nosql_injection: 'OWASP',
    path_traversal: 'OWASP',
    prototype_pollution: 'OWASP',
    auth_bruteforce: 'STRIDE',
    csrf_stateless: 'OWASP',
    prompt_injection: 'AI / OWASP',
    pii_ai_prompts: 'AI / Privacy',
    ai_quota: 'AI / API',
    jwt_security: 'Auth / JWT',
    headers_security: 'OWASP',
    email_enumeration: 'OWASP',
    sensitive_data: 'OWASP',
    rate_limit_lockout: 'STRIDE',
  };
  if (map[key]) return map[key];
  return String(key || '').startsWith('bc_') ? 'Blockchain' : 'Security';
};

const severityColor = (severity) => {
  switch (statusKey(severity)) {
    case 'critical': return C.rose;
    case 'high': return C.orange;
    case 'medium': return C.amber;
    case 'low': return C.indigo;
    default: return C.muted;
  }
};

export function drawKpi(doc, x, y, width, height, value, label, color, fill) {
  doc.setFillColor(...fill);
  doc.setDrawColor(...C.line);
  doc.setLineWidth(0.3);
  doc.roundedRect(x, y, width, height, 2.5, 2.5, 'FD');
  doc.setFillColor(...color);
  doc.rect(x, y, width, 2.5, 'F');
  // Baselines are fractions of the box, not fixed offsets: the same helper draws
  // both the 25 mm headline tiles and the shorter stat tiles, and a hard-coded
  // `y + 19` sits outside a box that is only 21 mm tall.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...C.ink);
  doc.text(reportText(value, '0'), x + 5, y + height * 0.48, { maxWidth: width - 10 });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.2);
  doc.setTextColor(...C.muted);
  doc.text(reportText(label, '').toUpperCase(), x + 5, y + height * 0.82, { maxWidth: width - 10 });
}

/**
 * Draw one label/value pair and return the exact height it consumed.
 *
 * The value used to be a single `doc.text(..., { maxWidth })` call: jsPDF wraps
 * that internally, so a long value ran a second line straight into the next
 * row's label. Measuring the wrap here means the caller advances by the real
 * height instead of a fixed 11 mm that was too generous for short values and
 * too tight for long ones.
 */
export function drawMetaCell(doc, x, y, width, label, value, accent) {
  const labelBlock = measureParagraph(doc, reportText(label, '').toUpperCase(), {
    maxWidth: width, fontSize: 7.2, fontStyle: 'bold',
  });
  const valueBlock = measureParagraph(doc, reportText(value, '-'), { maxWidth: width, fontSize: 8.5 });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.2);
  doc.setTextColor(...accent);
  labelBlock.lines.forEach((line, index) => {
    doc.text(line, x, y + labelBlock.em * 0.82 + index * labelBlock.lineHeight);
  });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...C.ink);
  const valueTop = y + labelBlock.height + 0.6;
  valueBlock.lines.forEach((line, index) => {
    doc.text(line, x, valueTop + valueBlock.em * 0.82 + index * valueBlock.lineHeight);
  });
  return labelBlock.height + 0.6 + valueBlock.height;
}

export function drawFindingCard(doc, item, y, accent, ensureSpace) {
  const title = reportText(item?.title || item?.name, 'Security finding');
  const detail = reportText(item?.detail || item?.note || item?.description, 'No additional detail supplied.');
  const textX = L.margin + 8;
  const innerWidth = L.contentWidth - 13;   // 8 mm of rail + inset, 5 mm of right padding
  const titleBlock = measureParagraph(doc, title, { maxWidth: innerWidth, fontSize: 8.5, fontStyle: 'bold' });
  const detailBlock = measureParagraph(doc, detail, { maxWidth: innerWidth, fontSize: 7.8 });
  const boxPadding = 3;
  const labelGap = 1.2;
  // Nothing else lives in this box, so its height is the text plus the padding —
  // the old 22 mm minimum was pure blank card under every short finding.
  const height = boxPadding * 2 + titleBlock.height + labelGap + detailBlock.height;
  y = ensureSpace(height + 3);
  doc.setFillColor(...C.slateLight);
  doc.setDrawColor(...C.line);
  doc.setLineWidth(0.3);
  doc.roundedRect(L.margin, y, L.contentWidth, height, 2.5, 2.5, 'FD');
  doc.setFillColor(...accent);
  doc.roundedRect(L.margin, y, 3.5, height, 1.5, 1.5, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(...C.ink);
  const detailTop = y + boxPadding + titleBlock.height + labelGap;
  drawParagraph(doc, titleBlock, textX, y + boxPadding);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.8);
  doc.setTextColor(...C.muted);
  drawParagraph(doc, detailBlock, textX, detailTop);
  return y + height + 3;
}

export function drawRecommendationCard(doc, recommendation, index, y, ensureSpace) {
  const priority = reportText(recommendation?.priority, 'Medium');
  const accent = /critical|high/i.test(priority) ? C.rose : /low/i.test(priority) ? C.indigo : C.amber;
  const description = reportText(recommendation?.description || recommendation?.fix, 'Review this item in the security monitor.');
  const titleX = L.margin + 36;
  const titleBlock = measureParagraph(doc, reportText(recommendation?.title, `Action ${index + 1}`), {
    maxWidth: L.contentWidth - 41, fontSize: 8.8, fontStyle: 'bold',
  });
  const detailBlock = measureParagraph(doc, description, { maxWidth: L.contentWidth - 13, fontSize: 7.8 });
  const boxPadding = 3;
  const pillHeight = 7;
  // The pill sits in the header row beside the title, so the row has to be as
  // tall as whichever of the two needs more room. Sizing it from the title alone
  // let a one-line title pull the body copy up underneath the pill.
  const headerHeight = Math.max(titleBlock.height, pillHeight + 1.5);
  const height = boxPadding * 2 + headerHeight + 1.2 + detailBlock.height;
  const fill = accent === C.rose ? C.roseLight : accent === C.indigo ? C.indigoLight : C.amberLight;
  y = ensureSpace(height + 3);

  doc.setFillColor(...fill);
  doc.setDrawColor(...C.line);
  doc.setLineWidth(0.3);
  doc.roundedRect(L.margin, y, L.contentWidth, height, 2.5, 2.5, 'FD');
  doc.setFillColor(...accent);
  doc.roundedRect(L.margin, y, 4, height, 1.5, 1.5, 'F');
  drawPill(doc, priority, L.margin + 8, y + boxPadding, 24, accent, { height: pillHeight, fontSize: 6.5 });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.8);
  doc.setTextColor(...C.ink);
  drawParagraph(doc, titleBlock, titleX, y + boxPadding);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.8);
  doc.setTextColor(...C.muted);
  drawParagraph(doc, detailBlock, L.margin + 8, y + boxPadding + headerHeight + 1.2);
  return y + height + 3;
}

/**
 * Create the administrator security report.  This is intentionally separate
 * from the React page so the same report can be generated from a future API
 * action without coupling the UI to jsPDF internals.
 */
export async function downloadSecurityReport({ security = {}, overview = {}, request, save = true } = {}) {
  let JsPDF;
  let renderAutoTable;
  try {
    ({ JsPDF, renderAutoTable } = await loadPdfLib());
  } catch (loadError) {
    // A stale Vite dep hash is repaired by a reload, not by an error message.
    if (isStaleChunkError(loadError) && reloadOnceForStaleChunk(loadError)) {
      return null;
    }
    throw loadError;
  }
  const doc = new JsPDF({ unit: 'mm', format: 'a4', compress: true });
  const now = new Date();
  const generatedAt = formatReportDate(now, true);
  const generatedLabel = `Generated: ${generatedAt}`;

  let monitorPayload = null;
  if (typeof request === 'function') {
    try {
      monitorPayload = await request('/security/monitor');
    } catch (error) {
      monitorPayload = null;
      console.warn('Security report monitor refresh failed:', error?.message || error);
    }
  }

  const checks = asArray(security?.checks);
  const recommendations = asArray(security?.recommendations);
  const metrics = overview?.metrics || {};
  const monitors = asArray(monitorPayload?.monitors);
  const audit = monitorPayload?.audit || security?.audit || null;
  const syncedAt = monitorPayload?.syncedAt || null;

  const secureCount = checks.filter((check) => statusKey(check?.status) === 'secure').length;
  const vulnerableCount = checks.filter((check) => ['vulnerable', 'warning'].includes(statusKey(check?.status))).length;
  const criticalCount = checks.filter((check) => ['critical', 'error'].includes(statusKey(check?.status))).length;
  const healthyMonitors = monitors.filter((monitor) => statusKey(monitor?.status) === 'healthy').length;
  const warningMonitors = monitors.filter((monitor) => statusKey(monitor?.status) === 'warning').length;
  const criticalMonitors = monitors.filter((monitor) => ['critical', 'error'].includes(statusKey(monitor?.status))).length;

  const liveStatus = statusKey(monitorPayload?.overallMonitorStatus);
  const staticStatus = statusKey(security?.overallStatus);
  const overallStatus = criticalMonitors > 0 || liveStatus === 'critical' || liveStatus === 'error'
    ? 'Critical'
    : warningMonitors > 0 || liveStatus === 'warning' || staticStatus === 'vulnerable'
      ? 'Vulnerable'
      : staticStatus === 'secure' && liveStatus !== 'warning' && liveStatus !== 'critical' && liveStatus !== 'error'
        ? 'Secure'
        : titleCase(security?.overallStatus);
  const overallColor = statusColor(overallStatus);

  drawReportHeader(doc, {
    title: 'SuppliWise',
    subtitle: 'Security report  |  STRIDE + OWASP framework',
    preparedFor: 'Authorized administrators',
    dateLabel: generatedLabel.replace(/^Generated:\s*/i, ''),
    dateValue: formatReportDate(now),
    badge: 'Confidential',
    status: overallStatus,
    statusColor: overallColor,
  });

  const headerPages = new Set([1]);
  const drawContinuationHeader = (pageNumber) => {
    if (headerPages.has(pageNumber)) return;
    doc.setPage(pageNumber);
    drawReportHeader(doc, {
      title: 'SuppliWise',
      subtitle: 'Security report  |  STRIDE + OWASP framework',
      badge: 'Confidential',
      pageNumber,
      compact: true,
    });
    headerPages.add(pageNumber);
  };

  let y = L.firstContentTop;
  const addPage = () => {
    doc.addPage();
    const pageNumber = doc.internal.getNumberOfPages();
    drawContinuationHeader(pageNumber);
    return L.continuationContentTop;
  };
  const ensureSpace = (needed) => {
    const amount = Number.isFinite(Number(needed)) ? Number(needed) : 18;
    if (!Number.isFinite(y) || y < 0) y = addPage();
    if (y + amount > L.pageHeight - L.footerHeight - 4) return addPage();
    return y;
  };
  const tableMargin = { top: L.continuationContentTop, bottom: L.footerHeight + 2, left: L.margin, right: L.margin };
  const runTable = (options) => {
    // Same guard as the wellness report: autotable's built-in grid default is
    // rgb(200,200,200), which is outside the green/black/white palette.
    renderAutoTable(doc, {
      margin: tableMargin,
      tableLineColor: C.line,
      ...options,
      headStyles: { lineColor: C.line, ...(options.headStyles || {}) },
      bodyStyles: { lineColor: C.line, ...(options.bodyStyles || {}) },
      didDrawPage: () => {
        // autoTable numbers pages of THIS table (1, 2, 3 ...), not document
        // pages. setPage() with that index moved the cursor back to a page the
        // table had already left, so the next section was drawn on top of the
        // rows. The document's current page is the page actually being drawn.
        const pageNumber = doc.getCurrentPageInfo().pageNumber;
        if (pageNumber > 1) drawContinuationHeader(pageNumber);
      },
    });
    const rawFinalY = doc.lastAutoTable?.finalY;
    const finalY = rawFinalY === null || rawFinalY === undefined ? NaN : Number(rawFinalY);
    return Number.isFinite(finalY) ? finalY : y;
  };

  // Executive summary ------------------------------------------------------
  y = ensureSpace(20);
  y = drawSectionHeading(doc, 'Executive summary', y, C.emerald);

  const statusText = overallStatus === 'Secure'
    ? 'Controls and live probes are reporting a healthy posture.'
    : 'Review the highlighted controls and live monitor findings before release.';
  // The posture band is a fixed card, so reserve exactly its height plus the gap
  // that follows it. The old number asked for 25 mm and then advanced 27, which
  // left a band of empty page under every copy of this card.
  const postureHeight = 18;
  y = ensureSpace(postureHeight + 3);
  doc.setFillColor(...(overallStatus === 'Secure' ? C.emeraldLight : overallStatus === 'Vulnerable' ? C.amberLight : C.roseLight));
  doc.setDrawColor(...overallColor);
  doc.setLineWidth(0.4);
  doc.roundedRect(L.margin, y, L.contentWidth, postureHeight, 2.5, 2.5, 'FD');
  doc.setFillColor(...overallColor);
  doc.roundedRect(L.margin, y, 4, postureHeight, 1.5, 1.5, 'F');
  drawPill(doc, overallStatus, L.margin + 9, y + 5, 29, overallColor, { height: 8, fontSize: 7.5 });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.2);
  doc.setTextColor(...C.ink);
  doc.text('Current security posture', L.margin + 44, y + 8);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.1);
  doc.setTextColor(...C.muted);
  doc.text(statusText, L.margin + 44, y + 13.5, { maxWidth: L.contentWidth - 55 });
  y += postureHeight + 3;

  const kpiGap = 4;
  const kpiWidth = (L.contentWidth - kpiGap * 3) / 4;
  const kpiHeight = 21;
  y = ensureSpace(kpiHeight + 3);
  drawKpi(doc, L.margin, y, kpiWidth, kpiHeight, `${checks.length}`, 'Controls checked', C.indigo, C.indigoLight);
  drawKpi(doc, L.margin + kpiWidth + kpiGap, y, kpiWidth, kpiHeight, `${healthyMonitors}`, 'Healthy monitors', C.emerald, C.emeraldLight);
  drawKpi(doc, L.margin + (kpiWidth + kpiGap) * 2, y, kpiWidth, kpiHeight, `${criticalCount + criticalMonitors}`, 'Critical findings', C.rose, C.roseLight);
  drawKpi(doc, L.margin + (kpiWidth + kpiGap) * 3, y, kpiWidth, kpiHeight, `${audit?.counts?.openOrAccepted ?? '—'}`, 'Open / accepted', C.amber, C.amberLight);
  y += kpiHeight + 3;

  const metaRows = [
    ['Report generated', generatedAt, 'Framework', 'STRIDE + OWASP Top 10'],
    ['Controls', `${checks.length} (${secureCount} secure, ${vulnerableCount} vulnerable, ${criticalCount} critical)`, 'Live monitors', `${monitors.length} (${healthyMonitors} healthy, ${warningMonitors} warning, ${criticalMonitors} critical)`],
    ['Users', String(metrics.users ?? '—'), 'Active subscriptions', String(metrics.activeSubscriptions ?? '—')],
    ['Last scan', security?.lastScanned ? formatReportDate(security.lastScanned, true) : 'Not recorded', 'Last monitor sync', syncedAt ? formatReportDate(syncedAt, true) : 'Not recorded'],
  ];
  metaRows.forEach((row) => {
    // Each row reserves only its own measured height, so a long value wraps
    // inside the row instead of colliding with the next one — and a short value
    // no longer costs a fixed 11 mm of blank page.
    y = ensureSpace(11);
    const leftHeight = drawMetaCell(doc, L.margin, y, 82, row[0], row[1], C.teal);
    const rightHeight = drawMetaCell(doc, L.margin + 94, y, 86, row[2], row[3], C.indigo);
    y += Math.max(leftHeight, rightHeight) + 2.5;
  });

  // Security controls ------------------------------------------------------
  y = ensureSpace(20);
  y = drawSectionHeading(doc, 'STRIDE + OWASP security checks', y, C.indigo);
  const controlBody = checks.length > 0
    ? checks.map((check) => [
      statusLabel(check?.status),
      cleanReportText(check?.framework || '—'),
      cleanReportText(check?.label || check?.control || '—'),
      statusKey(check?.status) === 'secure' ? 'No action required' : cleanReportText(check?.fix || 'Review this control'),
    ])
    : [['—', '—', 'No controls returned', 'Run a security scan to populate this section']];
  y = runTable({
    startY: y,
    head: [['Status', 'Framework', 'Control', 'Recommended action']],
    body: controlBody,
    theme: 'grid',
    headStyles: { fillColor: C.emerald, textColor: C.white, fontSize: 7.5, fontStyle: 'bold', cellPadding: 2.8 },
    bodyStyles: { fontSize: 7.5, textColor: C.ink, cellPadding: 2.6, valign: 'top', lineColor: C.line, lineWidth: 0.2 },
    alternateRowStyles: { fillColor: C.slateLight },
    columnStyles: {
      0: { cellWidth: 22, fontStyle: 'bold' },
      1: { cellWidth: 23 },
      2: { cellWidth: 65 },
      3: { cellWidth: 'auto' },
    },
    didParseCell: (data) => {
      if (data.section === 'body' && data.column.index === 0) {
        const color = statusColor(data.cell.raw);
        data.cell.styles.textColor = color;
        data.cell.styles.fillColor = color === C.rose ? C.roseLight : color === C.amber ? C.amberLight : C.emeraldLight;
      }
    },
  }) + 4;

  // Live monitor -----------------------------------------------------------
  y = ensureSpace(20);
  y = drawSectionHeading(doc, 'Real-time security monitor', y, C.teal);
  const monitorBody = monitors.length > 0
    ? monitors.map((monitor) => [
      reportText(monitor?.status, 'unknown').toUpperCase(),
      cleanReportText(monitor?.label || monitor?.key || 'Unnamed monitor'),
      monitorFramework(monitor?.key),
      cleanReportText(monitor?.detail || 'No detail supplied.'),
      monitor?.latencyMs != null ? `${monitor.latencyMs} ms` : '—',
    ])
    : [[ 'UNKNOWN', 'Monitor data unavailable', 'Security', 'The live monitor could not be reached when this report was generated.', '—']];
  y = runTable({
    startY: y,
    head: [['Status', 'Monitor', 'Framework', 'Detail', 'Latency']],
    body: monitorBody,
    theme: 'grid',
    headStyles: { fillColor: C.emerald, textColor: C.white, fontSize: 7, fontStyle: 'bold', cellPadding: 2.6 },
    bodyStyles: { fontSize: 6.7, textColor: C.ink, cellPadding: 2.4, valign: 'top', lineColor: C.line, lineWidth: 0.2 },
    alternateRowStyles: { fillColor: C.tealLight },
    columnStyles: {
      0: { cellWidth: 20, fontStyle: 'bold' },
      1: { cellWidth: 34 },
      2: { cellWidth: 25 },
      3: { cellWidth: 'auto' },
      4: { cellWidth: 23, halign: 'right' },
    },
    didParseCell: (data) => {
      if (data.section === 'body' && data.column.index === 0) {
        const color = statusColor(data.cell.raw);
        data.cell.styles.textColor = color;
        data.cell.styles.fillColor = color === C.rose ? C.roseLight : color === C.amber ? C.amberLight : color === C.indigo ? C.indigoLight : C.emeraldLight;
      }
    },
  }) + 4;

  // Audit record -----------------------------------------------------------
  if (audit) {
    const scope = reportText(audit.scope, 'Scope details were not supplied.');
    const scopeInner = L.contentWidth - 13;
    const scopeTitleBlock = measureParagraph(doc, 'AUDIT SCOPE', {
      maxWidth: scopeInner, fontSize: 7.5, fontStyle: 'bold',
    });
    const scopeBlock = measureParagraph(doc, scope, { maxWidth: scopeInner, fontSize: 8 });
    const boxPadding = 3;
    // Measured, like every other box in the report: the old `12 + lines * 4.5`
    // guess was too tall for a one-line scope and too short for a long one, so
    // the copy either floated in blank card or ran past the border.
    const scopeHeight = boxPadding * 2 + scopeTitleBlock.height + 1.2 + scopeBlock.height;
    y = ensureSpace(20);
    y = drawSectionHeading(doc, 'Security audit record', y, C.violet);
    y = ensureSpace(scopeHeight + 3);
    doc.setFillColor(...C.violetLight);
    // C.line, not a hard-coded pastel: the palette is green, black and white,
    // and this border was the one place a fourth ink could still leak in.
    doc.setDrawColor(...C.line);
    doc.setLineWidth(0.3);
    doc.roundedRect(L.margin, y, L.contentWidth, scopeHeight, 2.5, 2.5, 'FD');
    doc.setFillColor(...C.violet);
    doc.roundedRect(L.margin, y, 3.5, scopeHeight, 1.5, 1.5, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(...C.violet);
    const scopeBodyTop = y + boxPadding + scopeTitleBlock.height + 1.2;
    // The label keeps the accent colour, so it is placed line by line here:
    // drawParagraph pins body copy to black, which is right for the text under
    // it and wrong for a heading.
    scopeTitleBlock.lines.forEach((line, lineIndex) => {
      doc.text(line, L.margin + 8, y + boxPadding + scopeTitleBlock.em * 0.82 + lineIndex * scopeTitleBlock.lineHeight);
    });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...C.muted);
    drawParagraph(doc, scopeBlock, L.margin + 8, scopeBodyTop);
    y += scopeHeight + 3;

    const counts = audit.counts || {};
    const statItems = [
      ['Critical', counts.critical, C.rose, C.roseLight],
      ['High', counts.high, C.orange, C.amberLight],
      ['Remediated', counts.remediatedInCode, C.emerald, C.emeraldLight],
      ['Open / accepted', counts.openOrAccepted, C.amber, C.amberLight],
    ];
    const statGap = 4;
    const statWidth = (L.contentWidth - statGap * 3) / 4;
    const statHeight = 21;
    y = ensureSpace(statHeight + 3);
    statItems.forEach(([label, value, color, fill], index) => drawKpi(doc, L.margin + index * (statWidth + statGap), y, statWidth, statHeight, value ?? '—', label, color, fill));
    y += statHeight + 3;

    const findings = asArray(audit.headlineFindings);
    if (findings.length > 0) {
      // Reserve the heading plus one card, not a whole section: a fixed 45 mm
      // ask moved the heading to a fresh page while 40 mm of the current one
      // was still empty, and the card itself already knows how to break.
      y = ensureSpace(24);
      y = drawSectionHeading(doc, 'Headline findings', y, C.rose);
      findings.forEach((finding) => {
        y = drawFindingCard(doc, finding, y, severityColor(finding?.severity), ensureSpace);
      });
    }

    const openItems = asArray(audit.openItems);
    if (openItems.length > 0) {
      y = ensureSpace(24);
      y = drawSectionHeading(doc, 'Open and accepted items', y, C.amber);
      openItems.forEach((finding) => {
        y = drawFindingCard(doc, finding, y, severityColor(finding?.severity), ensureSpace);
      });
    }
  }

  // Recommendations -------------------------------------------------------
  if (recommendations.length > 0) {
    y = ensureSpace(24);
    y = drawSectionHeading(doc, 'Recommended actions', y, C.orange);
    recommendations.forEach((recommendation, index) => {
      y = drawRecommendationCard(doc, recommendation, index, y, ensureSpace);
    });
  }

  drawReportFooter(doc, {
    leftText: 'SuppliWise | Confidential security report | For authorized personnel only',
  });

  const datePart = now.toISOString().slice(0, 10);
  const filename = `suppliwise-security-report-${datePart}.pdf`;
  if (save) downloadPdf(doc, filename);
  return { filename, pageCount: doc.internal.getNumberOfPages() };
}
