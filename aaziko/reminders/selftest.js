'use strict';
/* Inline self-tests for the fire-logic. No DB, no network — safe to run anytime.
 *   node aaziko/reminders/selftest.js
 */
var L = require('./lib/fire-logic');
var fails = 0;
function eq(name, got, want) {
  var ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '   got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)));
  if (!ok) fails++;
}
function nowIST(wall) { return Date.parse(L.istWallToUtcIso(wall)); } // an IST wall-clock as nowMs

// --- UTC storage (the +5.5h bug guard) ---
eq('istWallToUtcIso 11:15 IST -> 05:45Z', L.istWallToUtcIso('2026-11-18 11:15'), '2026-11-18T05:45:00.000Z');
eq('istWallToUtcIso 00:30 IST -> prev-day 19:00Z', L.istWallToUtcIso('2026-11-18 00:30'), '2026-11-17T19:00:00.000Z');

// --- quiet-hours boundaries (22:00–08:00 IST) ---
eq('07:59 IST is quiet', L.isQuietIST(nowIST('2026-11-18 07:59')), true);
eq('08:00 IST NOT quiet', L.isQuietIST(nowIST('2026-11-18 08:00')), false);
eq('21:59 IST NOT quiet', L.isQuietIST(nowIST('2026-11-18 21:59')), false);
eq('22:00 IST is quiet', L.isQuietIST(nowIST('2026-11-18 22:00')), true);

var due10 = L.istWallToUtcIso('2026-11-18 10:00');
function R(over) { return Object.assign({ _id: 'x', status: 'active', nextFireAt: due10, text: 't' }, over || {}); }

// 1. due 10:00, now 10:01, not quiet -> fires
var d1 = L.fireDecision([R()], nowIST('2026-11-18 10:01'));
eq('1 due & not-quiet -> fires', [d1.toFire.length, d1.heldQuiet.length, d1.notDue.length], [1, 0, 0]);

// 2. due but quiet (23:31) -> held, stays active
var d2 = L.fireDecision([R({ nextFireAt: L.istWallToUtcIso('2026-11-18 23:30') })], nowIST('2026-11-18 23:31'));
eq('2 due but quiet -> held, not fired', [d2.toFire.length, d2.heldQuiet.length], [0, 1]);

// 3. already fired -> never re-fires
var d3 = L.fireDecision([R({ status: 'fired' })], nowIST('2026-11-18 10:01'));
eq('3 already fired -> skipped', [d3.toFire.length, d3.skipped.length], [0, 1]);

// 5. not due yet -> held as notDue
var d5 = L.fireDecision([R()], nowIST('2026-11-18 09:00'));
eq('5 not due yet -> notDue', [d5.notDue.length, d5.toFire.length], [1, 0]);

// 6. terminal no-op: nothing active due
var d6 = L.fireDecision([], nowIST('2026-11-18 10:01'));
eq('6 empty input -> clean no-op', d6.toFire.length, 0);

// 7. bad timestamp -> never silently fires
var d7 = L.fireDecision([R({ nextFireAt: 'not-a-date' })], nowIST('2026-11-18 10:01'));
eq('7 bad nextFireAt -> skipped, never fired', [d7.toFire.length, d7.skipped.length], [0, 1]);

// ===== Tests for the SHIPPED n8n Code-node strings (the exact text deployed, not a side-copy) =====
var NC = require('./lib/node-code');
var RealDate = Date;
function mkDate(nowMs) {               // a Date shim with a fixed now(), so these tests are time-independent
  function D() { if (arguments.length === 0) return new RealDate(nowMs); if (arguments.length === 1) return new RealDate(arguments[0]); return new RealDate(arguments[0], arguments[1], arguments[2], arguments[3], arguments[4], arguments[5]); }
  D.now = function () { return nowMs; }; D.parse = RealDate.parse; D.UTC = RealDate.UTC; return D;
}
function runCode(code, o) { o = o || {}; var fn = new Function('$', '$input', '$json', 'Date', code); return fn(o.$ || function () { return {}; }, o.$input || {}, o.$json || {}, mkDate(o.nowMs || RealDate.now())); }

// -- DECIDE --
var notQuiet = nowIST('2026-11-18 10:01'), quietNow = nowIST('2026-11-18 23:00');
var dueRow = { _id: 'R1', status: 'active', nextFireAt: L.istWallToUtcIso('2026-11-18 10:00'), recipientPhone: '919999999999', text: 'hi' };
var futRow = { _id: 'R2', status: 'active', nextFireAt: L.istWallToUtcIso('2026-11-19 10:00'), recipientPhone: '91888', text: 'later' };
var firedRow = { _id: 'R3', status: 'fired', nextFireAt: L.istWallToUtcIso('2026-11-18 09:00'), recipientPhone: '91777', text: 'old' };
var badRow = { _id: 'R4', status: 'active', nextFireAt: 'nope', recipientPhone: '91666', text: 'bad' };
function decideIn(cfg, rows) { return { $: function (n) { return n === 'Load Config' ? { first: function () { return { json: cfg }; } } : {}; }, $input: { all: function () { return rows.map(function (r) { return { json: r }; }); } } }; }
var ENABLED_UI = { sendEnabled: true, channel: 'ui' };
var ENABLED_WA = { sendEnabled: true, channel: 'whatsapp', phoneNumberId: '111', token: 'tok', graphVersion: 'v21.0' };

var dA = runCode(NC.DECIDE, Object.assign({ nowMs: notQuiet }, decideIn(ENABLED_UI, [dueRow, futRow, firedRow, badRow])));
eq('DECIDE ui+not-quiet -> only the 1 due active', [dA.length, dA[0] && dA[0].json._id, dA[0] && dA[0].json.status, dA[0] && dA[0].json.channel], [1, 'R1', 'sending', 'ui']);
eq('DECIDE emitted item carries recipientPhone', dA[0].json.recipientPhone, '919999999999');
var dWA = runCode(NC.DECIDE, Object.assign({ nowMs: notQuiet }, decideIn(ENABLED_WA, [dueRow])));
eq('DECIDE whatsapp+creds -> fires w/ token+pnid', [dWA.length, dWA[0].json.channel, dWA[0].json.token, dWA[0].json.phoneNumberId], [1, 'whatsapp', 'tok', '111']);
eq('DECIDE sendEnabled:false -> 0 (gated)', runCode(NC.DECIDE, Object.assign({ nowMs: notQuiet }, decideIn({ sendEnabled: false, channel: 'ui' }, [dueRow]))).length, 0);
eq('DECIDE whatsapp but no creds -> 0', runCode(NC.DECIDE, Object.assign({ nowMs: notQuiet }, decideIn({ sendEnabled: true, channel: 'whatsapp', phoneNumberId: '', token: '' }, [dueRow]))).length, 0);
eq('DECIDE ui+no-creds STILL fires (no number needed)', runCode(NC.DECIDE, Object.assign({ nowMs: notQuiet }, decideIn({ sendEnabled: true, channel: 'ui' }, [dueRow]))).length, 1);
eq('DECIDE due but quiet hours -> 0', runCode(NC.DECIDE, Object.assign({ nowMs: quietNow }, decideIn(ENABLED_UI, [dueRow]))).length, 0);

// -- BUILD_MARK (whatsapp) --
function markIn(decideItem, resp) { return { $: function (n) { return n === 'Decide' ? { item: { json: decideItem } } : {}; }, $json: resp }; }
var mOk = runCode(NC.BUILD_MARK, markIn({ _id: 'R1' }, { messages: [{ id: 'wamid_123' }] }));
eq('BUILD_MARK success -> sent + wamid + firedAt', [mOk.json.status, mOk.json.wamid, !!mOk.json.firedAt], ['sent', 'wamid_123', true]);
var mFail = runCode(NC.BUILD_MARK, markIn({ _id: 'R1' }, { error: { message: '401 bad token' } }));
eq('BUILD_MARK error -> failed, wamid null', [mFail.json.status, mFail.json.wamid], ['failed', null]);
eq('BUILD_MARK error -> sendError captured', /401/.test(mFail.json.sendError), true);
eq('BUILD_MARK redacts Bearer token', /Bearer \[redacted\]/.test(runCode(NC.BUILD_MARK, markIn({ _id: 'R1' }, { error: { message: 'auth Bearer SECRETTOKEN failed' } })).json.sendError), true);

// -- BUILD_UI_ROW + BUILD_MARK_UI --
var uiRow = runCode(NC.BUILD_UI_ROW, { $: function (n) { return n === 'Decide' ? { item: { json: { _id: 'R9', recipientPhone: '91999', remText: '🔔 Reminder: pay' } } } : {}; } });
eq('BUILD_UI_ROW -> ui_inbox doc', [uiRow.json.reminderId, uiRow.json.recipientPhone, uiRow.json.text, uiRow.json.channel, uiRow.json.delivered], ['R9', '91999', '🔔 Reminder: pay', 'ui', true]);
var mUI = runCode(NC.BUILD_MARK_UI, { $: function (n) { return n === 'Decide' ? { item: { json: { _id: 'R9' } } } : {}; } });
eq('BUILD_MARK_UI -> sent on ui, no wamid', [mUI.json.status, mUI.json.channel, mUI.json.wamid, !!mUI.json.firedAt], ['sent', 'ui', null, true]);

// -- buildFeed (UI feed) --
var FEED = NC.buildFeed('testsecret');
function feedIn(k, cfg, inboxRows, pendRows) { return { $: function (n) {
  if (n === 'Feed Hook') return { first: function () { return { json: { query: { k: k } } }; } };
  if (n === 'Load Config') return { first: function () { return { json: cfg }; } };
  if (n === 'Load Inbox') return { first: function () { return { json: { rows: inboxRows } }; } };
  if (n === 'Load Pending') return { first: function () { return { json: { rows: pendRows } }; } };
  return {};
} }; }
eq('buildFeed bad key -> ok:false', runCode(FEED, Object.assign({ nowMs: notQuiet }, feedIn('wrong', {}, [], [])))[0].json.ok, false);
var feedOk = runCode(FEED, Object.assign({ nowMs: notQuiet }, feedIn('testsecret', { sendEnabled: true, channel: 'ui' },
  [{ text: 'done', recipientPhone: '91', firedAt: L.istWallToUtcIso('2026-11-18 10:00') }],
  [{ text: 'od', recipientPhone: '91', nextFireAt: L.istWallToUtcIso('2026-11-18 09:00') }])))[0].json;
eq('buildFeed good key -> ok+channel+counts', [feedOk.ok, feedOk.channel, feedOk.sendEnabled, feedOk.inbox.length, feedOk.pending.length], [true, 'ui', true, 1, 1]);
eq('buildFeed inbox firedIST + pending overdue', [feedOk.inbox[0].firedIST, feedOk.pending[0].overdue], ['10:00', true]);
eq('buildFeed quietNow at 23:00 IST', runCode(FEED, Object.assign({ nowMs: quietNow }, feedIn('testsecret', {}, [], [])))[0].json.quietNow, true);

// -- buildDoc (Create node) --
var DOC = NC.buildDoc('testsecret');
function docIn(body) { return { $input: { first: function () { return { json: { body: body, headers: {} } }; } } }; }
var okDoc = runCode(DOC, docIn({ text: 'pay premium', recipientPhone: '91-9999-999999', nextFireAt: '2026-11-18 10:00', secret: 'testsecret' }));
eq('buildDoc valid -> _ok + UTC + active + digits', [okDoc[0].json._ok, okDoc[0].json.nextFireAt, okDoc[0].json.status, okDoc[0].json.recipientPhone], [true, '2026-11-18T04:30:00.000Z', 'active', '919999999999']);
function rej(name, body, code, re) { var r = runCode(DOC, docIn(body))[0].json; eq(name, [r._ok, r._code, re.test(r._error || '')], [false, code, true]); }
rej('buildDoc bad secret -> 401 no-throw', { text: 'x', recipientPhone: '919999999999', nextFireAt: '2026-11-18 10:00', secret: 'wrong' }, 401, /secret/);
rej('buildDoc missing text -> 400', { recipientPhone: '919999999999', nextFireAt: '2026-11-18 10:00', secret: 'testsecret' }, 400, /text required/);
rej('buildDoc UTC/Z -> 400', { text: 'x', recipientPhone: '919999999999', nextFireAt: '2026-11-18T04:30:00Z', secret: 'testsecret' }, 400, /IST wall-clock/);
rej('buildDoc bad phone -> 400', { text: 'x', recipientPhone: '12', nextFireAt: '2026-11-18 10:00', secret: 'testsecret' }, 400, /recipientPhone/);

console.log(fails ? ('\n' + fails + ' TEST(S) FAILED') : '\nALL PASS');
process.exit(fails ? 1 : 0);
