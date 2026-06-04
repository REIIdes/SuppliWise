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
const ML = 16;   // margin left
const MR = 16;   // margin right
const CW = PAGE_W - ML - MR;  // content width = 178mm

// ── Clean text: replace special/unicode chars that jsPDF/helvetica can't render ──
function cleanText(str) {
  if (!str) return str;
  return String(str)
    // Smart quotes → straight quotes
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    // Em dash, en dash → hyphen
    .replace(/[\u2013\u2014]/g, '-')
    // Ellipsis
    .replace(/\u2026/g, '...')
    // Common accented characters → ASCII
    .replace(/[àáâãäå]/gi, 'a')
    .replace(/[èéêë]/gi, 'e')
    .replace(/[ìíîï]/gi, 'i')
    .replace(/[òóôõö]/gi, 'o')
    .replace(/[ùúûü]/gi, 'u')
    .replace(/[ýÿ]/gi, 'y')
    .replace(/[ñ]/gi, 'n')
    .replace(/[ç]/gi, 'c')
    .replace(/[ß]/g, 'ss')
    .replace(/[œ]/gi, 'oe')
    .replace(/[æ]/gi, 'ae')
    // Bullet / special symbols
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
    // Fraction characters
    .replace(/½/g, '1/2')
    .replace(/¼/g, '1/4')
    .replace(/¾/g, '3/4')
    // Strip any remaining non-ASCII
    .replace(/[^\x00-\x7F]/g, '');
}

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
  doc.text(cleanText(key), ML, y);

  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...C.grayDark);
  const lines = doc.splitTextToSize(cleanText(String(value || '')), CW - keyW);
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

// ── Water intake display labels ────────────────────────────────────────────
const WATER_LABELS = {
  'Less than 4 glasses': 'Less than 4 glasses a day',
  '4–6 glasses':         '4–6 glasses a day',
  '7–8 glasses':         '7–8 glasses a day',
  '9+ glasses':          '9 or more glasses a day',
};


const ACTIVITY_LABELS = {
  Sedentary: 'Sedentary / No Exercise',
  Light:     'Light (1–3 days/week)',
  Moderate:  'Moderate (3–5 days/week)',
  Very:      'Very Active (6–7 days/week)',
};

// ── Food expansion (mirrors ResultsPage logic) ─────────────────────────────
const FOOD_SPECIFICS = {
  'fatty fish':       'fatty fish (salmon, tuna, sardines, mackerel)',
  'leafy greens':     'leafy greens (spinach, kale, Swiss chard)',
  'leafy green':      'leafy greens (spinach, kale, Swiss chard)',
  'nuts':             'nuts (almonds, cashews, walnuts, pumpkin seeds)',
  'dairy':            'dairy (Greek yogurt, cheddar cheese, whole milk)',
  'dairy products':   'dairy (Greek yogurt, cheddar cheese, whole milk)',
  'citrus':           'citrus (oranges, grapefruit, kiwi)',
  'citrus fruits':    'citrus (oranges, grapefruit, kiwi)',
  'legumes':          'legumes (lentils, chickpeas, black beans)',
  'whole grains':     'whole grains (oats, brown rice, quinoa)',
  'lean meats':       'lean meats (chicken breast, turkey, lean beef)',
  'lean meat':        'lean meats (chicken breast, turkey, lean beef)',
  'red meat':         'red meat (beef, lamb, bison)',
  'shellfish':        'shellfish (oysters, clams, crab, shrimp)',
  'seeds':            'seeds (pumpkin seeds, sunflower seeds, chia seeds)',
  'berries':          'berries (blueberries, strawberries, raspberries)',
  'cruciferous vegetables': 'cruciferous vegetables (broccoli, Brussels sprouts, cauliflower)',
  'organ meats':      'organ meats (beef liver, chicken liver)',
  'fermented foods':  'fermented foods (kefir, kimchi, sauerkraut, miso)',
};

function expandFoodItem(item) {
  const lower = item.toLowerCase().trim();
  for (const [key, expanded] of Object.entries(FOOD_SPECIFICS)) {
    if (lower === key || lower.startsWith(key + ' ') || lower.endsWith(' ' + key)) {
      return expanded.charAt(0).toUpperCase() + expanded.slice(1);
    }
  }
  return item;
}

function sanitizeFoods(str) {
  if (!str) return str;
  let cleaned = str
    .replace(/,?\s*(such as|which are|are naturally|naturally rich|found in|including)[^,;]*/gi, '')
    .replace(/,?\s*are\s+[a-z].*$/gi, '')
    .trim()
    .replace(/,\s*$/, '');
  return cleaned || str;
}

function splitFoods(str) {
  const items = [];
  let current = '';
  let depth = 0;
  for (const ch of str) {
    if (ch === '(') { depth++; current += ch; }
    else if (ch === ')') { depth--; current += ch; }
    else if ((ch === ',' || ch === ';') && depth === 0) {
      if (current.trim()) items.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function expandFoods(str) {
  if (!str || str === '—') return str;
  const cleaned = sanitizeFoods(str);
  const items = splitFoods(cleaned).map(f => expandFoodItem(f)).filter(Boolean);
  return items.length > 0 ? items.join(', ') : expandFoodItem(cleaned);
}


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

  // Patient name + date/time — same row, same size, same style
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
  const dateTimeStr = `${dateStr}  ${timeStr}`;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(220, 252, 231);
  if (userName) {
    doc.text(`Prepared for: ${userName}`, ML, 38);
    doc.text(dateTimeStr, PAGE_W - MR, 38, { align: 'right' });
  } else {
    doc.text(dateTimeStr, PAGE_W - MR, 38, { align: 'right' });
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
    doc.setFontSize(9.5);
    doc.setTextColor(...C.grayMid);
    const lines = doc.splitTextToSize(cleanText(recommendations.summary), CW);
    doc.text(lines, ML, y, { lineHeightFactor: 1.5 });
    y += lines.length * 5.8 + 8;
  }

  // ── CONSULT DOCTOR ALERT ─────────────────────────────────────────────────
  if (recommendations.consultDoctor && recommendations.consultReason) {
    const rLines = doc.splitTextToSize(cleanText(recommendations.consultReason), CW - 12);
    const blockH = 10 + rLines.length * 5.5 + 6;
    y = checkY(doc, y, blockH);
    doc.setFillColor(...C.redLight);
    doc.setDrawColor(...C.redBorder);
    doc.setLineWidth(0.4);
    doc.roundedRect(ML, y, CW, blockH, 2, 2, 'FD');
    doc.setFillColor(...C.redMid);
    doc.rect(ML, y, 3, blockH, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(...C.redMid);
    doc.text('Medical Consultation Recommended', ML + 7, y + 7);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(127, 29, 29);
    doc.text(rLines, ML + 7, y + 14);
    y += blockH + 8;
  }

  // ── PATIENT PROFILE ──────────────────────────────────────────────────────
  if (assessment) {
    y = checkY(doc, y, 40);
    y = sectionHeading(doc, 'Patient Profile', y);

    // Build rows: each row = [label1, value1, label2, value2]
    const profileFields = [
      userName                  ? ['Name',                   userName,                                                              null,              null]                                                                                    : null,
      (assessment.age || assessment.gender) ? [
        'Age',    assessment.age    ? `${assessment.age} years` : '—',
        'Gender', assessment.gender || '—',
      ] : null,
      (assessment.weight || assessment.height) ? [
        'Weight', assessment.weight ? `${assessment.weight} kg` : '—',
        'Height', assessment.height ? `${assessment.height} cm` : '—',
      ] : null,
      (assessment.weight && assessment.height) ? (() => {
        const bmi = (assessment.weight / ((assessment.height / 100) ** 2)).toFixed(1);
        const cat = bmi < 18.5 ? 'Underweight' : bmi < 25 ? 'Normal weight' : bmi < 30 ? 'Overweight' : 'Obese';
        return ['BMI', `${bmi} (${cat})`, '', ''];
      })() : null,
      (assessment.activityLevel || assessment.dietType) ? [
        'Physical Activity Level', ACTIVITY_LABELS[assessment.activityLevel] || assessment.activityLevel || '—',
        'Diet Type',               assessment.dietType || '—',
      ] : null,
      (assessment.sleepQuality || assessment.waterIntake) ? [
        'Sleep Quality', assessment.sleepQuality || '—',
        'Water Intake',  WATER_LABELS[assessment.waterIntake] || assessment.waterIntake || '—',
      ] : null,
    ].filter(Boolean);

    // Rows where col2 is empty (e.g. Name spans full width)
    const tableBody = profileFields.map(row => {
      if (row[2] === null) {
        // Full-width row — merge visually by putting value in col2 area too
        return [row[0], row[1], '', ''];
      }
      return row;
    });

    autoTable(doc, {
      startY: y,
      body: tableBody,
      theme: 'plain',
      styles: {
        fontSize: 9,
        cellPadding: { top: 4.5, bottom: 4.5, left: 5, right: 5 },
        valign: 'middle',
        lineColor: C.grayBorder,
        lineWidth: 0,
      },
      columnStyles: {
        0: { cellWidth: 46, fontStyle: 'bold', textColor: C.grayMid },
        1: { cellWidth: 49, textColor: C.grayDark },
        2: { cellWidth: 42, fontStyle: 'bold', textColor: C.grayMid },
        3: { cellWidth: 45, textColor: C.grayDark },
      },
      margin: { left: ML, right: MR },
      tableWidth: CW,
      didParseCell(data) {
        if (data.section === 'body') {
          // row 0 = green, row 1 = white, row 2 = green …
          data.cell.styles.fillColor = data.row.index % 2 === 0 ? C.greenLight : C.white;
        }
      },
      didDrawCell(data) {
        if (data.section === 'body' && data.row.index < tableBody.length - 1) {
          doc.setDrawColor(...C.grayBorder);
          doc.setLineWidth(0.2);
          doc.line(
            data.cell.x,
            data.cell.y + data.cell.height,
            data.cell.x + data.cell.width,
            data.cell.y + data.cell.height
          );
        }
      },
    });
    // Track how many rows the profile grid used so the extra table continues the pattern
    const profileRowCount = tableBody.length;
    y = doc.lastAutoTable.finalY + 4;

    // Health goals, Symptoms, Conditions + all other answered optional fields
    const extraRows = [];
    if (assessment.healthGoals?.length > 0) {
      extraRows.push(['Health Goals', assessment.healthGoals.join('  |  ')]);
    }
    const symptoms = (assessment.symptoms || []).filter(s => s !== 'No current symptoms');
    if (symptoms.length > 0) {
      extraRows.push(['Symptoms', symptoms.join('  |  ')]);
    }
    const conditions = (assessment.medicalConditions || []).filter(c => c !== 'None');
    if (conditions.length > 0) {
      extraRows.push(['Conditions', conditions.join('  |  ')]);
    }
    const habits = (assessment.lifestyleHabits || []).filter(h => h !== 'None');
    if (habits.length > 0) {
      extraRows.push(['Lifestyle Habits', habits.join('  |  ')]);
    }
    if (assessment.currentMedications) {
      extraRows.push(['Current Medications', assessment.currentMedications]);
    }
    if (assessment.allergies) {
      extraRows.push(['Allergies', assessment.allergies]);
    }
    if (assessment.takingSupplements) {
      const suppVal = assessment.takingSupplements === 'Yes' && assessment.currentSupplements
        ? `Yes — ${assessment.currentSupplements}`
        : assessment.takingSupplements;
      extraRows.push(['Currently Taking Supplements', suppVal]);
    }
    if (assessment.pregnancyStatus && assessment.pregnancyStatus !== 'Not applicable') {
      extraRows.push(['Pregnancy / Breastfeeding', assessment.pregnancyStatus]);
    }
    if (assessment.sunExposure) {
      extraRows.push(['Daily Sun Exposure', assessment.sunExposure]);
    }
    if (assessment.proteinIntake && assessment.proteinIntake !== 'Not sure') {
      extraRows.push(['Daily Protein Intake', assessment.proteinIntake]);
    }
    if (assessment.fitnessFocus && assessment.fitnessFocus !== 'Not applicable') {
      extraRows.push(['Primary Fitness Focus', assessment.fitnessFocus]);
    }
    if (assessment.recentBloodTest === 'Yes') {
      const bloodVal = assessment.bloodTestResults
        ? `Yes — ${assessment.bloodTestResults}`
        : 'Yes (no results provided)';
      extraRows.push(['Recent Blood Test', bloodVal]);
    }

    if (extraRows.length > 0) {
      y = checkY(doc, y, 10);
      autoTable(doc, {
        startY: y,
        body: extraRows,
        theme: 'plain',
        styles: {
          fontSize: 9,
          cellPadding: { top: 4.5, bottom: 4.5, left: 5, right: 5 },
          valign: 'top',
          lineColor: C.grayBorder,
          lineWidth: 0,
        },
        columnStyles: {
          0: { cellWidth: 46, fontStyle: 'bold', textColor: C.grayMid },
          1: { cellWidth: CW - 46, textColor: C.grayDark },
        },
        margin: { left: ML, right: MR },
        tableWidth: CW,
        didParseCell(data) {
          if (data.section === 'body') {
            // Continue the green-white pattern from the profile grid above
            const globalIndex = profileRowCount + data.row.index;
            data.cell.styles.fillColor = globalIndex % 2 === 0 ? C.greenLight : C.white;
          }
        },
        didDrawCell(data) {
          if (data.section === 'body' && data.row.index < extraRows.length - 1) {
            doc.setDrawColor(...C.grayBorder);
            doc.setLineWidth(0.2);
            doc.line(
              data.cell.x,
              data.cell.y + data.cell.height,
              data.cell.x + data.cell.width,
              data.cell.y + data.cell.height
            );
          }
        },
      });
      y = doc.lastAutoTable.finalY + 4;
    }

    y += 4;
  }

  // Sort recommendations: High → Medium → Low, then by confidenceScore descending
  const PRIORITY_ORDER = { High: 0, Medium: 1, Low: 2 };
  const sortedRecs = [...(recommendations.recommendations || [])].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 3;
    const pb = PRIORITY_ORDER[b.priority] ?? 3;
    if (pa !== pb) return pa - pb;
    return (b.confidenceScore || 0) - (a.confidenceScore || 0);
  });

  // ── SUPPLEMENT RECOMMENDATIONS ───────────────────────────────────────────
  if (recommendations.recommendations?.length > 0) {
    y = checkY(doc, y, 24);
    y = sectionHeading(doc, 'Supplement Recommendations', y);

    // Table 1 — core info
    autoTable(doc, {
      startY: y,
      head: [['Supplement', 'Priority', 'Match', 'Reason', 'Dosage', 'Timing', 'Interactions']],
      body: sortedRecs.map(rec => [
        cleanText(rec.name || ''),
        cleanText(rec.priority || ''),
        rec.confidenceScore ? `${rec.confidenceScore}%` : '-',
        cleanText(rec.reason || ''),
        cleanText(rec.dosage || '-'),
        cleanText(rec.timing || '-'),
        cleanText((rec.interactions && rec.interactions !== 'None identified') ? rec.interactions : 'None'),
      ]),
      theme: 'grid',
      headStyles: {
        fillColor: C.greenDeep,
        textColor: C.white,
        fontSize: 8,
        fontStyle: 'bold',
        cellPadding: { top: 5, bottom: 5, left: 4, right: 4 },
        halign: 'left',
      },
      bodyStyles: {
        fontSize: 8,
        cellPadding: { top: 4, bottom: 4, left: 4, right: 4 },
        textColor: C.grayDark,
        valign: 'top',
        lineColor: C.grayBorder,
        lineWidth: 0.2,
      },
      alternateRowStyles: {
        fillColor: C.greenLight,
      },
      columnStyles: {
        0: { cellWidth: 28, fontStyle: 'bold' },
        1: { cellWidth: 18, halign: 'center' },
        2: { cellWidth: 14, halign: 'center' },
        3: { cellWidth: 52 },
        4: { cellWidth: 28 },
        5: { cellWidth: 20 },
        6: { cellWidth: 18 },
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

    // Table 2 — evidence, food sources, side effects (same sort order as main table)
    const detailRows = sortedRecs.map(rec => [
      cleanText(rec.name || ''),
      cleanText(rec.evidence || '-'),
      cleanText(expandFoods(rec.foods) || '-'),
      cleanText(rec.sideEffects || '-'),
    ]);

    y = checkY(doc, y, 24);
    y = sectionHeading(doc, 'Evidence, Food Sources & Side Effects', y);

    autoTable(doc, {
      startY: y,
      head: [['Supplement', 'Evidence', 'Food Sources', 'Side Effects']],
      body: detailRows,
      theme: 'grid',
      headStyles: {
        fillColor: C.greenDeep,
        textColor: C.white,
        fontSize: 8,
        fontStyle: 'bold',
        cellPadding: { top: 5, bottom: 5, left: 4, right: 4 },
        halign: 'left',
      },
      bodyStyles: {
        fontSize: 8,
        cellPadding: { top: 4, bottom: 4, left: 4, right: 4 },
        textColor: C.grayDark,
        valign: 'top',
        lineColor: C.grayBorder,
        lineWidth: 0.2,
      },
      alternateRowStyles: {
        fillColor: C.greenLight,
      },
      columnStyles: {
        0: { cellWidth: 28, fontStyle: 'bold' },
        1: { cellWidth: 54 },
        2: { cellWidth: 52 },
        3: { cellWidth: 44 },
      },
      margin: { left: ML, right: MR },
      tableWidth: CW,
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
      (sortedRecs || []).forEach(rec => {
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
          cleanText(slot.time),
          (slot.supplements || []).map(s => {
            const d = getDosage(s);
            return d ? `${cleanText(s)} - ${cleanText(d)}` : cleanText(s);
          }).join('\n'),
        ]),
        theme: 'striped',
        headStyles: {
          fillColor: C.greenDeep,
          textColor: C.white,
          fontSize: 9,
          fontStyle: 'bold',
          cellPadding: { top: 5, bottom: 5, left: 5, right: 5 },
        },
        bodyStyles: {
          fontSize: 9,
          cellPadding: { top: 4.5, bottom: 4.5, left: 5, right: 5 },
          textColor: C.grayDark,
          lineColor: C.grayBorder,
          lineWidth: 0.2,
        },
        alternateRowStyles: { fillColor: C.greenLight },
        columnStyles: {
          0: { cellWidth: 44, fontStyle: 'bold', textColor: C.greenDark },
          1: { cellWidth: CW - 44 },
        },
        margin: { left: ML, right: MR },
        tableWidth: CW,
      });
      y = doc.lastAutoTable.finalY + 12;
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
    const lifestyleMinH = 12 + 10 + recommendations.lifestyleAdvice.length * 9;
    y = checkY(doc, y, Math.min(lifestyleMinH, 60));
    y = sectionHeading(doc, 'Lifestyle Recommendations', y);

    autoTable(doc, {
      startY: y,
      head: [['Category', 'Advice']],
      body: recommendations.lifestyleAdvice.map(item => [cleanText(item.category), cleanText(item.advice)]),
      theme: 'striped',
      headStyles: {
        fillColor: C.greenDeep,
        textColor: C.white,
        fontSize: 9,
        fontStyle: 'bold',
        cellPadding: { top: 5, bottom: 5, left: 5, right: 5 },
      },
      bodyStyles: {
        fontSize: 9,
        cellPadding: { top: 4.5, bottom: 4.5, left: 5, right: 5 },
        textColor: C.grayDark,
        lineColor: C.grayBorder,
        lineWidth: 0.2,
      },
      alternateRowStyles: { fillColor: C.greenLight },
      columnStyles: {
        0: { cellWidth: 38, fontStyle: 'bold', textColor: C.greenDark },
        1: { cellWidth: CW - 38 },
      },
      margin: { left: ML, right: MR },
      tableWidth: CW,
    });
    y = doc.lastAutoTable.finalY + 10;
  }

  // ── MEAL RECOMMENDATIONS ─────────────────────────────────────────────────
  if (recommendations.mealRecommendations?.length > 0) {
    // Estimate minimum height: section heading (~12) + table header (~10) + at least one row (~9)
    const mealMinH = 12 + 10 + recommendations.mealRecommendations.length * 9;
    y = checkY(doc, y, Math.min(mealMinH, 60));
    y = sectionHeading(doc, 'Meal Recommendations', y);

    autoTable(doc, {
      startY: y,
      head: [['Meal', 'Suggestion']],
      body: recommendations.mealRecommendations.map(m => [cleanText(m.meal), cleanText(m.suggestion)]),
      theme: 'striped',
      headStyles: {
        fillColor: [180, 83, 9],
        textColor: C.white,
        fontSize: 9,
        fontStyle: 'bold',
        cellPadding: { top: 5, bottom: 5, left: 5, right: 5 },
      },
      bodyStyles: {
        fontSize: 9,
        cellPadding: { top: 4.5, bottom: 4.5, left: 5, right: 5 },
        textColor: C.grayDark,
        lineColor: C.grayBorder,
        lineWidth: 0.2,
      },
      alternateRowStyles: { fillColor: C.amberLight },
      columnStyles: {
        0: { cellWidth: 30, fontStyle: 'bold', textColor: C.amberDark },
        1: { cellWidth: CW - 30 },
      },
      margin: { left: ML, right: MR },
      tableWidth: CW,
    });
    y = doc.lastAutoTable.finalY + 10;
  }

  // ── WARNINGS & AVOID LIST ────────────────────────────────────────────────
  const hasWarnings = recommendations.warnings?.length > 0;
  const hasAvoid    = recommendations.avoidList?.length > 0;

  if (hasWarnings || hasAvoid) {
    y = checkY(doc, y, 28);
    y = sectionHeading(doc, 'Warnings & Supplements to Avoid', y);

    if (hasWarnings) {
      const wTextLines = recommendations.warnings.flatMap(w =>
        doc.splitTextToSize(cleanText(`• ${w}`), CW - 16)
      );
      const blockH = 12 + wTextLines.length * 6 + 8;
      y = checkY(doc, y, blockH);

      doc.setFillColor(...C.redLight);
      doc.setDrawColor(...C.redBorder);
      doc.setLineWidth(0.3);
      doc.roundedRect(ML, y, CW, blockH, 3, 3, 'FD');
      doc.setFillColor(...C.redMid);
      doc.rect(ML, y, 4, blockH, 'F');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(...C.redMid);
      doc.text('Important Warnings', ML + 9, y + 8.5);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(127, 29, 29);
      let wy = y + 17;
      recommendations.warnings.forEach(w => {
        const wl = doc.splitTextToSize(`• ${w}`, CW - 16);
        doc.text(wl, ML + 9, wy);
        wy += wl.length * 6;
      });
      y += blockH + 8;
    }

    if (hasAvoid) {
      const aTextLines = recommendations.avoidList.flatMap(a =>
        doc.splitTextToSize(cleanText(`• ${a}`), CW - 16)
      );
      const blockH = 12 + aTextLines.length * 6 + 8;
      y = checkY(doc, y, blockH);

      doc.setFillColor(255, 247, 237);
      doc.setDrawColor(253, 186, 116);
      doc.setLineWidth(0.3);
      doc.roundedRect(ML, y, CW, blockH, 3, 3, 'FD');
      doc.setFillColor(...C.amberDark);
      doc.rect(ML, y, 4, blockH, 'F');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(...C.amberDark);
      doc.text('Supplements to Avoid', ML + 9, y + 8.5);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(120, 53, 15);
      let ay = y + 17;
      recommendations.avoidList.forEach(a => {
        const al = doc.splitTextToSize(`• ${a}`, CW - 16);
        doc.text(al, ML + 9, ay);
        ay += al.length * 6;
      });
      y += blockH + 8;
    }
  }

  // ── SEEKING SUPPORT ───────────────────────────────────────────────────────
  const ss = recommendations.seekingSupport;
  if (ss?.include) {
    y = checkY(doc, y, 32);
    y = sectionHeading(doc, 'Seeking Support', y);

    const introLines = doc.splitTextToSize(cleanText(ss.intro || ''), CW - 16);
    const introH = 12 + introLines.length * 6 + 8;
    y = checkY(doc, y, introH);

    doc.setFillColor(...C.blueLight);
    doc.setDrawColor(...C.blueBorder);
    doc.setLineWidth(0.3);
    doc.roundedRect(ML, y, CW, introH, 3, 3, 'FD');
    doc.setFillColor(...C.blueDark);
    doc.rect(ML, y, 4, introH, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(...C.blueDark);
    doc.text('Important Notice', ML + 9, y + 8.5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(30, 58, 138);
    let iy = y + 17;
    introLines.forEach(line => { doc.text(line, ML + 9, iy); iy += 6; });
    y += introH + 7;

    if (ss.resources?.length > 0) {
      y = checkY(doc, y, 16);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(...C.blueDark);
      doc.text('Philippine Support Resources:', ML, y);
      y += 8;

      ss.resources.forEach(res => {
        const nameLines = doc.splitTextToSize(cleanText(`${res.label}: ${res.name}`), CW - 8);
        const descLines = doc.splitTextToSize(cleanText(`   ${res.description}`), CW - 12);
        const urlLines  = doc.splitTextToSize(cleanText(`   ${res.url}`), CW - 12);
        const rH = (nameLines.length + descLines.length + urlLines.length) * 5.8 + 10;
        y = checkY(doc, y, rH);

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.5);
        doc.setTextColor(...C.blueDark);
        doc.text(nameLines, ML + 4, y);
        y += nameLines.length * 5.8;

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(71, 85, 105);
        doc.text(descLines, ML + 4, y);
        y += descLines.length * 5.5;

        doc.setTextColor(...C.blueDark);
        doc.text(urlLines, ML + 4, y);
        y += urlLines.length * 5.5 + 5;
      });
    }
    y += 6;
  }

  // ── EVIDENCE SOURCES ─────────────────────────────────────────────────────
  y = checkY(doc, y, 22);
  doc.setFillColor(...C.grayLight);
  doc.setDrawColor(...C.grayBorder);
  doc.setLineWidth(0.3);
  doc.roundedRect(ML, y, CW, 18, 2, 2, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...C.grayMid);
  doc.text('Evidence Sources', ML + 5, y + 6.5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(...C.grayMid);
  doc.text(
    'NIH Office of Dietary Supplements  |  PubMed clinical studies  |  Mayo Clinic guidelines  |  WHO nutrition guidelines  |  Peer-reviewed clinical nutrition research',
    ML + 5, y + 13,
    { maxWidth: CW - 10 }
  );

  // ── FOOTERS ───────────────────────────────────────────────────────────────
  drawFooters(doc, userName);

  // ── SAVE ─────────────────────────────────────────────────────────────────
  const datePart = now.toISOString().slice(0, 10);
  const timePart = now.toTimeString().slice(0, 8).replace(/:/g, '-');
  const namePart = userName ? `_${userName.replace(/\s+/g, '_')}` : '';
  const filename = `SuppliWise_Report${namePart}_${datePart}_${timePart}.pdf`;
  doc.save(filename);
}
