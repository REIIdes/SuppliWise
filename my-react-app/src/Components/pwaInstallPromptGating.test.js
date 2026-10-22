/**
 * PWAInstallPrompt — the card is mobile-only and a "no" stays a "no".
 *
 * Run: npm test
 *
 * Two regressions from the 2026-10 minor-bug round, both proven by reading
 * the component source (node --test cannot import a .jsx file):
 *   1. Chrome fires beforeinstallprompt on DESKTOP too, and the card used to
 *      render over the dashboard — "Install for mobile modal showing".
 *   2. Cancelling the NATIVE dialog left no cooldown, so the card returned
 *      every session after every decline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../Components/PWAInstallPrompt.jsx', import.meta.url), 'utf8');

test('the install card is gated to touch devices before it ever listens', () => {
  assert.match(src, /pointer: coarse/);
  assert.match(src, /if \(isInstalled \|\| !isTouchDevice\(\)/);
});

test('declining the native prompt earns the same 7-day cooldown as the × button', () => {
  assert.match(src, /outcome !== 'accepted'\) rememberDismissal\(\)/);
  assert.match(src, /pwa-install-dismissed/);
});

test('installing the app dismisses the card', () => {
  assert.match(src, /addEventListener\('appinstalled'/);
});
