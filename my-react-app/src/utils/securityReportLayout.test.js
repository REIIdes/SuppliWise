/**
 * Geometry of the administrator security report's own building blocks.
 *
 * Run: npm test
 *
 * The wellness report gets its measurements from `drawMeasuredTextCard`; this
 * file holds the security report to the same rule.  Every assertion is computed
 * from jsPDF's real font metrics on a real A4 page, because these cards used to
 * size themselves from `lines * 4.5` — a hand-typed leading that was both a
 * whitespace generator for short text and an overlap generator for long text.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import jsPDFModule from 'jspdf';
import { REPORT_LAYOUT as L, measureParagraph } from './reportTheme.js';
import {
  drawFindingCard,
  drawKpi,
  drawMetaCell,
  drawRecommendationCard,
} from './securityReport.js';

const JsPDF = jsPDFModule?.jsPDF || jsPDFModule?.default || jsPDFModule;

function recordDraws(doc) {
  const calls = [];
  const wrap = (name, pick) => {
    const original = doc[name];
    doc[name] = (...args) => {
      calls.push({ name, ...pick(args) });
      return original.apply(doc, args);
    };
  };
  wrap('roundedRect', ([x, y, w, h]) => ({ x, y, w, h }));
  wrap('text', ([value, x, y]) => ({
    x,
    y,
    text: Array.isArray(value) ? value.join(' ') : String(value),
  }));
  return calls;
}

/** The report's own page-break rule, kept identical to securityReport's. */
function makeEnsureSpace(getY, setY) {
  return (needed) => {
    const amount = Number.isFinite(Number(needed)) ? Number(needed) : 18;
    let y = getY();
    if (!Number.isFinite(y) || y < 0) y = L.continuationContentTop;
    if (y + amount > L.pageHeight - L.footerHeight - 4) y = L.continuationContentTop;
    setY(y);
    return y;
  };
}

const printableBottom = L.pageHeight - L.footerHeight;

const longDetail = 'A revoked token still reaches the share route because the middleware '
  .repeat(12);

test('a short finding draws a tight box, and its text is inside that box', () => {
  const doc = new JsPDF({ unit: 'mm', format: 'a4' });
  const calls = recordDraws(doc);
  let y = L.firstContentTop;
  const ensure = makeEnsureSpace(() => y, (value) => { y = value; });

  const returned = drawFindingCard(doc, {
    title: 'Key rotation', severity: 'High', detail: 'Rotate the signing key.',
  }, y, [22, 163, 74], ensure);

  const box = calls.filter((call) => call.name === 'roundedRect' && Math.abs(call.w - L.contentWidth) < 0.6).pop();
  assert.ok(box, 'the finding card did not draw a full-width box');
  const title = measureParagraph(doc, 'Key rotation', { maxWidth: L.contentWidth - 13, fontSize: 8.5, fontStyle: 'bold' });
  const detail = measureParagraph(doc, 'Rotate the signing key.', { maxWidth: L.contentWidth - 13, fontSize: 7.8 });
  const expected = 3 + title.height + 1.2 + detail.height + 3;
  assert.ok(Math.abs(box.h - expected) < 0.001, `box ${box.h} vs measured ${expected}`);

  const texts = calls.filter((call) => call.name === 'text');
  assert.equal(texts.length, 2, 'a two-part finding draws exactly two lines');
  for (const line of texts) {
    assert.ok(line.y > box.y && line.y < box.y + box.h, `"${line.text}" sits outside its own card`);
  }
  assert.ok(Math.abs(returned - (box.y + box.h + 3)) < 0.001, 'the cursor must leave exactly the card gap');
});

test('a long finding grows its own box instead of printing past it', () => {
  const doc = new JsPDF({ unit: 'mm', format: 'a4' });
  const calls = recordDraws(doc);
  let y = L.firstContentTop;
  const ensure = makeEnsureSpace(() => y, (value) => { y = value; });

  drawFindingCard(doc, { title: 'Session revocation', detail: longDetail }, y, [22, 163, 74], ensure);

  const box = calls.filter((call) => call.name === 'roundedRect' && Math.abs(call.w - L.contentWidth) < 0.6).pop();
  const body = measureParagraph(doc, longDetail, { maxWidth: L.contentWidth - 13, fontSize: 7.8 });
  assert.ok(body.lines.length > 6, 'this fixture is meant to wrap onto many lines');
  assert.ok(box.h > body.height, 'the box must grow with the copy it holds');
  const texts = calls.filter((call) => call.name === 'text');
  assert.equal(texts.length, 1 + body.lines.length);
  for (const line of texts) {
    assert.ok(line.y <= box.y + box.h, `"${line.text.slice(0, 32)}" runs past the bottom border`);
    assert.ok(line.y >= box.y, 'text was drawn above its own card');
  }
});

test('stacked finding cards never overlap the card before them', () => {
  const doc = new JsPDF({ unit: 'mm', format: 'a4' });
  const calls = recordDraws(doc);
  let y = L.firstContentTop;
  const ensure = makeEnsureSpace(() => y, (value) => { y = value; });

  const items = [
    { title: 'First', detail: 'Short note.' },
    { title: 'Second', detail: longDetail },
    { title: 'Third', detail: 'Another short note.' },
  ];
  for (const item of items) y = drawFindingCard(doc, item, y, [22, 163, 74], ensure);

  const boxes = calls.filter((call) => call.name === 'roundedRect' && Math.abs(call.w - L.contentWidth) < 0.6);
  assert.equal(boxes.length, 3, 'each card draws exactly one body box');
  for (let index = 1; index < boxes.length; index += 1) {
    const previous = boxes[index - 1];
    assert.ok(boxes[index].y >= previous.y + previous.h, `card ${index + 1} is printed on top of card ${index}`);
    assert.ok(boxes[index].y - (previous.y + previous.h) <= 3.001, 'the gap between cards drifted past the card gap');
  }
});

test('a recommendation card keeps its text clear of the priority pill', () => {
  const doc = new JsPDF({ unit: 'mm', format: 'a4' });
  const calls = recordDraws(doc);
  let y = L.firstContentTop;
  const ensure = makeEnsureSpace(() => y, (value) => { y = value; });

  y = drawRecommendationCard(doc, {
    title: 'Tighten the session revocation check',
    priority: 'High',
    description: longDetail,
  }, 0, y, ensure);

  const box = calls.filter((call) => call.name === 'roundedRect' && Math.abs(call.w - L.contentWidth) < 0.6)[0];
  const pill = calls.filter((call) => call.name === 'roundedRect' && Math.abs(call.w - 24) < 0.5)[0];
  assert.ok(pill, 'the priority pill was not drawn');
  const title = calls.find((call) => call.name === 'text' && call.text.startsWith('Tighten'));
  assert.ok(title.x >= pill.x + pill.w || title.y <= pill.y, 'the title collides with the pill');
  const body = measureParagraph(doc, longDetail, { maxWidth: L.contentWidth - 13, fontSize: 7.8 });
  const bodyLines = calls.filter((call) => call.name === 'text' && call.x === L.margin + 8 && call !== title);
  assert.equal(bodyLines.length, body.lines.length);
  for (const line of bodyLines) {
    assert.ok(line.y > pill.y + pill.h, `"${line.text.slice(0, 24)}" prints over the priority pill`);
    assert.ok(line.y <= box.y + box.h, `"${line.text.slice(0, 24)}" runs past the bottom border`);
  }
});

test('a meta cell returns the height its wrapped value actually needs', () => {
  const doc = new JsPDF({ unit: 'mm', format: 'a4' });
  const calls = recordDraws(doc);
  const value = '18 (14 secure, 3 vulnerable, 1 critical) '.repeat(5);

  const height = drawMetaCell(doc, L.margin, L.firstContentTop, 82, 'Controls', value, [22, 163, 74]);

  const lines = calls.filter((call) => call.name === 'text');
  const expected = measureParagraph(doc, value, { maxWidth: 82, fontSize: 8.5 });
  assert.ok(expected.lines.length > 2, 'this fixture is meant to wrap');
  assert.ok(height >= expected.lines.length * expected.lineHeight, 'the returned height is smaller than the value it drew');
  const last = lines[lines.length - 1];
  assert.ok(last.y <= L.firstContentTop + height, 'the value ran below the height reported to the caller');
  const first = lines[0];
  assert.ok(first.y < last.y, 'the label sits below its own value');
});

test('KPI text stays inside the box at both heights the report uses', () => {
  const doc = new JsPDF({ unit: 'mm', format: 'a4' });
  for (const height of [25, 21]) {
    const calls = recordDraws(doc);
    drawKpi(doc, L.margin, L.firstContentTop, 42, height, 1234567890, 'Remediated findings count', [22, 163, 74], [255, 255, 255]);
    const box = calls.find((call) => call.name === 'roundedRect');
    const texts = calls.filter((call) => call.name === 'text');
    assert.equal(texts.length, 2);
    for (const line of texts) {
      assert.ok(line.y > box.y && line.y < box.y + box.h, `a ${height} mm KPI draws "${line.text}" outside its box`);
    }
  }
});

test('no box in the security report is left sitting under the footer', () => {
  const doc = new JsPDF({ unit: 'mm', format: 'a4' });
  let y = L.firstContentTop;
  const ensure = makeEnsureSpace(() => y, (value) => { y = value; });
  for (let index = 0; index < 40; index += 1) {
    y = drawFindingCard(doc, { title: `Finding ${index}`, detail: longDetail }, y, [22, 163, 74], ensure);
    assert.ok(y <= printableBottom, `the cursor escaped the printable band at card ${index}`);
  }
});
