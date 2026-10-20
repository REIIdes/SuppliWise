'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectLanguage, replyLanguageName, isPhilippineCode, prepare, REPLY_LANGUAGE } = require('../utils/language');

const code = (text) => detectLanguage(text).code;

/**
 * Detection is the input to every other language decision in the app — retrieval
 * anchoring, crisis screening, the reply instruction — so the cases below are the
 * contract, not a wishlist. Each one is a sentence a member of this app's research
 * population could actually send.
 */
test('Filipino and Taglish are read as Filipino', () => {
  assert.equal(code('Hindi ako makapag-hinga po, sobrang sakit ng dibdib ko.'), 'fil');
  assert.equal(code('Pwede po ba akong uminom ng magnesium bago matulog?'), 'fil');
  assert.equal(code('Ang sakit ng tiyan ko, baka may salam ka po ako?'), 'fil');
  assert.equal(code('Kailangan ko po ba kumuha ng blood test bago mag-plan?'), 'fil');
});

test('Taglish code-switching does not fall through to English', () => {
  const d = detectLanguage('Can you remind me to take my vitamin D? Ayoko na kasi noon, pagod na pagod ako.');
  assert.ok(isPhilippineCode(d.code), `expected a Philippine code, got ${d.code}`);
  assert.ok(d.shared > 0.2, 'the English half of the sentence should be visible in the report');
});

test('plain English stays English — the safe default that preserves today', () => {
  for (const text of [
    'I have been feeling very tired lately and my sleep quality is poor.',
    'What dose of vitamin D do you recommend for low energy?',
    'Can I take zinc and magnesium together at night?',
    'Where do I find my previous results and export the PDF?',
    'Does the app have reminders for my morning doses?',
  ]) {
    assert.equal(code(text), 'en', `should stay English: ${text}`);
  }
});

/**
 * A single shared particle is not a language. `ng` is Tagalog's most common word and
 * also a syllable of English text; if one hit could switch the app into Filipino
 * mode, an English member's reply would be answered in a language they did not use.
 */
test('a stray marker cannot outvote English', () => {
  assert.equal(code('Ng the store closed early today.'), 'en');
  assert.equal(code('Quality sleep matters for recovery.'), 'en');
  assert.equal(code('I took my quiz and now my head aching.'), 'en');
});

test('the Philippine sisters are separated by their own grammar, not by shared loanwords', () => {
  assert.equal(code('Dili ko maka katulog ug kasubo kaayo ako nga dughan, unsa man koy mabuhat?'), 'ceb');
  assert.equal(code('Saan pay nakatulog daytoy nga gabi, unay ti panagsakit ti ulo ko.'), 'ilo');
  assert.equal(code('Wala gid ako makakatulog kag sakit gid ang akong ulo.'), 'hil');
  assert.equal(code('Dai ako makahinga, maray na maray an sakong payo.'), 'bik');
  assert.equal(code('Alang yu kwanu king ampu, malagung asuang la yu dere neng mu.'), 'kap');
  assert.equal(code('Nag-anong hitsura ko? Iray sar nan labot so ambot to noyin.'), 'pag');
});

test('when two Philippine languages compete, Filipino wins', () => {
  // A Bisaya speaker mixing in Tagalog particles — the commonest real mixture.
  const mixed = 'Dili ko maka katulog, kasi pagod kaayo ko ug sakit ang bukong.';
  assert.ok(['fil', 'ceb'].includes(code(mixed)));
  assert.equal(code('Wala gid ko makakatulog kag sakit gid kaayo.'), 'hil');
});

test('major world languages are recognised for the reply instruction', () => {
  assert.equal(code('Me duele mucho la cabeza y no puedo dormir, qué medicamento puedo tomar?'), 'es');
  assert.equal(code('Je suis très fatigué et je ne dors pas bien, puis-je prendre du magnesium?'), 'fr');
  assert.equal(code('Estou com dor de cabeça há três dias e não consigo dormir, posso tomar algo?'), 'pt');
  assert.equal(code('Saya tidak bisa tidur dan badan saya lelah sekali, boleh saya minum vitamin?'), 'id');
});

test('script-based languages are decided outright', () => {
  assert.equal(code('مرحبا، كيف حالك؟'), 'ar');
  assert.equal(code('我最近很累，睡不好'), 'zh');
  assert.equal(code('最近よく眠れません'), 'ja');
  assert.equal(code('요즘 잠을 못 자요'), 'ko');
});

test('empty and non-text input degrades to English, never crashes', () => {
  for (const value of [null, undefined, '', '   ', 0, 42, {}, [], true]) {
    const d = detectLanguage(value);
    assert.equal(d.code, 'en');
    assert.equal(d.isEnglish, true);
  }
});

test('very long text is clipped rather than scanned forever', () => {
  const long = `Hindi ako makapag-hinga po, sakit ng dibdib ko. ${'gusto ko po ' .repeat(6000)}`;
  const start = Date.now();
  const d = detectLanguage(long);
  assert.ok(Date.now() - start < 400, 'detection must stay cheap enough to run on every chat turn');
  assert.ok(isPhilippineCode(d.code));
});

test('reply language names only exist for languages the assistant can be told to use', () => {
  assert.equal(replyLanguageName('fil'), 'Filipino (Tagalog)');
  assert.equal(replyLanguageName('fil_taglish'), 'Filipino (Tagalog)');
  assert.equal(replyLanguageName('ceb'), 'Cebuano');
  assert.equal(replyLanguageName('en'), null);
  assert.equal(replyLanguageName('zz'), null);
});

test('prepare folds typographic spaces so markers still match', () => {
  assert.ok(prepare('hindi\u00A0ako\u200Bmakapag-hinga').includes('hindi ako'));
});

test('the stored preference accepts exactly the languages the assistant can reply in', () => {
  // models/User.js writes its enum as a literal so Mongoose validation stays
  // independent of this module at import time — which means the two can drift.
  // Drift there is silent and one-directional: a code the enum lacks is refused
  // by the route, a code the map lacks is stored, then throws no name into the
  // prompt and the member is answered in English after choosing Tagalog.
  const User = require('../models/User');
  const stored = User.schema.path('preferredLanguage').enumValues;
  const canReply = ['', 'en', ...Object.keys(REPLY_LANGUAGE)];
  assert.deepEqual([...stored].sort(), [...canReply].sort());
  for (const code of Object.keys(REPLY_LANGUAGE)) {
    assert.ok(replyLanguageName(code), `${code} is storable but has no prompt name`);
  }
});
