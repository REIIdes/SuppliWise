/**
 * SUPPORT PRESENCE — is a support operator at the console right now?
 *
 * Two signals, OR-ed:
 *   • the console's 12-second queue poll stamps an in-memory "last activity"
 *     timestamp (markAdminActivity);
 *   • an open Chat-stream connection (GET /api/admin/chats/stream) counts as
 *     an operator being AT the console for as long as the connection lives,
 *     which is strictly more accurate than the poll window and, since the
 *     realtime feature landed, is normally the signal that decides.
 *
 * The member inbox reads the result through GET /api/support-chat (and now
 * through its own stream, which pushes the boolean's FLIPS the moment they
 * happen) to decide whether to show "Active Now" or "Away".
 *
 * In-memory is deliberate. This is a live-ness signal with a 60-second half
 * life, not a record: a server restart resets it to "Away", which is the safe
 * direction to be wrong in — it under-promises. Persisting it would add a
 * write on every admin poll to cache something that is stale within a minute
 * anyway.
 *
 * The poll window is 5x the console's poll interval, so a few dropped or slow
 * polls cannot make the indicator flicker.
 */
const ACTIVE_WINDOW_MS = 60 * 1000;

let lastAdminActivityAt = 0;
let liveAdminConnections = 0;
const changeListeners = new Set(); // observers of the boolean flipping
let lastAnnouncedActive = false;

// Flip observer: onSupportActiveChange lets the member's stream push
// "Active Now" / "Away" without waiting for the next list poll. Lazy require
// would only hide a real dependency; this module stays dependency-free and
// fans out on its own — chatEventBus is not needed here because the streams
// subscribe to THIS module directly.
function emitChanged(isActive) {
  if (isActive === lastAnnouncedActive) return;
  lastAnnouncedActive = isActive;
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

function evaluate() {
  emitChanged(isSupportActive());
}

function markAdminActivity() {
  lastAdminActivityAt = Date.now();
  evaluate();
}

// Called when an admin console OPENS its stream, and on every request the
// console makes, so a long-lived connection keeps presence true while open.
function addAdminConnection() {
  liveAdminConnections += 1;
  lastAdminActivityAt = Date.now();
  evaluate();
}

function removeAdminConnection() {
  liveAdminConnections = Math.max(0, liveAdminConnections - 1);
  evaluate();
}

function isSupportActive() {
  return liveAdminConnections > 0 || Date.now() - lastAdminActivityAt < ACTIVE_WINDOW_MS;
}

// One process-wide backstop timer, not one per stream: presence is a single
// global boolean, so whoever flips it false only has to announce it once. It
// fires the false edge when the poll window lapses with no live connections —
// e.g. a server whose streams died with the clients without a clean close.
const livenessTimer = setInterval(() => {
  // A live connection stamps activity on connect/disconnect only, so an
  // opened-then-abandoned connection could otherwise pin presence true forever
  // if its close event never arrived. Streams refresh the stamp themselves.
  evaluate();
}, 15_000);
// Never keep the process alive for a background signal.
if (typeof livenessTimer.unref === 'function') livenessTimer.unref();

module.exports = {
  markAdminActivity,
  isSupportActive,
  onSupportActiveChange,
  addAdminConnection,
  removeAdminConnection,
  ACTIVE_WINDOW_MS,
};
