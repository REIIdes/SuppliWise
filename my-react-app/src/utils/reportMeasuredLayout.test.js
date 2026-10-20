/**
 * PDF layout geometry.
 *
 * Run: npm test
 *
 * The requirement these tests hold: text must never overlap other text, never
 * run past the printable area, and a long description must grow the page count
 * rather than overflow its own box.  Everything asserted here is measured from
 * jsPDF's real font metrics on a real A4 document — no expected pixel values
 * were typed by hand, because a hand-typed number is exactly the kind of guess
 * that produced overlapping cards before.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import jsPDFModule from 'jspdf';
import {
  REPORT_COLORS as C,
  REPORT_LAYOUT as L,
  drawMeasuredTextCard,
  drawParagraph,
  drawReportHeader,
  measureParagraph,
} from './reportTheme.js';

const JsPDF = jsPDFModule?.jsPDF || jsPDFModule?.default || jsPDFModule;

/**
 * Record every rectangle and text baseline a document draws, per page.
 * jsPDF attaches its API per instance, so the methods are wrapped on the
 * document this test created.
 */
function recordDraws(doc) {
  const calls = [];
  const wrap = (name, pick) => {
    const original = doc[name];
    doc[name] = (...args) => {
      calls.push({ name, page: doc.getCurrentPageInfo().pageNumber, ...pick(args) });
      return original.apply(doc, args);
    };
  };
  wrap('roundedRect', ([x, y, w, h]) => ({ x, y, w, h }));
  wrap('rect', ([x, y, w, h]) => ({ x, y, w, h }));
  wrap('text', ([value, x, y, options]) => ({
    x,
    y,
    options: options || {},
    text: Array.isArray(value) ? value.join(' ') : String(value),
  }));
  return calls;
}

/** The renderer's own page-break rule, kept identical to wellnessReport's. */
function makeEnsureSpace(doc, getY, setY) {
  return (needed, at) => {
    const amount = Number.isFinite(Number(needed)) ? Number(needed) : 18;
    let y = Number.isFinite(Number(at)) ? Number(at) : getY();
    if (!Number.isFinite(y) || y < 0) {
      doc.addPage();
      y = L.continuationContentTop;
    }
    if (y + amount > L.pageHeight - L.footerHeight - 4) {
      doc.addPage();
      y = L.continuationContentTop;
    }
    setY(y);
    return y;
  };
}

const printableBottom = L.pageHeight - L.footerHeight;

test('measureParagraph wraps inside the width it is given', () => {
  const doc = new JsPDF({ unit: 'mm', format: 'a4' });
  const text = 'Magnesium supports nerve signalling and muscle relaxation, and the evidence for it is reviewed in the NIH fact sheet on magnesium. '.repeat(6);
  const box = measureParagraph(doc, text, { maxWidth: 160, fontSize: 8.5 });
  assert.ok(box.lines.length > 3, 'the paragraph should wrap onto several lines');
  for (const line of box.lines) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    assert.ok(doc.getTextDimensions([line], { fontSize: 8.5 }).w <= 160.01, `line too wide: ${line}`);
  }
  assert.equal(box.height, box.lines.length * box.lineHeight);
  assert.ok(box.em > 2 && box.em < 4, `one em of 8.5pt helvetica in mm should be ~2.9, got ${box.em}`);
});

test('an empty paragraph measures to nothing instead of a phantom box', () => {
  const doc = new JsPDF({ unit: 'mm', format: 'a4' });
  const box = measureParagraph(doc, '   ', { maxWidth: 100, fontSize: 8.5 });
  assert.deepEqual(box.lines, []);
  assert.equal(box.height, 0);
});

test('drawParagraph advances by exactly the height it measured', () => {
  const doc = new JsPDF({ unit: 'mm', format: 'a4' });
  const box = measureParagraph(doc, 'one two three four five six seven eight nine ten'.repeat(8), { maxWidth: 120, fontSize: 8.5 });
  const calls = recordDraws(doc);
  const bottom = drawParagraph(doc, box, 20, 100);
  const drawn = calls.filter((call) => call.name === 'text');
  assert.equal(drawn.length, box.lines.length);
  assert.ok(Math.abs(bottom - (100 + box.lines.length * box.lineHeight)) < 0.001);
  drawn.forEach((call, index) => {
    assert.ok(Math.abs(call.y - (100 + box.em * 0.82 + index * box.lineHeight)) < 0.001, `line ${index} baseline drifted`);
  });
});

test('a two-page paragraph splits into boxes that neither overlap nor leave the page', () => {
  const doc = new JsPDF({ unit: 'mm', format: 'a4', compress: true });
  let y = L.firstContentTop;
  const calls = recordDraws(doc);
  const ensureSpace = makeEnsureSpace(doc, () => y, (value) => { y = value; });
  const long = 'The recommendation is grounded in the clinical nutrition references this app curates. '.repeat(90);
  const returned = drawMeasuredTextCard(doc, {
    y,
    ensureSpace,
    label: 'Clinical summary',
    text: long,
    fontSize: 8.5,
    accent: C.emerald,
    fill: C.emeraldLight,
  });

  const boxes = calls.filter((call) => call.name === 'roundedRect' && Math.abs(call.w - L.contentWidth) < 0.6);
  assert.ok(boxes.length >= 2, `expected the paragraph to split across pages, got ${boxes.length} box(es)`);
  // Each fragment fills the room left on its page, so no fragment can start
  // above another: one box per page.
  assert.equal(doc.internal.getNumberOfPages(), boxes.length);

  const sorted = [...boxes].sort((a, b) => a.page - b.page || a.y - b.y);
  for (const box of sorted) {
    assert.ok(box.y >= 0 && box.y + box.h <= printableBottom + 0.6, `box leaves the printable area: ${box.y} + ${box.h}`);
    assert.ok(box.x >= L.margin - 0.6 && box.x + box.w <= L.pageWidth - L.margin + 0.6);
  }
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].page !== sorted[index - 1].page) continue;
    assert.ok(sorted[index].y >= sorted[index - 1].y + sorted[index - 1].h - 0.6, 'two cards printed on top of each other');
  }

  const labelCount = calls.filter((call) => call.name === 'text' && call.text.startsWith('CLINICAL SUMMARY')).length;
  assert.equal(labelCount, 1, 'the section label must not repeat on the continuation fragment');

  // The property the old renderer broke: every baseline must sit inside a card.
  // Text drawn between two boxes is text printed over a border.
  for (const line of calls.filter((call) => call.name === 'text')) {
    const holder = sorted.find((box) => box.page === line.page && line.y >= box.y && line.y <= box.y + box.h);
    assert.ok(holder, `line at y=${line.y} on page ${line.page} sits outside every card`);
  }

  assert.ok(returned > sorted[sorted.length - 1].y, 'the cursor must land below the last box it drew');
});

test('a short description still draws one correctly sized box', () => {
  const doc = new JsPDF({ unit: 'mm', format: 'a4', compress: true });
  let y = L.firstContentTop;
  const calls = recordDraws(doc);
  const ensureSpace = makeEnsureSpace(doc, () => y, (value) => { y = value; });
  drawMeasuredTextCard(doc, { y, ensureSpace, label: 'Summary', text: 'Sleep quality improved.', fontSize: 9 });

  const boxes = calls.filter((call) => call.name === 'roundedRect' && Math.abs(call.w - L.contentWidth) < 0.6);
  assert.equal(boxes.length, 1);
  assert.equal(doc.internal.getNumberOfPages(), 1);
  const body = measureParagraph(doc, 'Sleep quality improved.', { maxWidth: L.contentWidth - 16.5, fontSize: 9 });
  const label = measureParagraph(doc, 'SUMMARY', { maxWidth: L.contentWidth - 16.5, fontSize: 7.3, fontStyle: 'bold' });
  const expected = 4 + label.height + 2.5 + body.lines.length * body.lineHeight + 4;
  assert.ok(Math.abs(boxes[0].h - expected) < 0.001, `box ${boxes[0].h} vs measured ${expected}`);
  const firstText = calls.find((call) => call.name === 'text');
  assert.ok(firstText.y > boxes[0].y && firstText.y < boxes[0].y + boxes[0].h, 'text drawn outside its own card');
});

test('the report header cannot print the member name under the metadata card', () => {
  const doc = new JsPDF({ unit: 'mm', format: 'a4' });
  const calls = recordDraws(doc);
  // A deliberately absurd identity to prove the bound is enforced by layout,
  // not by hoping the name is short.
  drawReportHeader(doc, {
    preparedFor: 'Mary Josephine Fernandez-Villanueva-Santhiago de los Reyes'.repeat(3),
    dateLabel: `Assessment: ${'October 20, 2026'.repeat(4)}`,
    badge: 'Wellness report',
  });
  const cardLeft = doc.internal.pageSize.getWidth() - 66;
  // Only the left-hand identity column is drawn at x = 15; the metadata card's
  // own labels sit to its right and are not what this checks.
  const identityLines = calls.filter((call) => call.name === 'text' && call.x < 20 && call.y > 25 && call.y < 55);
  assert.equal(identityLines.length, 3, 'subtitle, prepared-for and assessment date should all be bounded');
  for (const line of identityLines) {
    assert.ok(line.options.maxWidth, `"${line.text.slice(0, 24)}" was drawn with no width bound`);
    // jsPDF shrinks text to `maxWidth`, so the bound itself is the guarantee
    // that the drawn line stops before the metadata card begins.
    assert.ok(line.x + line.options.maxWidth <= cardLeft + 0.6, `bound runs under the card: ${line.text.slice(0, 24)}`);
  }
});

test('the full report lays out identically for the same stored plan and paginates when the text grows', async () => {
  const { downloadWellnessReport } = await import('./wellnessReport.js');
  const assessment = { createdAt: '2026-10-20T00:00:00.000Z', userName: 'Test Person', age: 34, healthGoals: ['Energy'] };
  const row = (reason) => ({
    name: 'Magnesium Glycinate',
    priority: 'High',
    confidenceScore: 84,
    reason,
    dosage: '200 mg at night',
    timing: 'Evening, with food',
    evidence: 'NIH ODS magnesium fact sheet.',
    foods: ['spinach', 'pumpkin seeds'],
    sideEffects: 'Loose stools if taken too early',
  });
  const shortPlan = { recommendations: [row('Short rationale.'), row('Also short.')], summary: 'Short summary.' };
  const longRationale = 'Magnesium plays a central role in nerve signalling and muscle relaxation, and this plan reflects what the member reported. '.repeat(30);
  const longPlan = { recommendations: [row(longRationale), row(longRationale)], summary: longRationale, warnings: ['Discuss it with your clinician.'] };

  const shortOnce = await downloadWellnessReport({ save: false, results: shortPlan, assessment });
  const shortTwice = await downloadWellnessReport({ save: false, results: shortPlan, assessment });
  assert.equal(shortOnce.pageCount, shortTwice.pageCount, 'the same stored plan must lay out identically');
  assert.equal(shortOnce.filename, shortTwice.filename, 'the same stored plan must produce the same file name');

  const longRun = await downloadWellnessReport({ save: false, results: longPlan, assessment });
  assert.ok(longRun.pageCount > shortOnce.pageCount, 'a much longer description must add pages, not overflow boxes');
});

test('the last-resort renderer still produces a readable multi-page report for a malformed row', async () => {
  const { downloadWellnessFallback } = await import('./wellnessReport.js');
  const result = await downloadWellnessFallback({
    save: false,
    assessment: { createdAt: '2026-10-20T00:00:00.000Z', userName: 'Test Person' },
    results: {
      recommendations: [null, { name: '' }, { dosage: 42 }],
      summary: 'x'.repeat(4000),
      warnings: ['a', '', null],
    },
  });
  assert.ok(result.pageCount >= 2, `expected the oversized summary to paginate, got ${result.pageCount} page(s)`);
  assert.equal(result.fallback, true);
});
