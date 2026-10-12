/**
 * SUPPORT PRESENCE — is a support operator at the console right now?
 *
 * The admin console polls GET /api/admin/chats every 12 seconds while an
 * operator has the Chat management tab open. Each of those polls stamps an
 * in-memory "last activity" timestamp here; the member inbox reads it through
 * GET /api/support-chat to decide whether to show "Active Now" or "Away"
 * beside a conversation.
 *
 * In-memory is deliberate. This is a live-ness signal with a 60-second half
 * life, not a record: a server restart resets it to "Away", which is the safe
 * direction to be wrong in — it under-promises. Persisting it would add a
 * write on every admin poll to cache something that is stale within a minute
 * anyway.
 *
 * The window is 5x the console's poll interval, so a few dropped or slow
 * polls cannot make the indicator flicker.
 */
const ACTIVE_WINDOW_MS = 60 * 1000;

let lastAdminActivityAt = 0;
const changeListeners = new Set(); // observers of the boolean flipping

// Push the boolean's flips onto the support-chat event bus so a member's open
// stream learns "an operator arrived" (or lapsed to "Away") without waiting
// for the next list poll. Lazy require keeps this module dependency-free at
// load, like the rest of the presence logic.
function emitChanged(isActive) {
  for (const fn of [...changeListeners]) {
    try {
      fn(isActive);
    } catch (error) {
      console.error('[support-presence] listener failed:', error.message);
    }
  }
}

function onSupportActiveChange(fn) {
  if (typeof fn !== 'function') return () => {};
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

function markAdminActivity() {
  const wasActive = isSupportActive();
  lastAdminActivityAt = Date.now();
  if (!wasActive) {
    lastAnnouncedActive = true;
    emitChanged(true);
  }
}

function isSupportActive() {
  return Date.now() - lastAdminActivityAt < ACTIVE_WINDOW_MS;
}

// One process-wide liveness timer, not one per stream: presence is a single
// global boolean, so whoever flips it false only has to announce it once. The
// interval fires the false edge when the window lapses with no admin activity
// in it (every console closed, or a server that kept running after the
// streams died); cheap enough to leave always on.
let livenessTimer = null;
let lastAnnouncedActive = false;
function ensureLivenessTimer() {
  if (livenessTimer) return;
  livenessTimer = setInterval(() => {
    const active = isSupportActive();
    if (active !== lastAnnouncedActive) {
      lastAnnouncedActive = active;
      if (!active) emitChanged(false);
    }
  }, 15_000);
  // Never keep the process alive for a background signal.
  if (typeof livenessTimer.unref === 'function') livenessTimer.unref();
}
ensureLivenessTimer();

module.exports = { markAdminActivity, isSupportActive, onSupportActiveChange, ACTIVE_WINDOW_MS };
