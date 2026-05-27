import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

// ── Colour palette ─────────────────────────────────────────────────────────
const GREEN       = [34, 197, 94];
const GREEN_DARK  = [22, 163, 74];
const GREEN_LIGHT = [240, 253, 244];
const GRAY_DARK   = [17, 24, 39];
const GRAY_MID    = [75, 85, 99];
const GRAY_LIGHT  = [243, 244, 246];
const RED_LIGHT   = [254, 242, 242];
const RED_MID     = [153, 27, 27];
const AMBER_LIGHT = [255, 247, 237];
const AMBER_MID   = [146, 64, 14];
const WHITE       = [255, 255, 255];

const PRIORITY_COLOR = {
  High:   [220, 38, 38],
  Medium: [217, 119, 6],
  Low:    [107, 114, 128],
};

// ── Helpers ────────────────────────────────────────────────────────────────
function hex(rgb) {
  return '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
}

function wrap(doc, text, x, y, maxWidth, lineHeight = 5) {
  const lines = doc.splitTextToSize(String(text || ''), maxWidth);
  doc.text(lines, x, y);
  return y + lines.length * lineHeight;
}

function sectionTitle(doc, text, y, pageW) {
  doc.setFillColor(...GREEN_LIGHT);
  doc.rect(14, y - 4, pageW - 28, 9, 'F');
  doc.setDrawColor(...GREEN);
  doc.setLineWidth(0.5);
  doc.line(14, y - 4, 14, y + 5);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...GREEN_DARK);
  doc.text(text, 18, y + 1);
  doc.setTextColor(...GRAY_DARK);
  return y + 10;
}

function checkPage(doc, y, needed = 20) {
  if (y + needed > doc.internal.pageSize.height - 20) {
    doc.addPage();
    return 20;
  }
  return y;
}

// ── Main export function ───────────────────────────────────────────────────
export function exportResultsToPDF(recommendations, assessment) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.width;
  const pageH = doc.internal.pageSize.height;
  const margin = 14;
  const contentW = pageW - margin * 2;
  let y = 0;

  // ── Cover header ──────────────────────────────────────────────────────
  doc.setFillColor(...GREEN);
  doc.rect(0, 0, pageW, 38, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(...WHITE);
  doc.text('SuppliWise', margin, 16);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.text('Personalized Supplement & Wellness Report', margin, 24);

  const dateStr = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
  doc.setFontSize(9);
  doc.setTextColor(220, 252, 231);
  doc.text(`Generated: ${dateStr}`, margin, 32);

  y = 46;

  // ── Disclaimer banner ─────────────────────────────────────────────────
  doc.setFillColor(239, 246, 255);
  doc.setDrawColor(191, 219, 254);
  doc.setLineWidth(0.3);
  doc.roundedRect(margin, y, contentW, 10, 2, 2, 'FD');
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8);
  doc.setTextColor(30, 64, 175);
  doc.text(
    'Educational & wellness purposes only. Not a substitute for professional medical advice. Consult a licensed healthcare provider before starting any supplement.',
    margin + 3, y + 6.5,
    { maxWidth: contentW - 6 }
  );
  y += 16;

  // ── Clinical summary ──────────────────────────────────────────────────
  if (recommendations.summary) {
    y = sectionTitle(doc, '📋  Clinical Summary', y, pageW);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(...GRAY_MID);
    y = wrap(doc, recommendations.summary, margin, y, contentW, 5.5);
    y += 6;
  }

  // ── Consult doctor alert ──────────────────────────────────────────────
  if (recommendations.consultDoctor && recommendations.consultReason) {
    y = checkPage(doc, y, 18);
    doc.setFillColor(...RED_LIGHT);
    doc.setDrawColor(252, 165, 165);
    doc.roundedRect(margin, y, contentW, 14, 2, 2, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...RED_MID);
    doc.text('⚠  Medical Consultation Recommended', margin + 3, y + 5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(127, 29, 29);
    doc.text(recommendations.consultReason, margin + 3, y + 11, { maxWidth: contentW - 6 });
    y += 20;
  }

  // ── Patient profile ───────────────────────────────────────────────────
  if (assessment) {
    y = checkPage(doc, y, 30);
    y = sectionTitle(doc, '👤  Patient Profile', y, pageW);

    const profileRows = [];
    if (assessment.age)           profileRows.push(['Age', `${assessment.age} years`]);
    if (assessment.gender)        profileRows.push(['Gender', assessment.gender]);
    if (assessment.weight)        profileRows.push(['Weight', `${assessment.weight} kg`]);
    if (assessment.height)        profileRows.push(['Height', `${assessment.height} cm`]);
    if (assessment.activityLevel) profileRows.push(['Activity Level', assessment.activityLevel]);
    if (assessment.dietType)      profileRows.push(['Diet Type', assessment.dietType]);
    if (assessment.sleepQuality)  profileRows.push(['Sleep Quality', assessment.sleepQuality]);
    if (assessment.waterIntake)   profileRows.push(['Water Intake', assessment.waterIntake]);

    if (profileRows.length > 0) {
      autoTable(doc, {
        startY: y,
        head: [],
        body: profileRows,
        theme: 'plain',
        styles: { fontSize: 9, cellPadding: 2.5, textColor: GRAY_DARK },
        columnStyles: {
          0: { fontStyle: 'bold', cellWidth: 45, textColor: GRAY_MID },
          1: { cellWidth: contentW - 45 },
        },
        margin: { left: margin, right: margin },
        tableWidth: contentW,
      });
      y = doc.lastAutoTable.finalY + 4;
    }

    if (assessment.healthGoals?.length > 0) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(...GRAY_MID);
      doc.text('Health Goals:', margin, y);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...GRAY_DARK);
      y = wrap(doc, assessment.healthGoals.join('  •  '), margin + 28, y, contentW - 28, 5);
      y += 3;
    }

    if (assessment.symptoms?.filter(s => s !== 'No current symptoms').length > 0) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(...GRAY_MID);
      doc.text('Symptoms:', margin, y);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...GRAY_DARK);
      y = wrap(doc, assessment.symptoms.filter(s => s !== 'No current symptoms').join('  •  '), margin + 24, y, contentW - 24, 5);
      y += 4;
    }
  }

  // ── Supplement recommendations ────────────────────────────────────────
  if (recommendations.recommendations?.length > 0) {
    y = checkPage(doc, y, 20);
    y = sectionTitle(doc, '💊  Supplement Recommendations', y, pageW);

    const tableBody = recommendations.recommendations.map(rec => {
      const priorityLabel = rec.priority || '';
      const score = rec.confidenceScore ? `${rec.confidenceScore}%` : '—';
      const reason = rec.reason || '';
      const dosage = rec.dosage || '—';
      const timing = rec.timing || '—';
      const interactions = (rec.interactions && rec.interactions !== 'None identified') ? rec.interactions : 'None';
      return [rec.name || '', priorityLabel, score, reason, dosage, timing, interactions];
    });

    autoTable(doc, {
      startY: y,
      head: [['Supplement', 'Priority', 'Match', 'Reason', 'Dosage', 'Timing', 'Interactions']],
      body: tableBody,
      theme: 'grid',
      headStyles: {
        fillColor: GREEN,
        textColor: WHITE,
        fontSize: 8,
        fontStyle: 'bold',
        cellPadding: 3,
      },
      bodyStyles: {
        fontSize: 7.5,
        cellPadding: 2.5,
        textColor: GRAY_DARK,
        valign: 'top',
      },
      alternateRowStyles: { fillColor: GREEN_LIGHT },
      columnStyles: {
        0: { cellWidth: 30, fontStyle: 'bold' },
        1: { cellWidth: 16 },
        2: { cellWidth: 12, halign: 'center' },
        3: { cellWidth: 48 },
        4: { cellWidth: 28 },
        5: { cellWidth: 22 },
        6: { cellWidth: 26 },
      },
      margin: { left: margin, right: margin },
      tableWidth: contentW,
      didParseCell(data) {
        // Colour-code the Priority column
        if (data.column.index === 1 && data.section === 'body') {
          const val = data.cell.raw;
          const rgb = PRIORITY_COLOR[val];
          if (rgb) {
            data.cell.styles.textColor = rgb;
            data.cell.styles.fontStyle = 'bold';
          }
        }
      },
    });
    y = doc.lastAutoTable.finalY + 6;
  }

  // ── Daily schedule ────────────────────────────────────────────────────
  if (recommendations.dailySchedule?.length > 0) {
    y = checkPage(doc, y, 20);
    y = sectionTitle(doc, '🕐  Daily Schedule', y, pageW);

    autoTable(doc, {
      startY: y,
      head: [['Time of Day', 'Supplements']],
      body: recommendations.dailySchedule.map(slot => [
        slot.time,
        (slot.supplements || []).join(', '),
      ]),
      theme: 'striped',
      headStyles: { fillColor: GREEN, textColor: WHITE, fontSize: 8.5, fontStyle: 'bold' },
      bodyStyles: { fontSize: 8.5, cellPadding: 3, textColor: GRAY_DARK },
      alternateRowStyles: { fillColor: GREEN_LIGHT },
      columnStyles: {
        0: { cellWidth: 40, fontStyle: 'bold' },
        1: { cellWidth: contentW - 40 },
      },
      margin: { left: margin, right: margin },
      tableWidth: contentW,
    });
    y = doc.lastAutoTable.finalY + 6;
  }

  // ── Lifestyle advice ──────────────────────────────────────────────────
  if (recommendations.lifestyleAdvice?.length > 0) {
    y = checkPage(doc, y, 20);
    y = sectionTitle(doc, '🌿  Lifestyle Recommendations', y, pageW);

    autoTable(doc, {
      startY: y,
      head: [['Category', 'Advice']],
      body: recommendations.lifestyleAdvice.map(item => [item.category, item.advice]),
      theme: 'striped',
      headStyles: { fillColor: GREEN, textColor: WHITE, fontSize: 8.5, fontStyle: 'bold' },
      bodyStyles: { fontSize: 8.5, cellPadding: 3, textColor: GRAY_DARK },
      alternateRowStyles: { fillColor: GREEN_LIGHT },
      columnStyles: {
        0: { cellWidth: 35, fontStyle: 'bold', textColor: GREEN_DARK },
        1: { cellWidth: contentW - 35 },
      },
      margin: { left: margin, right: margin },
      tableWidth: contentW,
    });
    y = doc.lastAutoTable.finalY + 6;
  }

  // ── Meal recommendations ──────────────────────────────────────────────
  if (recommendations.mealRecommendations?.length > 0) {
    y = checkPage(doc, y, 20);
    y = sectionTitle(doc, '🍽️  Meal Recommendations', y, pageW);

    autoTable(doc, {
      startY: y,
      head: [['Meal', 'Suggestion']],
      body: recommendations.mealRecommendations.map(m => [m.meal, m.suggestion]),
      theme: 'striped',
      headStyles: { fillColor: [217, 119, 6], textColor: WHITE, fontSize: 8.5, fontStyle: 'bold' },
      bodyStyles: { fontSize: 8.5, cellPadding: 3, textColor: GRAY_DARK },
      alternateRowStyles: { fillColor: AMBER_LIGHT },
      columnStyles: {
        0: { cellWidth: 28, fontStyle: 'bold', textColor: AMBER_MID },
        1: { cellWidth: contentW - 28 },
      },
      margin: { left: margin, right: margin },
      tableWidth: contentW,
    });
    y = doc.lastAutoTable.finalY + 6;
  }

  // ── Action plan ───────────────────────────────────────────────────────
  if (recommendations.actionPlan?.length > 0) {
    y = checkPage(doc, y, 20);
    y = sectionTitle(doc, '📋  Action Plan', y, pageW);

    autoTable(doc, {
      startY: y,
      head: [['#', 'Step']],
      body: recommendations.actionPlan.map((step, i) => [i + 1, step]),
      theme: 'plain',
      headStyles: { fillColor: GREEN, textColor: WHITE, fontSize: 8.5, fontStyle: 'bold' },
      bodyStyles: { fontSize: 8.5, cellPadding: 3, textColor: GRAY_DARK },
      alternateRowStyles: { fillColor: GRAY_LIGHT },
      columnStyles: {
        0: { cellWidth: 10, halign: 'center', fontStyle: 'bold', textColor: GREEN_DARK },
        1: { cellWidth: contentW - 10 },
      },
      margin: { left: margin, right: margin },
      tableWidth: contentW,
    });
    y = doc.lastAutoTable.finalY + 6;
  }

  // ── Warnings & avoid list ─────────────────────────────────────────────
  if (recommendations.warnings?.length > 0 || recommendations.avoidList?.length > 0) {
    y = checkPage(doc, y, 20);
    y = sectionTitle(doc, '⚠️  Warnings & Supplements to Avoid', y, pageW);

    if (recommendations.warnings?.length > 0) {
      doc.setFillColor(...RED_LIGHT);
      doc.setDrawColor(252, 165, 165);
      doc.roundedRect(margin, y, contentW, 7 + recommendations.warnings.length * 5.5, 2, 2, 'FD');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(...RED_MID);
      doc.text('Important Warnings:', margin + 3, y + 5);
      y += 9;
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(127, 29, 29);
      recommendations.warnings.forEach(w => {
        y = wrap(doc, `• ${w}`, margin + 5, y, contentW - 8, 5);
      });
      y += 4;
    }

    if (recommendations.avoidList?.length > 0) {
      y = checkPage(doc, y, 14);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(...RED_MID);
      doc.text('Supplements to Avoid:', margin, y);
      y += 5;
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(127, 29, 29);
      recommendations.avoidList.forEach(a => {
        y = wrap(doc, `• ${a}`, margin + 4, y, contentW - 8, 5);
      });
      y += 4;
    }
  }

  // ── Footer on every page ──────────────────────────────────────────────
  const totalPages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setFillColor(...GREEN);
    doc.rect(0, pageH - 10, pageW, 10, 'F');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...WHITE);
    doc.text('SuppliWise — Educational purposes only. Not medical advice.', margin, pageH - 3.5);
    doc.text(`Page ${p} of ${totalPages}`, pageW - margin, pageH - 3.5, { align: 'right' });
  }

  // ── Save ──────────────────────────────────────────────────────────────
  const filename = `SuppliWise_Report_${new Date().toISOString().slice(0, 10)}.pdf`;
  doc.save(filename);
}
