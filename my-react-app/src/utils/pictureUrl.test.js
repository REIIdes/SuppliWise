/**
 * pictureUrl — resolves a stored picture reference to a loadable URL.
 *
 * Run: npm test
 *
 * The failure this guards against is quiet and expensive: a stored path is
 * handed to <img src> unresolved, the browser resolves it against the SPA's
 * own origin (the Vite dev server on :5173), gets a 404, and the avatar
 * silently falls back to an initial. Nothing errors — the picture just is not
 * there, which is easy to mistake for a missing upload.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_URL } from '../api.js';
import { pictureUrl } from './pictureUrl.js';

const API_ORIGIN = BASE_URL.replace(/\/api\/?$/, '');

test('resolves a stored picture path against the API origin', () => {
  assert.equal(
    pictureUrl('/pictures/abc-profile-def123.png'),
    `${API_ORIGIN}/pictures/abc-profile-def123.png`
  );
});

test('passes through an already-absolute URL unchanged', () => {
  const url = 'https://cdn.example.com/a.png';
  assert.equal(pictureUrl(url), url);
});

test('passes through an http URL unchanged (LAN/dev parity)', () => {
  const url = 'http://192.168.1.42:5000/pictures/a.png';
  assert.equal(pictureUrl(url), url);
});

test('passes through a legacy inline data URL unchanged', () => {
  // Pre-migration values (or an unsaved client-side preview) are still data
  // URLs and must keep rendering.
  const data = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(pictureUrl(data), data);
});

test('empty / non-string values produce no picture', () => {
  assert.equal(pictureUrl(''), '');
  assert.equal(pictureUrl('   '), '');
  assert.equal(pictureUrl(null), '');
  assert.equal(pictureUrl(undefined), '');
  assert.equal(pictureUrl(42), '');
  assert.equal(pictureUrl({}), '');
});

test('refuses values that are not pictures we own', () => {
  // Never hand an unvetted value to the DOM: `javascript:` in an <img src> is
  // harmless in modern browsers but the intent here is allowlist-only, the
  // same policy as utils/safeUrl.js.
  assert.equal(pictureUrl('javascript:alert(1)'), '');
  assert.equal(pictureUrl('//evil.example.com/a.png'), '');
  assert.equal(pictureUrl('/some/other/path.png'), '');
  assert.equal(pictureUrl('../../etc/passwd'), '');
});

test('the resolved path is absolute, so a changed host keeps working', () => {
  // The whole point of storing a relative path: nothing host-specific is
  // baked in, so the same stored value renders from localhost and from a LAN
  // address without being re-signed-in from the new host.
  const resolved = pictureUrl('/pictures/a.png');
  assert.ok(resolved.startsWith('http://') || resolved.startsWith('https://'));
  assert.ok(resolved.endsWith('/pictures/a.png'));
});
