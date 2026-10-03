/**
 * Server-issued math CAPTCHA for bot-resistant registration.
 * Challenge is created server-side, answer never leaves the server until
 * verified; each challenge is single-use with a 5-minute TTL.
 */
const crypto = require('crypto');

const CAPTCHA_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 1000;

// id -> { answer, expiresAt }
const challenges = new Map();

function prune() {
  const now = Date.now();
  for (const [id, entry] of challenges) {
    if (now > entry.expiresAt) challenges.delete(id);
  }
  while (challenges.size > MAX_ENTRIES) {
    const oldest = challenges.keys().next().value;
    challenges.delete(oldest);
  }
}

function randInt(min, max) {
  return crypto.randomInt(min, max + 1);
}

// Create a challenge. Addition always; subtraction arranged non-negative;
// occasional small multiplication keeps bots guessing while staying human.
function newChallenge() {
  prune();
  const kind = crypto.randomInt(0, 10);
  let a;
  let b;
  let op;
  let answer;
  if (kind < 6) {
    a = randInt(3, 19);
    b = randInt(2, 19);
    op = '+';
    answer = a + b;
  } else if (kind < 9) {
    a = randInt(5, 25);
    b = randInt(2, a);
    op = '−';
    answer = a - b;
  } else {
    a = randInt(2, 9);
    b = randInt(2, 9);
    op = '×';
    answer = a * b;
  }
  const id = crypto.randomBytes(16).toString('hex');
  challenges.set(id, { answer, expiresAt: Date.now() + CAPTCHA_TTL_MS });
  return { id, question: `${a} ${op} ${b} = ?` };
}

// Returns true once for the correct answer; consumes the challenge either way.
function verifyCaptcha(id, answer) {
  if (typeof id !== 'string' || id.length !== 32) return false;
  const entry = challenges.get(id);
  challenges.delete(id);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) return false;
  return Number(answer) === entry.answer;
}

module.exports = { newChallenge, verifyCaptcha, CAPTCHA_TTL_MS };
