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
  drawReportFooter,
  drawReportHeader,
  drawSectionHeading,
  formatReportDate,
  reportText,
  safeFilenamePart,
} from './reportTheme.js';

const asArray = (value) => (Array.isArray(value) ? value : []);
const nonEmpty = (value) => value !== null && value !== undefined && String(value).trim() !== '';
const asNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const listValue = (value) => {
  if (Array.isArray(value)) return value.filter(nonEmpty).map(String).join(', ');
  return nonEmpty(value) ? String(value) : '';
};

const priorityMeta = (value) => {
  const key = reportText(value, 'medium').trim().toLowerCase();
  if (key === 'high' || key === 'critical') return { label: 'High', color: C.rose, fill: C.roseLight };
  if (key === 'low') return { label: 'Low', color: C.indigo, fill: C.indigoLight };
  if (key === 'medium' || key === 'moderate') return { label: 'Medium', color: C.amber, fill: C.amberLight };
  return { label: reportText(value, 'Medium'), color: C.teal, fill: C.tealLight };
};

const scoreValue = (value) => {
  const score = asNumber(value);
  if (score === null) return '—';
  return `${Math.max(0, Math.min(100, Math.round(score)))}%`;
};

const expandFoodItem = (item) => {
  const text = reportText(item, '').trim();
  if (!text) return '';
  const lower = text.toLowerCase();
  const examples = {
    'fatty fish': 'fatty fish (salmon, tuna, sardines, mackerel)',
    'leafy greens': 'leafy greens (spinach, kale, Swiss chard)',
    'leafy green': 'leafy greens (spinach, kale, Swiss chard)',
    nuts: 'nuts (almonds, cashews, walnuts, pumpkin seeds)',
    dairy: 'dairy (Greek yogurt, cheddar cheese, whole milk)',
    'dairy products': 'dairy (Greek yogurt, cheddar cheese, whole milk)',
    citrus: 'citrus (oranges, grapefruit, kiwi)',
    'citrus fruits': 'citrus (oranges, grapefruit, kiwi)',
    legumes: 'legumes (lentils, chickpeas, black beans)',
    'whole grains': 'whole grains (oats, brown rice, quinoa)',
    'shellfish': 'shellfish (oysters, clams, shrimp)',
    berries: 'berries (blueberries, strawberries, raspberries)',
  };
  if (examples[lower]) return examples[lower];
  return text;
};

const expandFoods = (value) => {
  if (!nonEmpty(value)) return '';
  const parts = String(value).split(/[;,]/).map((part) => expandFoodItem(part)).filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : expandFoodItem(value);
};

const getUserName = (assessment, fallback = '') => {
  const explicit = reportText(assessment?.userName || assessment?.name, '').trim();
  if (explicit) return explicit;
  const composed = [assessment?.firstName, assessment?.lastName].filter(Boolean).join(' ').trim();
  return composed || fallback || 'Wellness member';
};

const getDosage = (recommendations, pillName) => {
  const needle = reportText(pillName, '').toLowerCase().replace(/\s+-\s+.*$/, '').trim();
  if (!needle) return null;
  const exact = recommendations.find((rec) => reportText(rec?.name, '').toLowerCase() === needle);
  if (exact?.dosage) return exact.dosage;
  const partial = recommendations.find((rec) => {
    const name = reportText(rec?.name, '').toLowerCase();
    return name.length > 3 && (needle.includes(name) || name.includes(needle));
  });
  return partial?.dosage || null;
};

function drawKpi(doc, x, y, width, height, value, label, color, fill) {
  doc.setFillColor(...fill);
  doc.setDrawColor(...C.line);
  doc.setLineWidth(0.3);
  doc.roundedRect(x, y, width, height, 2.5, 2.5, 'FD');
  doc.setFillColor(...color);
  doc.rect(x, y, width, 2.5, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13.5);
  doc.setTextColor(...C.ink);
  doc.text(reportText(value, '0'), x + 5, y + 12, { maxWidth: width - 10 });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...C.muted);
  doc.text(reportText(label, '').toUpperCase(), x + 5, y + 19, { maxWidth: width - 10 });
}

function drawTableHeader(drawContinuationHeader) {
  return (data) => {
    if (data.pageNumber > 1) drawContinuationHeader(data.pageNumber);
  };
}

export async function downloadWellnessReport({ results = {}, assessment = {}, userName = '', save = true } = {}) {
  const doc = new JsPDF({ unit: 'mm', format: 'a4', compress: true });
  const now = new Date();
  const assessmentDate = new Date(assessment?.createdAt || now);
  const safeAssessmentDate = Number.isFinite(assessmentDate.getTime()) ? assessmentDate : now;
  const resolvedName = getUserName(assessment, userName);
  const recommendations = asArray(results?.recommendations);
  const shouldConsult = results?.consultDoctor === true
    || /^(true|yes|recommended)$/i.test(String(results?.consultDoctor || '').trim());

  drawReportHeader(doc, {
    title: 'SuppliWise',
    subtitle: 'Personalized supplement & wellness report',
    preparedFor: resolvedName,
    dateLabel: `Assessment: ${formatReportDate(safeAssessmentDate)}`,
    dateValue: formatReportDate(safeAssessmentDate),
    badge: 'Wellness report',
    status: shouldConsult ? 'Clinician review' : 'Personalized plan',
    statusColor: shouldConsult ? C.rose : C.emerald,
  });

  const headerPages = new Set([1]);
  const drawContinuationHeader = (pageNumber) => {
    if (headerPages.has(pageNumber)) return;
    doc.setPage(pageNumber);
    drawReportHeader(doc, {
      title: 'SuppliWise',
      subtitle: 'Personalized supplement & wellness report',
      badge: 'Wellness report',
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
      didDrawPage: drawTableHeader(drawContinuationHeader),
    });
    const rawFinalY = doc.lastAutoTable?.finalY;
    const finalY = rawFinalY === null || rawFinalY === undefined ? NaN : Number(rawFinalY);
    return Number.isFinite(finalY) ? finalY : y;
  };

  const beginSection = (label, accent) => {
    const currentPage = doc.getCurrentPageInfo().pageNumber;
    const freshContinuationPage = currentPage > 1 && y <= L.continuationContentTop + 0.5;
    // AutoTable can finish a split table close to the top of a continuation
    // page. Starting the next heading on a fresh page in that narrow band keeps
    // the heading clear of the last row instead of letting text overlap.
    if (currentPage > 1 && !freshContinuationPage && y < 88) y = addPage();
    else y = ensureSpace(18);
    return drawSectionHeading(doc, label, y, accent);
  };

  const drawTextCard = ({ label, text, accent = C.emerald, fill = C.emeraldLight, fontSize = 8.5 }) => {
    const lines = doc.splitTextToSize(reportText(text, ''), L.contentWidth - 18);
    const chunks = [];
    for (let index = 0; index < Math.max(1, lines.length); index += 8) {
      chunks.push(lines.slice(index, index + 8));
    }
    chunks.forEach((chunk, index) => {
      const height = 13 + chunk.length * (fontSize * 0.48);
      y = ensureSpace(height + 4);
      doc.setFillColor(...fill);
      doc.setDrawColor(...C.line);
      doc.setLineWidth(0.3);
      doc.roundedRect(L.margin, y, L.contentWidth, height, 2.5, 2.5, 'FD');
      doc.setFillColor(...accent);
      doc.roundedRect(L.margin, y, 3.5, height, 1.5, 1.5, 'F');
      if (index === 0) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.3);
        doc.setTextColor(...accent);
        doc.text(reportText(label, '').toUpperCase(), L.margin + 8, y + 7, { maxWidth: L.contentWidth - 16 });
      }
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(fontSize);
      doc.setTextColor(...C.muted);
      doc.text(chunk, L.margin + 8, y + (index === 0 ? 14 : 8), { lineHeightFactor: 1.25 });
      y += height + 4;
    });
  };

  const drawEmptyCard = (message, accent = C.indigo, fill = C.indigoLight) => {
    drawTextCard({ label: 'No data supplied', text: message, accent, fill, fontSize: 8.2 });
  };

  // Context and at-a-glance plan ------------------------------------------
  drawTextCard({
    label: 'Important context',
    text: 'For educational and wellness purposes only. This report does not diagnose, treat, or cure any disease. Always consult a licensed healthcare professional before starting, stopping, or changing any supplement regimen.',
    accent: C.indigo,
    fill: C.indigoLight,
    fontSize: 8.1,
  });

  const kpiGap = 4;
  const kpiWidth = (L.contentWidth - kpiGap * 3) / 4;
  y = ensureSpace(26);
  drawKpi(doc, L.margin, y, kpiWidth, 24, assessment?.age ?? '—', 'Age', C.cyan, C.tealLight);
  drawKpi(doc, L.margin + kpiWidth + kpiGap, y, kpiWidth, 24, asArray(assessment?.healthGoals).length, 'Health goals', C.violet, C.violetLight);
  drawKpi(doc, L.margin + (kpiWidth + kpiGap) * 2, y, kpiWidth, 24, recommendations.length, 'Plan items', C.emerald, C.emeraldLight);
  drawKpi(doc, L.margin + (kpiWidth + kpiGap) * 3, y, kpiWidth, 24, shouldConsult ? 'Review' : 'Routine', 'Next step', shouldConsult ? C.rose : C.indigo, shouldConsult ? C.roseLight : C.indigoLight);
  y += 32;

  y = beginSection('Clinical summary', C.emerald);
  drawTextCard({
    label: 'Summary',
    text: results?.summary || 'No clinical summary was returned for this assessment.',
    accent: C.emerald,
    fill: C.emeraldLight,
    fontSize: 9,
  });

  if (shouldConsult) {
    drawTextCard({
      label: 'Medical consultation recommended',
      text: results?.consultReason || 'A licensed healthcare professional should review this plan before it is started.',
      accent: C.rose,
      fill: C.roseLight,
      fontSize: 8.6,
    });
  }

  // Patient snapshot --------------------------------------------------------
  y = beginSection('Patient snapshot', C.indigo);
  const weight = asNumber(assessment?.weight);
  const heightCm = asNumber(assessment?.height);
  const bmi = weight && heightCm && heightCm > 0 ? weight / ((heightCm / 100) ** 2) : null;
  const bmiLabel = bmi === null ? '—' : `${bmi.toFixed(1)} (${bmi < 18.5 ? 'underweight' : bmi < 25 ? 'normal range' : bmi < 30 ? 'above range' : 'high range'})`;
  const profileRows = [
    ['Name', resolvedName],
    ['Age / gender', [assessment?.age ? `${assessment.age} years` : null, assessment?.gender].filter(Boolean).join(' | ') || '—'],
    ['Weight / height', [weight ? `${weight} kg` : null, heightCm ? `${heightCm} cm` : null].filter(Boolean).join(' | ') || '—'],
    ['BMI', bmiLabel],
    ['Activity / diet', [assessment?.activityLevel, assessment?.dietType].filter(Boolean).join(' | ') || '—'],
    ['Sleep / hydration', [assessment?.sleepQuality, assessment?.waterIntake].filter(Boolean).join(' | ') || '—'],
    ['Health goals', listValue(assessment?.healthGoals) || '—'],
    ['Symptoms', listValue(assessment?.symptoms) || 'None reported'],
    ['Conditions', listValue(assessment?.medicalConditions) || 'None reported'],
    ['Allergies', listValue(assessment?.allergies) || 'None reported'],
  ].filter(([, value]) => nonEmpty(value));
  y = runTable({
    startY: y,
    head: [['Profile field', 'Snapshot']],
    body: profileRows.map(([label, value]) => [label, reportText(value, '—')]),
    theme: 'grid',
    headStyles: { fillColor: C.navy, textColor: C.white, fontSize: 7.5, fontStyle: 'bold', cellPadding: 4 },
    bodyStyles: { fontSize: 8, textColor: C.ink, cellPadding: 3.5, valign: 'top', lineColor: C.line, lineWidth: 0.2 },
    alternateRowStyles: { fillColor: C.slateLight },
    columnStyles: { 0: { cellWidth: 44, fontStyle: 'bold', textColor: C.indigo }, 1: { cellWidth: 'auto' } },
  }) + 9;

  // Supplement plan ---------------------------------------------------------
  y = beginSection('Supplement plan', C.violet);
  if (recommendations.length === 0) {
    drawEmptyCard('No supplement recommendations were generated for this assessment.', C.violet, C.violetLight);
  } else {
    const priorityOrder = { high: 0, critical: 0, medium: 1, moderate: 1, low: 2 };
    const sorted = [...recommendations].sort((a, b) => {
      const left = priorityOrder[reportText(a?.priority, 'medium').toLowerCase()] ?? 3;
      const right = priorityOrder[reportText(b?.priority, 'medium').toLowerCase()] ?? 3;
      if (left !== right) return left - right;
      return (asNumber(b?.confidenceScore) || 0) - (asNumber(a?.confidenceScore) || 0);
    });
    y = runTable({
      startY: y,
      head: [['Supplement', 'Priority', 'Match', 'Why it may help', 'How to use', 'Timing']],
      body: sorted.map((rec) => [
        cleanReportText(rec?.name || 'Unnamed supplement'),
        priorityMeta(rec?.priority).label,
        scoreValue(rec?.confidenceScore),
        cleanReportText(rec?.reason || 'No rationale supplied.'),
        cleanReportText(rec?.dosage || 'Follow clinician guidance'),
        cleanReportText(rec?.timing || 'Not specified'),
      ]),
      theme: 'grid',
      headStyles: { fillColor: C.navy, textColor: C.white, fontSize: 7.2, fontStyle: 'bold', cellPadding: 3.5 },
      bodyStyles: { fontSize: 7.2, textColor: C.ink, cellPadding: 3.2, valign: 'top', lineColor: C.line, lineWidth: 0.2 },
      alternateRowStyles: { fillColor: C.violetLight },
      columnStyles: {
        0: { cellWidth: 27, fontStyle: 'bold' },
        1: { cellWidth: 18, halign: 'center' },
        2: { cellWidth: 16, halign: 'center' },
        3: { cellWidth: 52 },
        4: { cellWidth: 31 },
        5: { cellWidth: 36 },
      },
      didParseCell: (data) => {
        if (data.section !== 'body') return;
        if (data.column.index === 1) {
          const meta = priorityMeta(data.cell.raw);
          data.cell.styles.textColor = meta.color;
          data.cell.styles.fillColor = meta.fill;
          data.cell.styles.fontStyle = 'bold';
        }
        if (data.column.index === 2) {
          data.cell.styles.textColor = C.indigo;
          data.cell.styles.fontStyle = 'bold';
        }
      },
    }) + 8;

    // The core plan is intentionally allowed to split across pages. Start the
    // evidence/safety table on a clean page so AutoTable's split-row boundary
    // can never sit underneath the next section heading.
    y = addPage();
    y = beginSection('Evidence, food sources & safety', C.teal);
    y = runTable({
      startY: y,
      head: [['Supplement', 'Evidence', 'Food sources', 'Interactions / side effects']],
      body: sorted.map((rec) => [
        cleanReportText(rec?.name || 'Unnamed supplement'),
        cleanReportText(rec?.evidence || 'No evidence text supplied.'),
        cleanReportText(expandFoods(rec?.foods) || 'Not specified'),
        cleanReportText([
          nonEmpty(rec?.interactions) && rec.interactions !== 'None identified' ? rec.interactions : null,
          nonEmpty(rec?.sideEffects) ? rec.sideEffects : null,
        ].filter(Boolean).join(' | ') || 'No interactions identified.'),
      ]),
      theme: 'grid',
      headStyles: { fillColor: C.deep, textColor: C.white, fontSize: 7.2, fontStyle: 'bold', cellPadding: 3.5 },
      bodyStyles: { fontSize: 7.1, textColor: C.ink, cellPadding: 3.2, valign: 'top', lineColor: C.line, lineWidth: 0.2 },
      alternateRowStyles: { fillColor: C.tealLight },
      columnStyles: { 0: { cellWidth: 27, fontStyle: 'bold' }, 1: { cellWidth: 56 }, 2: { cellWidth: 45 }, 3: { cellWidth: 'auto' } },
    }) + 9;
  }

  // Daily rhythm ------------------------------------------------------------
  const dailySchedule = asArray(results?.dailySchedule);
  if (dailySchedule.length > 0) {
    y = beginSection('Daily rhythm', C.cyan);
    y = runTable({
      startY: y,
      head: [['Time of day', 'Plan']],
      body: dailySchedule.map((slot) => {
        const supplements = asArray(slot?.supplements).map((item) => {
          const name = reportText(item, '').split(' - ')[0].trim();
          const dosage = getDosage(sortedRecommendationsForLookup(recommendations), name);
          return dosage ? `${name} - ${reportText(dosage, '')}` : name;
        }).filter(Boolean);
        return [reportText(slot?.time, 'Anytime'), supplements.join('\n') || 'No item assigned'];
      }),
      theme: 'grid',
      headStyles: { fillColor: C.navy, textColor: C.white, fontSize: 8, fontStyle: 'bold', cellPadding: 4 },
      bodyStyles: { fontSize: 8, textColor: C.ink, cellPadding: 3.8, valign: 'top', lineColor: C.line, lineWidth: 0.2 },
      alternateRowStyles: { fillColor: C.tealLight },
      columnStyles: { 0: { cellWidth: 42, fontStyle: 'bold', textColor: C.teal }, 1: { cellWidth: 'auto' } },
    }) + 9;
  }

  // Recovery roadmap --------------------------------------------------------
  const actionPlan = asArray(results?.actionPlan);
  if (actionPlan.length > 0) {
    y = beginSection('Progress roadmap', C.amber);
    const rows = actionPlan.map((phase, index) => {
      if (typeof phase === 'string') return [`Phase ${index + 1}`, phase, '', ''];
      const steps = asArray(phase?.steps?.length ? phase.steps : [...asArray(phase?.supplements), ...asArray(phase?.habits), ...asArray(phase?.activity)]);
      return [
        `Phase ${index + 1}`,
        reportText(phase?.phase || phase?.week, 'Personalized phase'),
        [reportText(phase?.focus, ''), ...steps.map((step) => `- ${reportText(step, '')}`)].filter(Boolean).join('\n') || 'Continue as advised.',
        asArray(phase?.expectedChanges).map((item) => `- ${reportText(item, '')}`).join('\n') || 'Monitor progress',
      ];
    });
    y = runTable({
      startY: y,
      head: [['Phase', 'Focus', 'Actions', 'Expected changes']],
      body: rows,
      theme: 'grid',
      headStyles: { fillColor: C.navy, textColor: C.white, fontSize: 7.5, fontStyle: 'bold', cellPadding: 3.8 },
      bodyStyles: { fontSize: 7.5, textColor: C.ink, cellPadding: 3.5, valign: 'top', lineColor: C.line, lineWidth: 0.2 },
      alternateRowStyles: { fillColor: C.amberLight },
      columnStyles: { 0: { cellWidth: 20, fontStyle: 'bold', textColor: C.amber }, 1: { cellWidth: 35 }, 2: { cellWidth: 67 }, 3: { cellWidth: 'auto' } },
    }) + 9;
  }

  // Lifestyle and meals -----------------------------------------------------
  const lifestyleAdvice = asArray(results?.lifestyleAdvice);
  const mealRecommendations = asArray(results?.mealRecommendations);
  if (lifestyleAdvice.length > 0 || mealRecommendations.length > 0) {
    y = beginSection('Lifestyle & nutrition', C.emerald);
    const rows = [
      ...lifestyleAdvice.map((item) => ['Lifestyle', reportText(item?.category, 'Guidance'), reportText(item?.advice, 'Continue with your plan.')]),
      ...mealRecommendations.map((item) => ['Meal', reportText(item?.meal, 'Meal idea'), reportText(item?.suggestion, 'Choose a balanced option.')]),
    ];
    y = runTable({
      startY: y,
      head: [['Area', 'Focus', 'Practical guidance']],
      body: rows,
      theme: 'grid',
      headStyles: { fillColor: C.navy, textColor: C.white, fontSize: 7.5, fontStyle: 'bold', cellPadding: 3.8 },
      bodyStyles: { fontSize: 7.8, textColor: C.ink, cellPadding: 3.5, valign: 'top', lineColor: C.line, lineWidth: 0.2 },
      alternateRowStyles: { fillColor: C.emeraldLight },
      columnStyles: { 0: { cellWidth: 27, fontStyle: 'bold', textColor: C.emerald }, 1: { cellWidth: 38 }, 2: { cellWidth: 'auto' } },
    }) + 9;
  }

  // Safety and support ------------------------------------------------------
  const warnings = asArray(results?.warnings);
  const avoidList = asArray(results?.avoidList);
  if (warnings.length > 0) {
    drawTextCard({ label: 'Important warnings', text: warnings.map((item) => `- ${reportText(item, '')}`).join('\n'), accent: C.rose, fill: C.roseLight, fontSize: 8.1 });
  }
  if (avoidList.length > 0) {
    drawTextCard({ label: 'Supplements to avoid', text: avoidList.map((item) => `- ${reportText(item, '')}`).join('\n'), accent: C.amber, fill: C.amberLight, fontSize: 8.1 });
  }

  const support = results?.seekingSupport;
  if (support?.include) {
    y = beginSection('Support resources', C.rose);
    drawTextCard({ label: reportText(support.title, 'Support is available'), text: support.intro || 'You do not have to handle this alone.', accent: C.rose, fill: C.roseLight, fontSize: 8.2 });
    const resources = asArray(support.resources);
    if (resources.length > 0) {
      y = runTable({
        startY: ensureSpace(18),
        head: [['Resource', 'Contact']],
        body: resources.map((resource) => [
          reportText(resource?.name || resource?.label, 'Support resource'),
          [reportText(resource?.description, ''), reportText(resource?.url, '')].filter(Boolean).join('\n'),
        ]),
        theme: 'grid',
        headStyles: { fillColor: C.navy, textColor: C.white, fontSize: 7.5, fontStyle: 'bold', cellPadding: 3.5 },
        bodyStyles: { fontSize: 7.5, textColor: C.ink, cellPadding: 3.5, valign: 'top', lineColor: C.line, lineWidth: 0.2 },
        alternateRowStyles: { fillColor: C.roseLight },
        columnStyles: { 0: { cellWidth: 55, fontStyle: 'bold' }, 1: { cellWidth: 'auto' } },
      }) + 8;
    }
  }

  // Evidence note -----------------------------------------------------------
  y = ensureSpace(19);
  drawTextCard({
    label: 'Evidence & report notes',
    text: results?.disclaimer || results?.evidenceNote
      || 'Recommendations prioritize recent peer-reviewed research, clinical guidelines, and recognized medical organizations. AI-assisted wellness guidance does not replace professional medical advice, diagnosis, or treatment.',
    accent: C.indigo,
    fill: C.indigoLight,
    fontSize: 7.1,
  });

  drawReportFooter(doc, {
    leftText: `SuppliWise | ${resolvedName} | Educational purposes only. Not medical advice.`,
  });

  const datePart = safeAssessmentDate.toISOString().slice(0, 10);
  const timePart = safeAssessmentDate.toISOString().slice(11, 19).replace(/:/g, '-');
  const namePart = safeFilenamePart(resolvedName, 'member');
  const filename = `SuppliWise_Wellness_Report_${namePart}_${datePart}_${timePart}.pdf`;
  if (save) downloadPdf(doc, filename);
  return { filename, pageCount: doc.internal.getNumberOfPages() };
}

/**
 * Last-resort, table-free renderer. A malformed AI row should never leave the
 * user staring at a cryptic jsPDF exception; the fallback still gives them a
 * readable, downloadable report with the core plan and safety notes.
 */
export async function downloadWellnessFallback({ results = {}, assessment = {}, userName = '', save = true } = {}) {
  const doc = new JsPDF({ unit: 'mm', format: 'a4', compress: true });
  const now = new Date();
  const date = new Date(assessment?.createdAt || now);
  const safeDate = Number.isFinite(date.getTime()) ? date : now;
  const name = getUserName(assessment, userName);
  const recs = asArray(results?.recommendations);
  drawReportHeader(doc, {
    title: 'SuppliWise',
    subtitle: 'Personalized supplement & wellness report',
    preparedFor: name,
    dateLabel: `Assessment: ${formatReportDate(safeDate)}`,
    dateValue: formatReportDate(safeDate),
    badge: 'Wellness report',
    status: 'Personalized plan',
  });

  let y = L.firstContentTop;
  const pageHeader = (pageNumber) => drawReportHeader(doc, {
    title: 'SuppliWise',
    subtitle: 'Personalized supplement & wellness report',
    badge: 'Wellness report',
    pageNumber,
    compact: true,
  });
  const addPage = () => {
    doc.addPage();
    pageHeader(doc.internal.getNumberOfPages());
    y = L.continuationContentTop;
  };
  const ensure = (height) => {
    if (!Number.isFinite(y) || y + height > L.pageHeight - L.footerHeight - 4) {
      addPage();
    }
    return y;
  };
  const block = (label, value, accent = C.emerald, fill = C.emeraldLight) => {
    const lines = doc.splitTextToSize(reportText(value, ''), L.contentWidth - 18);
    for (let start = 0; start < Math.max(1, lines.length); start += 8) {
      const chunk = lines.slice(start, start + 8);
      const height = 13 + chunk.length * 4;
      y = ensure(height);
      doc.setFillColor(...fill);
      doc.setDrawColor(...C.line);
      doc.roundedRect(L.margin, y, L.contentWidth, height, 2, 2, 'FD');
      doc.setFillColor(...accent);
      doc.rect(L.margin, y, 3.5, height, 'F');
      if (start === 0) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.2);
        doc.setTextColor(...accent);
        doc.text(reportText(label, '').toUpperCase(), L.margin + 8, y + 7, { maxWidth: L.contentWidth - 16 });
      }
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.2);
      doc.setTextColor(...C.muted);
      doc.text(chunk, L.margin + 8, y + (start === 0 ? 14 : 8), { lineHeightFactor: 1.2 });
      y += height + 4;
    }
  };

  block('Important context', 'For educational and wellness purposes only. This report does not diagnose, treat, or cure any disease. Always consult a licensed healthcare professional before starting any supplement regimen.', C.indigo, C.indigoLight);
  block('Clinical summary', results?.summary || 'No clinical summary was returned for this assessment.');
  if (results?.consultDoctor) block('Medical consultation recommended', results?.consultReason || 'Please review this plan with a licensed healthcare professional.', C.rose, C.roseLight);
  block('Plan', recs.length > 0
    ? recs.map((rec, index) => `${index + 1}. ${reportText(rec?.name, 'Supplement')} — ${reportText(rec?.dosage, 'Follow clinician guidance')}; ${reportText(rec?.timing, 'Timing not specified')}. ${reportText(rec?.reason, '')}`).join('\n\n')
    : 'No supplement recommendations were generated.', C.violet, C.violetLight);
  const warnings = asArray(results?.warnings);
  if (warnings.length > 0) block('Important warnings', warnings.map((item) => `- ${reportText(item, '')}`).join('\n'), C.rose, C.roseLight);
  block('Evidence & report notes', 'Recommendations prioritize recent peer-reviewed research, clinical guidelines, and recognized medical organizations. AI-assisted wellness guidance does not replace professional medical advice, diagnosis, or treatment.', C.indigo, C.indigoLight);

  drawReportFooter(doc, { leftText: `SuppliWise | ${name} | Educational purposes only. Not medical advice.` });
  const timePart = safeDate.toISOString().slice(11, 19).replace(/:/g, '-');
  const filename = `SuppliWise_Wellness_Report_${safeFilenamePart(name, 'member')}_${safeDate.toISOString().slice(0, 10)}_${timePart}.pdf`;
  if (save) downloadPdf(doc, filename);
  return { filename, pageCount: doc.internal.getNumberOfPages(), fallback: true };
}

// Kept tiny and local so the daily schedule can use the same fuzzy, but safe,
// supplement-name matching as the live results view.
function sortedRecommendationsForLookup(recommendations) {
  return recommendations;
}
