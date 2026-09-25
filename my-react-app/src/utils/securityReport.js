import jsPDFModule from 'jspdf';
import autoTableModule from 'jspdf-autotable';

const JsPDF = jsPDFModule?.jsPDF || jsPDFModule?.default || jsPDFModule;
const renderAutoTable = typeof autoTableModule === 'function'
  ? autoTableModule
  : autoTableModule?.default || autoTableModule?.autoTable;
import {
  REPORT_COLORS as C,
  REPORT_LAYOUT as L,
  cleanReportText,
  downloadPdf,
  drawPill,
  drawReportFooter,
  drawReportHeader,
  drawSectionHeading,
  formatReportDate,
  reportText,
} from './reportTheme.js';

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

function drawKpi(doc, x, y, width, height, value, label, color, fill) {
  doc.setFillColor(...fill);
  doc.setDrawColor(...C.line);
  doc.setLineWidth(0.3);
  doc.roundedRect(x, y, width, height, 2.5, 2.5, 'FD');
  doc.setFillColor(...color);
  doc.rect(x, y, width, 2.5, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(...C.ink);
  doc.text(reportText(value, '0'), x + 5, y + 12, { maxWidth: width - 10 });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.2);
  doc.setTextColor(...C.muted);
  doc.text(reportText(label, '').toUpperCase(), x + 5, y + 19, { maxWidth: width - 10 });
}

function drawMetaCell(doc, x, y, width, label, value, accent) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.2);
  doc.setTextColor(...accent);
  doc.text(reportText(label, '').toUpperCase(), x, y, { maxWidth: width });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...C.ink);
  doc.text(reportText(value, '-'), x, y + 5.2, { maxWidth: width });
}

function drawFindingCard(doc, item, y, accent, ensureSpace) {
  const title = reportText(item?.title || item?.name, 'Security finding');
  const detail = reportText(item?.detail || item?.note || item?.description, 'No additional detail supplied.');
  const titleLines = doc.splitTextToSize(title, L.contentWidth - 20);
  const detailLines = doc.splitTextToSize(detail, L.contentWidth - 18);
  const height = Math.max(22, 8 + titleLines.length * 4.5 + detailLines.length * 4.4 + 4);
  y = ensureSpace(height + 4);
  doc.setFillColor(...C.slateLight);
  doc.setDrawColor(...C.line);
  doc.setLineWidth(0.3);
  doc.roundedRect(L.margin, y, L.contentWidth, height, 2.5, 2.5, 'FD');
  doc.setFillColor(...accent);
  doc.roundedRect(L.margin, y, 3.5, height, 1.5, 1.5, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(...C.ink);
  doc.text(titleLines, L.margin + 8, y + 7);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.8);
  doc.setTextColor(...C.muted);
  doc.text(detailLines, L.margin + 8, y + 8 + titleLines.length * 4.5);
  return y + height + 4;
}

function drawRecommendationCard(doc, recommendation, index, y, ensureSpace) {
  const priority = reportText(recommendation?.priority, 'Medium');
  const accent = /critical|high/i.test(priority) ? C.rose : /low/i.test(priority) ? C.indigo : C.amber;
  const description = reportText(recommendation?.description || recommendation?.fix, 'Review this item in the security monitor.');
  const titleLines = doc.splitTextToSize(reportText(recommendation?.title, `Action ${index + 1}`), L.contentWidth - 48);
  const lines = doc.splitTextToSize(description, L.contentWidth - 19);
  const height = Math.max(22, 12 + titleLines.length * 4.5 + lines.length * 4.5);
  const fill = accent === C.rose ? C.roseLight : accent === C.indigo ? C.indigoLight : C.amberLight;
  y = ensureSpace(height + 4);

  doc.setFillColor(...fill);
  doc.setDrawColor(...C.line);
  doc.setLineWidth(0.3);
  doc.roundedRect(L.margin, y, L.contentWidth, height, 2.5, 2.5, 'FD');
  doc.setFillColor(...accent);
  doc.roundedRect(L.margin, y, 4, height, 1.5, 1.5, 'F');
  drawPill(doc, priority, L.margin + 8, y + 4, 24, accent, { height: 7, fontSize: 6.5 });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.8);
  doc.setTextColor(...C.ink);
  doc.text(titleLines, L.margin + 36, y + 8);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.8);
  doc.setTextColor(...C.muted);
  doc.text(lines, L.margin + 8, y + 13 + titleLines.length * 4.5);
  return y + height + 4;
}

/**
 * Create the administrator security report.  This is intentionally separate
 * from the React page so the same report can be generated from a future API
 * action without coupling the UI to jsPDF internals.
 */
export async function downloadSecurityReport({ security = {}, overview = {}, request, save = true } = {}) {
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
  const tableMargin = { top: L.continuationContentTop, bottom: L.footerHeight + 5, left: L.margin, right: L.margin };
  const runTable = (options) => {
    renderAutoTable(doc, {
      margin: tableMargin,
      ...options,
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
  y = ensureSpace(25);
  doc.setFillColor(...(overallStatus === 'Secure' ? C.emeraldLight : overallStatus === 'Vulnerable' ? C.amberLight : C.roseLight));
  doc.setDrawColor(...overallColor);
  doc.setLineWidth(0.4);
  doc.roundedRect(L.margin, y, L.contentWidth, 20, 2.5, 2.5, 'FD');
  doc.setFillColor(...overallColor);
  doc.roundedRect(L.margin, y, 4, 20, 1.5, 1.5, 'F');
  drawPill(doc, overallStatus, L.margin + 9, y + 5, 29, overallColor, { height: 8, fontSize: 7.5 });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.2);
  doc.setTextColor(...C.ink);
  doc.text('Current security posture', L.margin + 44, y + 8.5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.1);
  doc.setTextColor(...C.muted);
  doc.text(statusText, L.margin + 44, y + 14, { maxWidth: L.contentWidth - 55 });
  y += 27;

  const kpiGap = 4;
  const kpiWidth = (L.contentWidth - kpiGap * 3) / 4;
  y = ensureSpace(27);
  drawKpi(doc, L.margin, y, kpiWidth, 25, `${checks.length}`, 'Controls checked', C.indigo, C.indigoLight);
  drawKpi(doc, L.margin + kpiWidth + kpiGap, y, kpiWidth, 25, `${healthyMonitors}`, 'Healthy monitors', C.emerald, C.emeraldLight);
  drawKpi(doc, L.margin + (kpiWidth + kpiGap) * 2, y, kpiWidth, 25, `${criticalCount + criticalMonitors}`, 'Critical findings', C.rose, C.roseLight);
  drawKpi(doc, L.margin + (kpiWidth + kpiGap) * 3, y, kpiWidth, 25, `${audit?.counts?.openOrAccepted ?? '—'}`, 'Open / accepted', C.amber, C.amberLight);
  y += 33;

  y = ensureSpace(35);
  const metaRows = [
    ['Report generated', generatedAt, 'Framework', 'STRIDE + OWASP Top 10'],
    ['Controls', `${checks.length} (${secureCount} secure, ${vulnerableCount} vulnerable, ${criticalCount} critical)`, 'Live monitors', `${monitors.length} (${healthyMonitors} healthy, ${warningMonitors} warning, ${criticalMonitors} critical)`],
    ['Users', String(metrics.users ?? '—'), 'Active subscriptions', String(metrics.activeSubscriptions ?? '—')],
    ['Last scan', security?.lastScanned ? formatReportDate(security.lastScanned, true) : 'Not recorded', 'Last monitor sync', syncedAt ? formatReportDate(syncedAt, true) : 'Not recorded'],
  ];
  metaRows.forEach((row) => {
    drawMetaCell(doc, L.margin, y, 82, row[0], row[1], C.teal);
    drawMetaCell(doc, L.margin + 94, y, 86, row[2], row[3], C.indigo);
    y += 11;
  });
  y += 3;

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
    headStyles: { fillColor: C.navy, textColor: C.white, fontSize: 7.5, fontStyle: 'bold', cellPadding: 4 },
    bodyStyles: { fontSize: 7.5, textColor: C.ink, cellPadding: 3.5, valign: 'top', lineColor: C.line, lineWidth: 0.2 },
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
  }) + 8;

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
    headStyles: { fillColor: C.deep, textColor: C.white, fontSize: 7, fontStyle: 'bold', cellPadding: 3.5 },
    bodyStyles: { fontSize: 6.7, textColor: C.ink, cellPadding: 3, valign: 'top', lineColor: C.line, lineWidth: 0.2 },
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
  }) + 8;

  // Audit record -----------------------------------------------------------
  if (audit) {
    const scope = reportText(audit.scope, 'Scope details were not supplied.');
    const scopeLines = doc.splitTextToSize(scope, L.contentWidth - 18);
    const scopeHeight = Math.max(19, 12 + scopeLines.length * 4.5);
    // Reserve the heading and the scope card together, otherwise a table that
    // ends near the bottom leaves the heading alone at the foot of a page.
    y = ensureSpace(20 + scopeHeight);
    y = drawSectionHeading(doc, 'Security audit record', y, C.violet);
    y = ensureSpace(scopeHeight);
    doc.setFillColor(...C.violetLight);
    // Must be spread: passing the array itself makes jsPDF compute
    // `array / 255` -> NaN and throw "Invalid argument passed to jsPDF.f2".
    doc.setDrawColor(...[221, 214, 254]);
    doc.setLineWidth(0.3);
    doc.roundedRect(L.margin, y, L.contentWidth, scopeHeight, 2.5, 2.5, 'FD');
    doc.setFillColor(...C.violet);
    doc.roundedRect(L.margin, y, 3.5, scopeHeight, 1.5, 1.5, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(...C.violet);
    doc.text('AUDIT SCOPE', L.margin + 8, y + 7);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...C.muted);
    doc.text(scopeLines, L.margin + 8, y + 13);
    y += scopeHeight + 7;

    const counts = audit.counts || {};
    const statItems = [
      ['Critical', counts.critical, C.rose, C.roseLight],
      ['High', counts.high, C.orange, C.amberLight],
      ['Remediated', counts.remediatedInCode, C.emerald, C.emeraldLight],
      ['Open / accepted', counts.openOrAccepted, C.amber, C.amberLight],
    ];
    const statGap = 4;
    const statWidth = (L.contentWidth - statGap * 3) / 4;
    y = ensureSpace(24);
    statItems.forEach(([label, value, color, fill], index) => drawKpi(doc, L.margin + index * (statWidth + statGap), y, statWidth, 23, value ?? '—', label, color, fill));
    y += 31;

    const findings = asArray(audit.headlineFindings);
    if (findings.length > 0) {
      y = ensureSpace(45);
      y = drawSectionHeading(doc, 'Headline findings', y, C.rose);
      findings.forEach((finding) => {
        const estimated = 25;
        y = ensureSpace(estimated);
        y = drawFindingCard(doc, finding, y, severityColor(finding?.severity), ensureSpace);
      });
    }

    const openItems = asArray(audit.openItems);
    if (openItems.length > 0) {
      y = ensureSpace(50);
      y = drawSectionHeading(doc, 'Open and accepted items', y, C.amber);
      openItems.forEach((finding) => {
        y = ensureSpace(25);
        y = drawFindingCard(doc, finding, y, severityColor(finding?.severity), ensureSpace);
      });
    }
  }

  // Recommendations -------------------------------------------------------
  if (recommendations.length > 0) {
    y = ensureSpace(48);
    y = drawSectionHeading(doc, 'Recommended actions', y, C.orange);
    recommendations.forEach((recommendation, index) => {
      y = ensureSpace(28);
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
