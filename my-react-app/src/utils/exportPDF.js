import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

// ── Palette ────────────────────────────────────────────────────────────────
const C = {
  green:       [34, 197, 94],
  greenDark:   [22, 163, 74],
  greenDeep:   [20, 83, 45],
  greenLight:  [240, 253, 244],
  greenBorder: [187, 247, 208],
  white:       [255, 255, 255],
  grayDark:    [17, 24, 39],
  grayMid:     [107, 114, 128],
  grayLight:   [249, 250, 251],
  grayBorder:  [229, 231, 235],
  redLight:    [254, 242, 242],
  redMid:      [185, 28, 28],
  redBorder:   [252, 165, 165],
  amberDark:   [180, 83, 9],
  amberLight:  [255, 251, 235],
  blueDark:    [30, 64, 175],
  blueLight:   [239, 246, 255],
  blueBorder:  [191, 219, 254],
};

const PRIORITY_COLORS = {
  High:   [220, 38, 38],
  Medium: [217, 119, 6],
  Low:    [107, 114, 128],
};

// ── Utilities ──────────────────────────────────────────────────────────────
const PAGE_W = 210;
const PAGE_H = 297;
const ML = 14;   // margin left
const MR = 14;   // margin right
const CW = PAGE_W - ML - MR;  // content width = 182mm

function addPage(doc) {
  doc.addPage();
  return 18;
}

function checkY(doc, y, needed) {
  if (y + needed > PAGE_H - 18) return addPage(doc);
  return y;
}

// Draws a left-accented section heading (no emoji)
function sectionHeading(doc, label, y) {
  y = checkY(doc, y, 14);

  // Accent bar
  doc.setFillColor(...C.green);
  doc.rect(ML, y, 3, 8, 'F');

  // Label
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...C.greenDeep);
  doc.text(label.toUpperCase(), ML + 6, y + 5.8);

  // Underline
  doc.setDrawColor(...C.greenBorder);
  doc.setLineWidth(0.3);
  doc.line(ML, y + 9, ML + CW, y + 9);

  return y + 14;
}

// Draws a small key-value row inline
function kvRow(doc, key, value, y, keyW = 42) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(...C.grayMid);
  doc.text(key, ML, y);

  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...C.grayDark);
  const lines = doc.splitTextToSize(String(value || ''), CW - keyW);
  doc.text(lines, ML + keyW, y);
  return y + lines.length * 5 + 1.5;
}

// Pill badge (coloured rounded rect + text)
function pill(doc, text, x, y, rgb) {
  const w = doc.getTextWidth(text) + 6;
  doc.setFillColor(rgb[0], rgb[1], rgb[2], 0.12);
  doc.setDrawColor(...rgb);
  doc.setLineWidth(0.3);
  doc.roundedRect(x, y - 3.5, w, 5.5, 1.5, 1.5, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(...rgb);
  doc.text(text, x + 3, y + 0.5);
  return x + w + 3;
}

// ── Footer on every page ───────────────────────────────────────────────────
function drawFooters(doc, userName) {
  const total = doc.internal.getNumberOfPages();
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    doc.setFillColor(...C.greenDeep);
    doc.rect(0, PAGE_H - 9, PAGE_W, 9, 'F');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...C.white);
    const footerLeft = userName
      ? `SuppliWise  |  ${userName}  |  Educational purposes only. Not medical advice.`
      : 'SuppliWise  |  Educational purposes only. Not medical advice.';
    doc.text(footerLeft, ML, PAGE_H - 3.2);
    doc.text(`Page ${p} / ${total}`, PAGE_W - MR, PAGE_H - 3.2, { align: 'right' });
  }
}

// ── Main export ────────────────────────────────────────────────────────────
export function exportResultsToPDF(recommendations, assessment) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  let y = 0;

  // Resolve user name — from assessment object or localStorage fallback
  const storedUser = (() => {
    try { return JSON.parse(localStorage.getItem('user') || '{}'); } catch { return {}; }
  })();
  const userName = assessment?.userName || assessment?.name || storedUser?.name || null;

  // ── COVER HEADER ────────────────────────────────────────────────────────
  // Full-width green band
  doc.setFillColor(...C.green);
  doc.rect(0, 0, PAGE_W, 50, 'F');

  // Logo text
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(26);
  doc.setTextColor(...C.white);
  doc.text('SuppliWise', ML, 18);

  // Subtitle
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(220, 252, 231);
  doc.text('Personalized Supplement & Wellness Report', ML, 27);

  // Patient name + date — same row, same size, same style
  const dateStr = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(220, 252, 231);
  if (userName) {
    doc.text(`Prepared for: ${userName}`, ML, 38);
    doc.text(dateStr, PAGE_W - MR, 38, { align: 'right' });
  } else {
    doc.text(dateStr, PAGE_W - MR, 38, { align: 'right' });
  }

  // Thin accent line below header
  doc.setFillColor(...C.greenDark);
  doc.rect(0, 50, PAGE_W, 1.5, 'F');

  y = 60;

  // ── DISCLAIMER ──────────────────────────────────────────────────────────
  doc.setFillColor(...C.blueLight);
  doc.setDrawColor(...C.blueBorder);
  doc.setLineWidth(0.3);
  doc.roundedRect(ML, y, CW, 11, 2, 2, 'FD');
  doc.setFillColor(...C.blueDark);
  doc.rect(ML, y, 2.5, 11, 'F');
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(7.8);
  doc.setTextColor(...C.blueDark);
  doc.text(
    'For educational and wellness purposes only. This report does not diagnose, treat, or cure any disease. Always consult a licensed healthcare professional before starting any supplement regimen.',
    ML + 5, y + 4,
    { maxWidth: CW - 7, lineHeightFactor: 1.5 }
  );
  y += 17;

  // ── CLINICAL SUMMARY ────────────────────────────────────────────────────
  if (recommendations.summary) {
    y = sectionHeading(doc, 'Clinical Summary', y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...C.grayMid);
    const lines = doc.splitTextToSize(recommendations.summary, CW);
    doc.text(lines, ML, y);
    y += lines.length * 5 + 6;
  }

  // ── CONSULT DOCTOR ALERT ─────────────────────────────────────────────────
  if (recommendations.consultDoctor && recommendations.consultReason) {
    y = checkY(doc, y, 20);
    doc.setFillColor(...C.redLight);
    doc.setDrawColor(...C.redBorder);
    doc.setLineWidth(0.4);
    doc.roundedRect(ML, y, CW, 16, 2, 2, 'FD');
    doc.setFillColor(...C.redMid);
    doc.rect(ML, y, 3, 16, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...C.redMid);
    doc.text('Medical Consultation Recommended', ML + 6, y + 6);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(127, 29, 29);
    const rLines = doc.splitTextToSize(recommendations.consultReason, CW - 10);
    doc.text(rLines, ML + 6, y + 12);
    y += 16 + rLines.length * 4.5 + 4;
  }

  // ── PATIENT PROFILE ──────────────────────────────────────────────────────
  if (assessment) {
    y = checkY(doc, y, 40);
    y = sectionHeading(doc, 'Patient Profile', y);

    // Name row — full width if present
    if (userName) {
      y = checkY(doc, y, 7);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(...C.grayMid);
      doc.text('Name', ML, y);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...C.grayDark);
      doc.text(userName, ML + 22, y);
      y += 6;
    }

    // Two-column grid layout
    const col1 = [
      assessment.age     ? ['Age',            `${assessment.age} years`]  : null,
      assessment.weight  ? ['Weight',          `${assessment.weight} kg`]  : null,
      assessment.activityLevel ? ['Activity', assessment.activityLevel]    : null,
      assessment.sleepQuality  ? ['Sleep',    assessment.sleepQuality]     : null,
    ].filter(Boolean);

    const col2 = [
      assessment.gender  ? ['Gender',  assessment.gender]                  : null,
      assessment.height  ? ['Height',  `${assessment.height} cm`]          : null,
      assessment.dietType ? ['Diet',   assessment.dietType]                : null,
      assessment.waterIntake ? ['Water', assessment.waterIntake]           : null,
    ].filter(Boolean);

    const rows = Math.max(col1.length, col2.length);
    const colW = CW / 2 - 4;

    for (let i = 0; i < rows; i++) {
      y = checkY(doc, y, 7);
      if (col1[i]) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.5);
        doc.setTextColor(...C.grayMid);
        doc.text(col1[i][0], ML, y);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...C.grayDark);
        doc.text(String(col1[i][1]), ML + 22, y);
      }
      if (col2[i]) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.5);
        doc.setTextColor(...C.grayMid);
        doc.text(col2[i][0], ML + colW + 8, y);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...C.grayDark);
        doc.text(String(col2[i][1]), ML + colW + 30, y);
      }
      y += 6;
    }

    // Health goals
    if (assessment.healthGoals?.length > 0) {
      y = checkY(doc, y, 8);
      y = kvRow(doc, 'Health Goals', assessment.healthGoals.join('  |  '), y);
    }

    // Symptoms
    const symptoms = (assessment.symptoms || []).filter(s => s !== 'No current symptoms');
    if (symptoms.length > 0) {
      y = checkY(doc, y, 8);
      y = kvRow(doc, 'Symptoms', symptoms.join('  |  '), y);
    }

    // Medical conditions
    const conditions = (assessment.medicalConditions || []).filter(c => c !== 'None');
    if (conditions.length > 0) {
      y = checkY(doc, y, 8);
      y = kvRow(doc, 'Conditions', conditions.join('  |  '), y);
    }

    y += 4;
  }

  // ── SUPPLEMENT RECOMMENDATIONS ───────────────────────────────────────────
  if (recommendations.recommendations?.length > 0) {
    y = checkY(doc, y, 24);
    y = sectionHeading(doc, 'Supplement Recommendations', y);

    autoTable(doc, {
      startY: y,
      head: [['Supplement', 'Priority', 'Match', 'Reason', 'Dosage', 'Timing', 'Interactions']],
      body: recommendations.recommendations.map(rec => [
        rec.name || '',
        rec.priority || '',
        rec.confidenceScore ? `${rec.confidenceScore}%` : '-',
        rec.reason || '',
        rec.dosage || '-',
        rec.timing || '-',
        (rec.interactions && rec.interactions !== 'None identified') ? rec.interactions : 'None',
      ]),
      theme: 'grid',
      headStyles: {
        fillColor: C.greenDeep,
        textColor: C.white,
        fontSize: 7.5,
        fontStyle: 'bold',
        cellPadding: { top: 4, bottom: 4, left: 3, right: 3 },
        halign: 'left',
      },
      bodyStyles: {
        fontSize: 7.5,
        cellPadding: { top: 3, bottom: 3, left: 3, right: 3 },
        textColor: C.grayDark,
        valign: 'top',
        lineColor: C.grayBorder,
        lineWidth: 0.2,
      },
      alternateRowStyles: {
        fillColor: C.greenLight,
      },
      columnStyles: {
        0: { cellWidth: 30, fontStyle: 'bold' },  // Supplement
        1: { cellWidth: 18, halign: 'center' },   // Priority
        2: { cellWidth: 14, halign: 'center' },   // Match
        3: { cellWidth: 50 },                     // Reason
        4: { cellWidth: 28 },                     // Dosage
        5: { cellWidth: 20 },                     // Timing
        6: { cellWidth: 22 },                     // Interactions
      },
      margin: { left: ML, right: MR },
      tableWidth: CW,
      didParseCell(data) {
        if (data.column.index === 1 && data.section === 'body') {
          const rgb = PRIORITY_COLORS[data.cell.raw];
          if (rgb) {
            data.cell.styles.textColor = rgb;
            data.cell.styles.fontStyle = 'bold';
          }
        }
      },
    });
    y = doc.lastAutoTable.finalY + 8;
  }

  // ── DAILY SCHEDULE & RECOVERY PLAN ──────────────────────────────────────
  const hasSchedule = recommendations.dailySchedule?.length > 0;
  const hasActionPlan = recommendations.actionPlan?.length > 0;

  if (hasSchedule || hasActionPlan) {
    y = checkY(doc, y, 24);
    y = sectionHeading(doc, 'Daily Schedule & Recovery Plan', y);

    // ── Daily Schedule table ──
    if (hasSchedule) {
      // Build dosage lookup from recommendations
      const dosageMap = {};
      (recommendations.recommendations || []).forEach(rec => {
        if (rec.name && rec.dosage) dosageMap[rec.name.toLowerCase()] = rec.dosage;
      });
      const getDosage = (pillName) => {
        const pill = pillName.toLowerCase();
        if (dosageMap[pill]) return dosageMap[pill];
        for (const [recName, dosage] of Object.entries(dosageMap)) {
          if (pill.includes(recName) || recName.includes(pill)) return dosage;
          const pillWords = pill.split(/\s+/).filter(w => w.length > 3);
          const recWords = recName.split(/\s+/).filter(w => w.length > 3);
          if (pillWords.some(w => recWords.includes(w))) return dosage;
        }
        return null;
      };

      autoTable(doc, {
        startY: y,
        head: [['Time of Day', 'Supplements to Take']],
        body: recommendations.dailySchedule.map(slot => [
          slot.time,
          (slot.supplements || []).map(s => {
            const d = getDosage(s);
            return d ? `${s} — ${d}` : s;
          }).join('\n'),
        ]),
        theme: 'striped',
        headStyles: {
          fillColor: C.greenDeep,
          textColor: C.white,
          fontSize: 8.5,
          fontStyle: 'bold',
          cellPadding: { top: 4, bottom: 4, left: 4, right: 4 },
        },
        bodyStyles: {
          fontSize: 8.5,
          cellPadding: { top: 3.5, bottom: 3.5, left: 4, right: 4 },
          textColor: C.grayDark,
          lineColor: C.grayBorder,
          lineWidth: 0.2,
        },
        alternateRowStyles: { fillColor: C.greenLight },
        columnStyles: {
          0: { cellWidth: 42, fontStyle: 'bold', textColor: C.greenDark },
          1: { cellWidth: CW - 42 },
        },
        margin: { left: ML, right: MR },
        tableWidth: CW,
      });
      y = doc.lastAutoTable.finalY + 10;
    }

    // ── Recovery Plan phases ──
    if (hasActionPlan) {
      recommendations.actionPlan.forEach((phase, i) => {
        // Estimate height needed
        const steps = typeof phase === 'string' ? [] :
          (phase.steps?.length > 0 ? phase.steps : [
            ...(phase.supplements || []),
            ...(phase.habits || []),
            ...(phase.activity || []),
          ]);
        const expected = typeof phase === 'string' ? [] : (phase.expectedChanges || []);
        const estH = 12 + steps.length * 5 + (expected.length > 0 ? 6 + expected.length * 5 : 0) + 4;
        y = checkY(doc, y, estH);

        // Phase card background
        doc.setFillColor(...C.white);
        doc.setDrawColor(...C.grayBorder);
        doc.setLineWidth(0.3);
        doc.roundedRect(ML, y, CW, estH, 2, 2, 'FD');

        // Left accent bar
        doc.setFillColor(...C.greenDeep);
        doc.rect(ML, y, 3, estH, 'F');

        // Phase number circle
        doc.setFillColor(...C.greenDeep);
        doc.circle(ML + 11, y + 6, 4, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.setTextColor(...C.white);
        doc.text(String(i + 1), ML + 11, y + 7.2, { align: 'center' });

        // Phase title
        const title = typeof phase === 'string' ? phase : (phase.phase || phase.week || '');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(...C.grayDark);
        const titleLines = doc.splitTextToSize(title, CW - 26);
        doc.text(titleLines, ML + 18, y + 5.5);

        let cy = y + 5.5 + titleLines.length * 5;

        // Focus line
        if (typeof phase !== 'string' && phase.focus) {
          doc.setFont('helvetica', 'italic');
          doc.setFontSize(8);
          doc.setTextColor(...C.grayMid);
          const focusLines = doc.splitTextToSize(phase.focus, CW - 22);
          doc.text(focusLines, ML + 18, cy);
          cy += focusLines.length * 4.5;
        }

        // Steps
        if (steps.length > 0) {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8);
          doc.setTextColor(...C.grayDark);
          steps.forEach(step => {
            const sl = doc.splitTextToSize(`• ${step}`, CW - 22);
            doc.text(sl, ML + 18, cy);
            cy += sl.length * 4.5;
          });
        }

        // Expected changes
        if (expected.length > 0) {
          cy += 2;
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(7.5);
          doc.setTextColor(...C.greenDark);
          doc.text('Expected Changes', ML + 18, cy);
          cy += 4.5;
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(22, 101, 52);
          expected.forEach(e => {
            const el = doc.splitTextToSize(`>> ${e}`, CW - 22);
            doc.text(el, ML + 18, cy);
            cy += el.length * 4.5;
          });
        }

        y += estH + 4;
      });
    }
  }

  // ── LIFESTYLE ADVICE ─────────────────────────────────────────────────────
  if (recommendations.lifestyleAdvice?.length > 0) {
    y = checkY(doc, y, 24);
    y = sectionHeading(doc, 'Lifestyle Recommendations', y);

    autoTable(doc, {
      startY: y,
      head: [['Category', 'Advice']],
      body: recommendations.lifestyleAdvice.map(item => [item.category, item.advice]),
      theme: 'striped',
      headStyles: {
        fillColor: C.greenDeep,
        textColor: C.white,
        fontSize: 8.5,
        fontStyle: 'bold',
        cellPadding: { top: 4, bottom: 4, left: 4, right: 4 },
      },
      bodyStyles: {
        fontSize: 8.5,
        cellPadding: { top: 3.5, bottom: 3.5, left: 4, right: 4 },
        textColor: C.grayDark,
        lineColor: C.grayBorder,
        lineWidth: 0.2,
      },
      alternateRowStyles: { fillColor: C.greenLight },
      columnStyles: {
        0: { cellWidth: 36, fontStyle: 'bold', textColor: C.greenDark },
        1: { cellWidth: CW - 36 },
      },
      margin: { left: ML, right: MR },
      tableWidth: CW,
    });
    y = doc.lastAutoTable.finalY + 8;
  }

  // ── MEAL RECOMMENDATIONS ─────────────────────────────────────────────────
  if (recommendations.mealRecommendations?.length > 0) {
    y = checkY(doc, y, 24);
    y = sectionHeading(doc, 'Meal Recommendations', y);

    autoTable(doc, {
      startY: y,
      head: [['Meal', 'Suggestion']],
      body: recommendations.mealRecommendations.map(m => [m.meal, m.suggestion]),
      theme: 'striped',
      headStyles: {
        fillColor: [180, 83, 9],
        textColor: C.white,
        fontSize: 8.5,
        fontStyle: 'bold',
        cellPadding: { top: 4, bottom: 4, left: 4, right: 4 },
      },
      bodyStyles: {
        fontSize: 8.5,
        cellPadding: { top: 3.5, bottom: 3.5, left: 4, right: 4 },
        textColor: C.grayDark,
        lineColor: C.grayBorder,
        lineWidth: 0.2,
      },
      alternateRowStyles: { fillColor: C.amberLight },
      columnStyles: {
        0: { cellWidth: 28, fontStyle: 'bold', textColor: C.amberDark },
        1: { cellWidth: CW - 28 },
      },
      margin: { left: ML, right: MR },
      tableWidth: CW,
    });
    y = doc.lastAutoTable.finalY + 8;
  }

  // ── WARNINGS & AVOID LIST ────────────────────────────────────────────────
  const hasWarnings = recommendations.warnings?.length > 0;
  const hasAvoid    = recommendations.avoidList?.length > 0;

  if (hasWarnings || hasAvoid) {
    y = checkY(doc, y, 24);
    y = sectionHeading(doc, 'Warnings & Supplements to Avoid', y);

    if (hasWarnings) {
      const wLines = recommendations.warnings.map(w => `  •  ${w}`);
      const blockH = 8 + wLines.length * 5.5;
      y = checkY(doc, y, blockH);

      doc.setFillColor(...C.redLight);
      doc.setDrawColor(...C.redBorder);
      doc.setLineWidth(0.3);
      doc.roundedRect(ML, y, CW, blockH, 2, 2, 'FD');
      doc.setFillColor(...C.redMid);
      doc.rect(ML, y, 3, blockH, 'F');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(...C.redMid);
      doc.text('Important Warnings', ML + 6, y + 5.5);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(127, 29, 29);
      let wy = y + 10;
      recommendations.warnings.forEach(w => {
        const wl = doc.splitTextToSize(`• ${w}`, CW - 10);
        doc.text(wl, ML + 6, wy);
        wy += wl.length * 5;
      });
      y += blockH + 5;
    }

    if (hasAvoid) {
      const aLines = recommendations.avoidList.map(a => `• ${a}`);
      const blockH = 8 + aLines.length * 5.5;
      y = checkY(doc, y, blockH);

      doc.setFillColor(255, 247, 237);
      doc.setDrawColor(253, 186, 116);
      doc.setLineWidth(0.3);
      doc.roundedRect(ML, y, CW, blockH, 2, 2, 'FD');
      doc.setFillColor(...C.amberDark);
      doc.rect(ML, y, 3, blockH, 'F');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(...C.amberDark);
      doc.text('Supplements to Avoid', ML + 6, y + 5.5);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(120, 53, 15);
      let ay = y + 10;
      recommendations.avoidList.forEach(a => {
        const al = doc.splitTextToSize(`• ${a}`, CW - 10);
        doc.text(al, ML + 6, ay);
        ay += al.length * 5;
      });
      y += blockH + 5;
    }
  }

  // ── EVIDENCE SOURCES ─────────────────────────────────────────────────────
  y = checkY(doc, y, 20);
  doc.setFillColor(...C.grayLight);
  doc.setDrawColor(...C.grayBorder);
  doc.setLineWidth(0.3);
  doc.roundedRect(ML, y, CW, 14, 2, 2, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(...C.grayMid);
  doc.text('Evidence Sources', ML + 4, y + 5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...C.grayMid);
  doc.text(
    'NIH Office of Dietary Supplements  |  PubMed clinical studies  |  Mayo Clinic guidelines  |  WHO nutrition guidelines  |  Peer-reviewed clinical nutrition research',
    ML + 4, y + 10,
    { maxWidth: CW - 8 }
  );

  // ── FOOTERS ───────────────────────────────────────────────────────────────
  drawFooters(doc, userName);

  // ── SAVE ─────────────────────────────────────────────────────────────────
  const datePart = new Date().toISOString().slice(0, 10);
  const namePart = userName ? `_${userName.replace(/\s+/g, '_')}` : '';
  const filename = `SuppliWise_Report${namePart}_${datePart}.pdf`;
  doc.save(filename);
}
