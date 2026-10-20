/**
 * The plan engine reads what a member typed, so it has to read it in their language.
 *
 * Run: node --test "Test File/plan-language-parity.test.js"
 *
 * WHY THIS FILE EXISTS
 * `routes/recommend.js` parses `feelingDescription` with English regexes — /back\s*pain/,
 * /headache|migraine/, /suicid/ — and a member who writes "sumasakit ang likod ko" is
 * answering the same question and used to get a different plan: no Magnesium, no
 * Curcumin, and for the crisis sentence no consult-doctor flag.
 * utils/languageAnchors.js is the bridge; this file is the proof the bridge is wired
 * into the engine, because anchoring a text check somewhere else in the app is worth
 * nothing at the call site that forgot to import it.
 *
 * WHAT "PARITY" MEANS HERE
 * The expectation per complaint is a named supplement the engine only ever adds from
 * that one branch, and the Filipino sentence must produce it as reliably as the English
 * one does. It is deliberately not "the two plans must be identical": a Tagalog phrase
 * like `sakit ng mga kasuka` is legitimately vaguer than "my knees hurt when I climb
 * stairs", and forcing byte-identical plans would have meant editing the anchor table
 * until it stopped telling the truth about what the member said.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { generateClinicalFallback } = require('../routes/recommend');

// A member who answered nothing but the free-text box. The engine tolerates it — that is
// what the incomplete-profile note in the summary is for — and it is the shape that
// isolates the free-text parser from every other input.
const BLANK = {
  age: '30',
  gender: 'Female',
  symptoms: [],
  medicalConditions: [],
  healthGoals: [],
  lifestyleHabits: [],
  dietType: 'None',
  allergies: '',
  currentMedications: '',
  recentBloodTest: '',
  sleepQuality: 'Good',
  stressLevel: 'Low',
  activityLevel: 'Moderate',
  waterIntake: '2L',
  proteinIntake: 'Moderate',
};

const plan = (feelingDescription) => {
  const out = generateClinicalFallback({ ...BLANK, feelingDescription });
  return {
    recs: (out.recommendations || []).map((r) => r.name),
    consult: out.consultDoctor === true,
  };
};

// `only` is what makes this a parity test rather than a smoke test: the named
// supplement is added by exactly one branch of the parser, so its presence proves the
// Filipino sentence reached that branch and its absence proves it did not.
const CASES = [
  { id: 'back', en: 'I have lower back pain', tl: 'sumasakit ang likod ko', only: ['Curcumin + Piperine'] },
  { id: 'headache', en: 'I get a headache every morning', tl: 'araw-araw sumasakit ang ulo ko', only: ['Riboflavin (Vitamin B2)'] },
  { id: 'knee', en: 'I have knee pain when I climb stairs', tl: 'sakit ng tuhod ko pag-akyat ng hagdan', only: ['Glucosamine Sulfate + Chondroitin'] },
  { id: 'reflux', en: 'my stomach burns after eating', tl: 'nasusunog ang tiyan ko pagkatapos kumain', only: ['Probiotic (Multi-strain, 50B CFU)'] },
  { id: 'tiredness', en: 'I am exhausted and cannot sleep at night', tl: 'pagod na pagod ako at hirap akong matulog', only: ['Vitamin B12 (Methylcobalamin)'] },
];

for (const c of CASES) {
  test(`${c.id}: the Tagalog sentence reaches the branch the English one reaches`, () => {
    const en = plan(c.en);
    const tl = plan(c.tl);
    for (const name of c.only) {
      assert.ok(en.recs.includes(name), `the English plan does not even add ${name} — this case measures nothing: ${en.recs.join(', ')}`);
      assert.ok(tl.recs.includes(name), `"${c.tl}" lost ${name} that "${c.en}" got: ${tl.recs.join(', ') || 'no recommendations'}`);
    }
  });
}

test('the crisis sentence is flagged whatever language it is written in', () => {
  // The one case here that is not a nicety. `consultDoctor` is how a member in danger
  // is told to stop reading a supplement plan and go to a person.
  const CRISIS = [
    'I feel like I want to die',
    'gusto ko na lang mamatay',
    'ayaw ko na mabuhay',
    'I want to harm myself',
  ];
  for (const text of CRISIS) {
    assert.equal(plan(text).consult, true, `"${text}" did not reach the consult-doctor flag`);
  }
});

test('a description that says nothing gets the plan that says nothing', () => {
  // Anchoring runs before every rule in the parser, so a garbage or empty box must
  // still produce the generic plan and must never raise a crisis flag. The Tagalog
  // entries are the honest non-answers a member types: "wala pa" is "not yet".
  const baseline = plan('');
  assert.equal(baseline.consult, false);
  for (const junk of ['   ', 'aaaaaaaa', '???', '123', 'n/a', 'wala pa', 'ayan lang', 'ok lang']) {
    const out = plan(junk);
    assert.equal(out.consult, false, `"${junk}" invented a crisis flag`);
    assert.deepEqual(out.recs, baseline.recs, `"${junk}" added a supplement nobody asked for`);
  }
});

test('the engine anchors its free-text rules at every site that reads them', () => {
  // A source assertion, because the bug this guards against is a new rule added below
  // the anchored line: correct English, deaf to Tagalog, and invisible to a behaviour
  // test that only exercises the branches that were wired.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'routes', 'recommend.js'), 'utf8');
  const sites = src.match(/const fd = (?:anchorText\(|)/g) || [];
  assert.ok(sites.length >= 2, 'the parser and the consult-doctor triggers must both read anchored text');
  assert.equal(
    sites.filter((s) => !s.includes('anchorText(')).length,
    0,
    'a `const fd =` site reads the raw description, so its rules cannot see Tagalog',
  );
});
