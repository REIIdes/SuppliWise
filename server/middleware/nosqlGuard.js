/**
 * Centralized NoSQL-operator guard.
 *
 * Mongoose already parameterizes every query, so classic SQLi does not exist
 * here — the Mongo equivalent is *operator injection*: a client that sends
 * `{"email": {"$ne": null}}` or `?id[$gt]=` hands the driver a query OBJECT
 * instead of a value, and any filter built from it without a type check runs
 * the operator. Credential routes guard their inputs individually; this is the
 * one rule that covers the rest of the surface — every parsed request — so a
 * route added tomorrow without a `typeof` check still cannot receive one.
 *
 * It runs AFTER the JSON parsers and before every router.
 */

const { scrubKeys } = require('../utils/sanitize');

const POLLUTION_KEYS = ['__proto__', 'constructor', 'prototype'];

// `$`-prefixed or dotted keys are query syntax, never field names this API uses.
const isOperatorKey = (key) => key.startsWith('$') || key.includes('.');

// Query strings and route parameters are read as scalars (or lists of scalars)
// everywhere in this API. A nested OBJECT in one of them is `?id[$gt]=` shaped
// input, so it is dropped whole instead of being passed to a filter as a bag.
function dropObjectValues(container) {
  if (!container || typeof container !== 'object') return;
  for (const key of Object.keys(container)) {
    const value = container[key];
    if (value && typeof value === 'object') delete container[key];
  }
}

// A top-level body field is either a value or a field bag. If scrubbing removed
// EVERY key it held, the field carried nothing but operators — the canonical
// `{"email": {"$ne": null}}` login bypass — so the field itself goes. A field
// that legitimately arrives empty (`symptomSeverity: {}`) had no keys to begin
// with and is left exactly as the client sent it.
function sanitizeBody(container) {
  if (!container || typeof container !== 'object' || Array.isArray(container)) return;
  for (const key of Object.keys(container)) {
    if (isOperatorKey(key) || POLLUTION_KEYS.includes(key)) {
      delete container[key];
      continue;
    }
    const value = container[key];
    if (!value || typeof value !== 'object') continue;
    const before = Object.keys(value).length;
    scrubKeys(value);
    if (before > 0 && Object.keys(value).length === 0) delete container[key];
  }
}

const nosqlGuard = (req, _res, next) => {
  // `req.query` is a getter on Express 5 and a plain object on 4; reading it
  // forces the parse, and writing its keys back is safe on both.
  for (const bag of [req.query, req.params]) {
    if (bag && typeof bag === 'object') {
      scrubKeys(bag);
      dropObjectValues(bag);
    }
  }
  sanitizeBody(req.body);
  next();
};

module.exports = { nosqlGuard };
