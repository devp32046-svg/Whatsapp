'use strict';
/* Pure fire-engine logic for the Aaziko Reminder Engine.
 *
 * NO require(), NO network, NO Date.now() inside the decision (the caller passes nowMs) — so it is
 * deterministic AND the exact same code can be pasted into an n8n Code node (where require is banned).
 *
 * Locked conventions:
 *   - nextFireAt is ALWAYS a UTC ISO string in the DB.
 *   - IST wall-clock -> UTC conversion happens EXACTLY ONCE, at create time, via istWallToUtcIso().
 *     (This is the CGPE +5.5h bug: never slap a 'Z' on an IST time.)
 *   - Quiet hours = 22:00:00–07:59:59 IST. A due reminder in quiet hours is HELD (stays active),
 *     never dropped and never fired.
 */
var IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // +05:30, India has no DST

// Shift the instant so the UTC getters read the IST wall-clock.
function istParts(ms) {
  var d = new Date(ms + IST_OFFSET_MS);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
           hour: d.getUTCHours(), min: d.getUTCMinutes() };
}

// true during 22:00:00–07:59:59 IST
function isQuietIST(ms) { var h = istParts(ms).hour; return h >= 22 || h < 8; }

// Interpret a wall-clock string as IST and return the real UTC instant as an ISO string.
// Call ONCE (not idempotent). Accepts "YYYY-MM-DD HH:mm" or "...THH:mm", seconds optional.
function istWallToUtcIso(wall) {
  var m = String(wall).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw new Error('istWallToUtcIso: bad IST wall-clock "' + wall + '" (want YYYY-MM-DD HH:mm)');
  var utcMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - IST_OFFSET_MS;
  return new Date(utcMs).toISOString();
}

// reminders: [{ _id, status, nextFireAt(UTC ISO), ... }]. Decides; marks nothing.
// A bad/missing timestamp is pushed to `skipped`, never silently fired.
function fireDecision(reminders, nowMs) {
  var quiet = isQuietIST(nowMs);
  var out = { nowMs: nowMs, quiet: quiet, toFire: [], heldQuiet: [], notDue: [], skipped: [] };
  (reminders || []).forEach(function (r) {
    if (!r || r.status !== 'active') { out.skipped.push(r); return; }
    var due = Date.parse(r.nextFireAt);
    if (isNaN(due)) { out.skipped.push(r); return; }
    if (due > nowMs) { out.notDue.push(r); return; }
    if (quiet) { out.heldQuiet.push(r); return; }
    out.toFire.push(r);
  });
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { IST_OFFSET_MS, istParts, isQuietIST, istWallToUtcIso, fireDecision };
}
