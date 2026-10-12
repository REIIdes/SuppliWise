'use strict';
/**
 * Unit tests for the ticket-id module.
 *
 * `node:test` + CommonJS, matching support-chat-state.test.js — the nearest
 * neighbour in this directory. Using ESM here would make this one file parse
 * differently from every sibling test, which is the sort of inconsistency that
 * breaks the next person's run.
 *
 * Everything here is a pure function of its input, so there is no database and
 * no server. The point is that the FORMAT cannot drift: it is what a person
 * types into the admin search box, and what both inboxes render. A wrong
 * `normalizeTicketSearch` is invisible until somebody cannot find the ticket
 * they are holding.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generateTicketId,
  isTicketId,
  normalizeTicketSearch,
  ALPHABET,
  CODE_LENGTH,
  PREFIX,
} = require('../utils/ticketId');

// ── The format ──────────────────────────────────────────────────────────────

test('a ticket id is SW- followed by 8 allowed characters', () => {
  for (let index = 0; index < 200; index += 1) {
    const id = generateTicketId();
    assert.ok(isTicketId(id), `${id} should be a valid ticket id`);
    assert.match(id, /^SW-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
  }
});

test('a ticket id never uses the four letters people misread aloud', () => {
  // I, L, O and U are excluded from the alphabet. A ticket id containing them is
  // one somebody will type wrong, and every such typo is a support ticket about
  // the support ticket.
  for (const letter of ['I', 'L', 'O', 'U', 'i', 'l', 'o', 'u']) {
    assert.ok(!ALPHABET.includes(letter), `${letter} must not be in the alphabet`);
  }
  for (let index = 0; index < 500; index += 1) {
    assert.ok(!/[ILOU]/.test(generateTicketId()));
  }
});

test('32 symbols means no modulo bias in `byte % 32`', () => {
  assert.equal(ALPHABET.length, 32);
  assert.equal(256 % 32, 0);
  assert.equal(CODE_LENGTH, 8);
});

test('ticket ids are practically unique', () => {
  // 32^8 is ~1.1e12. 20,000 draws with zero repeats is the practical form of
  // "you will not meet this in production" — the code still retries on a
  // collision, but this proves the retry is for insurance, not for work.
  const seen = new Set();
  for (let index = 0; index < 20000; index += 1) {
    const id = generateTicketId();
    assert.ok(!seen.has(id), `duplicate ${id}`);
    seen.add(id);
  }
});

// ── The search normaliser ───────────────────────────────────────────────────

test('the normaliser accepts an exact code', () => {
  assert.equal(normalizeTicketSearch('SW-4KQ7M2XB'), 'SW-4KQ7M2XB');
});

test('the normaliser accepts the sloppy forms a person actually types', () => {
  assert.equal(normalizeTicketSearch('sw-4kq7m2xb'), 'SW-4KQ7M2XB');
  assert.equal(normalizeTicketSearch('sw4kq7m2xb'), 'SW-4KQ7M2XB');
  assert.equal(normalizeTicketSearch('  SW-4KQ7M2XB  '), 'SW-4KQ7M2XB');
  assert.equal(normalizeTicketSearch('sw 4kq7m2xb'), 'SW-4KQ7M2XB');
  assert.equal(normalizeTicketSearch('SW_4KQ7M2XB'), 'SW-4KQ7M2XB');
});

test('the normaliser rejects anything that is not a code', () => {
  assert.equal(normalizeTicketSearch(''), '');
  assert.equal(normalizeTicketSearch(undefined), '');
  assert.equal(normalizeTicketSearch(null), '');
  assert.equal(normalizeTicketSearch('support'), '');
  assert.equal(normalizeTicketSearch('SW-4KQ7M2X'), '');     // one short
  assert.equal(normalizeTicketSearch('SW-4KQ7M2XBB'), '');   // one long
  assert.equal(normalizeTicketSearch('$(1)'), '');           // regex metacharacters
  assert.equal(normalizeTicketSearch('4KQ7M2XB'), '');       // no prefix
  assert.equal(normalizeTicketSearch('SW-4KQ7M2XB extra'), ''); // code plus a sentence
});

test('punctuation around a code is stripped, because codes get pasted into sentences', () => {
  // A member pastes "my ticket is SW-4KQ7M2XB, thanks!" — the punctuation that
  // rides along is not part of the code, and rejecting the whole paste would be
  // the normaliser being clever in the wrong direction.
  assert.equal(normalizeTicketSearch('SW-4KQ7M2XB)'), 'SW-4KQ7M2XB');
  assert.equal(normalizeTicketSearch('(SW-4KQ7M2XB)'), 'SW-4KQ7M2XB');
  assert.equal(normalizeTicketSearch('SW-4KQ7M2XB!'), 'SW-4KQ7M2XB');
});

test('an ambiguous character is rejected rather than guessed', () => {
  // `0` (zero) is a valid symbol; `O` (letter) is not, and there is no mapping
  // between them. Silently translating one into the other would make a typo land
  // on somebody else's ticket, which is worse than a search miss.
  assert.equal(normalizeTicketSearch('SW-4KQ7M2OB'), '');
  assert.equal(normalizeTicketSearch('SW-4KQ7M2LB'), '');
  assert.equal(normalizeTicketSearch('SW-4KQ7M2IB'), '');
  assert.equal(normalizeTicketSearch('SW-4KQ7M2UB'), '');
  // A lowercase 'o' is up-cased first, then rejected for exactly the same
  // reason — so nobody can salvage a mistyped ticket by lowering the case.
  assert.equal(normalizeTicketSearch('SW-4KQ7M2oB'), '');
  // `0` IS valid, and must survive: rejecting it would make a fifth of all
  // codes unfindable.
  assert.equal(normalizeTicketSearch('SW-4KQ7M20B'), 'SW-4KQ7M20B');
});

