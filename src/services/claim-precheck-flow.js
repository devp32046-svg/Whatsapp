'use strict';
/**
 * Claim pre-check conversation - a WhatsApp state machine over the review engine.
 *
 * Contract (same idea as handleTeamTaskAction): returns null to let the message fall through to
 * the normal bot, or {reply, buttons} to short-circuit and answer here.
 *
 * Dependencies are injected so the whole flow is testable without Mongo, WhatsApp or Gemini.
 */
const engine = require('./claim-review-engine');
const fmt = engine.formatINR;

const COLLECTION = 'claim_precheck_sessions';
const STALE_MS = 30 * 60 * 1000;          // a stuck flow must not hijack a number forever
const MAX_DOCS = 15;

// Admin/team only: a client cannot be expected to know the room-rent limit or balance sum insured.
const ALLOWED_ROLES = ['admin', 'super_admin', 'superadmin', 'team', 'team_member', 'teammember', 'staff', 'agent'];

const STEP = {
  POLICY: 'AWAIT_POLICY_INFO',
  BILL: 'AWAIT_BILL_DOC',
  MORE: 'AWAIT_MORE_DOCS',
  CONFIRM: 'CONFIRM_SAVED_TERMS',
  RESULT: 'RESULT_READY'
};

// Button titles are what comes back on a tap (Meta sends the title, not a stable id), so these
// strings are the routing keys. Max 20 chars, max 3 per message.
const BTN = { BREAKDOWN: 'VIEW BREAKDOWN', RECHECK: 'RE-CHECK', CANCEL: 'CANCEL', POLICY: 'UPDATE POLICY', DONE: 'DONE - CHECK' };

/**
 * One question at a time. The first version asked for eleven values in one positionally-ordered
 * message and Ved could not follow it himself - which meant the sales and ops team had no chance.
 *
 * Only what genuinely changes the answer is asked:
 *   - the actual room rent is READ FROM THE BILL (Gemini already returns room_rent_per_day)
 *   - balance SI defaults to the sum insured, deductible and sub-limit to 0
 *   - the ICU limit was dropped entirely: it was collected and then used by nothing at all
 * Everything assumed is shown back before the bill is asked for, so nothing is silently decided.
 */
const CHOICE = ['NAHI', 'HAAN', 'PATA NAHI'];

const QUESTIONS = [
  { key: 'sumInsured', step: 'ASK_SI', type: 'number', min: 10000,
    tooSmall: 'Sum insured itna kam nahi hota. Pura amount likhein - jaise 500000 ya 5 lakh.',
    // no "pre-check shuru" heading here any more - by the time this is asked the file has
    // already been sent, so announcing the start read as a restart
    q: 'Sum insured kitna hai?\n_(policy mein total cover - jaise 500000 ya 5 lakh)_' },
  { key: 'roomRentLimitPerDay', step: 'ASK_ROOM', type: 'number', skippable: true, min: 100,
    tooSmall: 'Room limit itni kam nahi hoti. Per-day amount likhein - jaise 5000.',
    q: 'Room rent ki limit kitni hai, per day?\n_Pata nahi ho to SKIP likhein_' },
  { key: 'coPayPct', step: 'ASK_COPAY', type: 'number', max: 100,
    tooBig: 'Co-pay 100% se zyada nahi ho sakta. Sirf percent likhein - jaise 10.',
    q: 'Co-pay kitne % hai?\n_Nahi hai to 0 likhein_' },
  { key: 'policyStartDate', step: 'ASK_START', type: 'date', skippable: true,
    q: 'Policy pehli baar kab shuru hui?\n_jaise 01/04/2022 - pata nahi ho to SKIP_' },
  { key: 'pedCase', step: 'ASK_PED', type: 'choice', buttons: CHOICE,
    q: 'Ye claim purani bimari (PED) ka hai?' },
  { key: 'pedWaitYears', step: 'ASK_PED_YEARS', type: 'number',
    onlyIf: p => p.pedCase === 'HAAN',
    q: 'PED waiting period kitne saal ka hai?\n_policy mein likha hota hai, aam taur pe 2-4_' },
  { key: 'exclusionStatus', step: 'ASK_EXCL', type: 'choice', buttons: CHOICE,
    q: 'Kya ye treatment policy ki exclusion list mein hai?' }
];

function questionAt(step) { return QUESTIONS.filter(q => q.step === step)[0] || null; }

// What the model can lift off a policy schedule. PED and exclusion are judgements about THIS
// admission, so they always need a human - they are never auto-filled.
const FROM_DOCUMENT = {
  sum_insured: 'sumInsured',
  room_rent_limit_per_day: 'roomRentLimitPerDay',
  co_pay_pct: 'coPayPct',
  deductible: 'deductible',
  sublimit: 'sublimitAmount',
  policy_start_date: 'policyStartDate'
};

/** Merge policy terms found in the uploaded documents. Never overwrites a human's answer. */
function termsFromDocuments(documents, already) {
  const out = Object.assign({}, already || {});
  const found = [];
  (documents || []).forEach(d => {
    const t = (d.structured || {}).policy_terms || {};
    Object.keys(FROM_DOCUMENT).forEach(k => {
      const key = FROM_DOCUMENT[k];
      const v = t[k];
      if (v == null || v === '' || out[key] != null) { return; }
      const val = key === 'policyStartDate' ? String(v) : Number(v);
      if (key !== 'policyStartDate' && !isFinite(val)) { return; }
      out[key] = val;
      found.push(key);
    });
    if (t.policy_number && !out.policyNumber) { out.policyNumber = String(t.policy_number); }
    if (t.insurer && !out.insurer) { out.insurer = String(t.insurer); }
  });
  return { params: out, found: found };
}

/** The policy number is the key a saved profile is found by; fall back to the bill's. */
function policyNumberOf(documents, params) {
  if (params && params.policyNumber) { return String(params.policyNumber); }
  for (const d of (documents || [])) {
    const t = (d.structured || {}).policy_terms || {};
    if (t.policy_number) { return String(t.policy_number); }
  }
  return null;
}

/** Which questions still have no answer, in order. */
function pendingQuestions(params) {
  return QUESTIONS.filter(q => {
    if (q.onlyIf && !q.onlyIf(params)) { return false; }
    return params[q.key] === undefined;      // null means "asked and skipped"
  });
}

function nextQuestion(afterKey, p) {
  let i = afterKey === null ? 0 : QUESTIONS.map(q => q.key).indexOf(afterKey) + 1;
  for (; i < QUESTIONS.length; i++) {
    if (!QUESTIONS[i].onlyIf || QUESTIONS[i].onlyIf(p)) { return QUESTIONS[i]; }
  }
  return null;
}

/** -> {ok:true, value} | {ok:false, why} */
function parseAnswer(q, raw) {
  const t = buttonTitle(raw);
  if (q.skippable && /^\s*(skip|pata nahi|nahi pata|-)\s*$/i.test(t)) { return { ok: true, value: null }; }

  if (q.type === 'choice') {
    const up = t.toUpperCase().replace(/\s+/g, ' ').trim();
    if (CHOICE.indexOf(up) !== -1) { return { ok: true, value: up }; }
    if (/^(no|n)$/i.test(up)) { return { ok: true, value: 'NAHI' }; }
    if (/^(yes|y|ha)$/i.test(up)) { return { ok: true, value: 'HAAN' }; }
    return { ok: false, why: 'Neeche ke buttons mein se ek dabayein.' };
  }
  if (q.type === 'date') {
    const m = t.match(/\b(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4}|\d{4}-\d{1,2}-\d{1,2})\b/);
    if (!m) { return { ok: false, why: 'Date aise likhein: 01/04/2022' }; }
    return { ok: true, value: m[1] };
  }
  const amt = parseAmount(t);
  if (amt === null) { return { ok: false, why: 'Sirf number likhein, jaise 500000 ya 5 lakh' }; }
  // "5 lakh" used to parse as 5, which then capped the whole claim at Rs 5. A number far below
  // what the field can plausibly be is a mis-read, not an answer - ask again rather than
  // silently producing a nonsense settlement.
  if (q.max != null && amt > q.max) {
    return { ok: false, why: q.tooBig || 'Itna zyada nahi ho sakta.' };
  }
  if (q.min != null && amt < q.min) {
    return { ok: false, why: q.tooSmall || ('Itna kam nahi ho sakta - pura amount likhein.') };
  }
  return { ok: true, value: amt };
}

/**
 * Indians write amounts as "5 lakh", "5L", "1.2 crore", "50k" at least as often as "500000".
 * Stripping non-digits turned all of those into their leading digit.
 */
function parseAmount(raw) {
  const t = String(raw == null ? '' : raw).toLowerCase().replace(/,/g, '');
  const m = t.match(/(\d+(?:\.\d+)?)\s*(crores?|cr|lakhs?|lacs?|lakh|lac|l|k|thousand)?\b/);
  if (!m) { return null; }
  const n = Number(m[1]);
  if (!isFinite(n)) { return null; }
  const unit = m[2] || '';
  if (/^(crores?|cr)$/.test(unit)) { return n * 10000000; }
  if (/^(lakhs?|lacs?|lakh|lac|l)$/.test(unit)) { return n * 100000; }
  if (/^(k|thousand)$/.test(unit)) { return n * 1000; }
  return n;
}

/** Fill in everything that was not asked, so the waterfall always gets a complete input. */
function withDefaults(p) {
  const out = Object.assign({}, p);
  if (out.balanceSI == null) { out.balanceSI = out.sumInsured; }
  if (out.deductible == null) { out.deductible = 0; }
  if (out.sublimitAmount == null) { out.sublimitAmount = 0; }
  if (out.pedWaitYears == null) { out.pedWaitYears = 0; }
  if (out.proportionateApplicable == null) { out.proportionateApplicable = true; }
  // NAHI -> 0, HAAN -> 1, PATA NAHI -> 2 (2 keeps the check Pending rather than passing it)
  if (typeof out.exclusionStatus === 'string') {
    out.exclusionStatus = out.exclusionStatus === 'HAAN' ? 1 : (out.exclusionStatus === 'NAHI' ? 0 : 2);
  }
  if (out.exclusionStatus == null) { out.exclusionStatus = 2; }
  return out;
}

const TRIGGER = /(claim\s*(pre[-\s]?)?check)|(pre[-\s]?check\s*claim)/i;

/**
 * A tapped button does not arrive as its title. The gateway's Normalize Message builds
 * `id + ' (' + title + ')'`, e.g. "pc0 (VIEW BREAKDOWN)", so every button comparison has to
 * unwrap that first - otherwise no button in this flow would ever match.
 */
function buttonTitle(t) {
  const m = String(t == null ? '' : t).match(/^\s*\S+\s*\((.+)\)\s*$/);
  return (m ? m[1] : String(t == null ? '' : t)).trim();
}

function isCancel(t) { return /^\s*cancel\s*$/i.test(buttonTitle(t)); }
function isDone(t) { return /^\s*(done|done\s*-\s*check|check|calculate)\s*$/i.test(buttonTitle(t)); }

// ---------------------------------------------------------------------------
// Templates - Hinglish, short, single-asterisk bold, interactive body under ~1024 chars
// ---------------------------------------------------------------------------

function tplAskForFile() {
  return '*Claim Pre-Check*\n\n' +
    'Claim file bhejein - PDF ya saaf photo.\n' +
    'IPD, OPD, pharmacy, imaging - sab alag-alag bhej dein.\n\n' +
    '_Policy copy bhi file mein ho to policy ke terms usi se padh lunga - poochhna nahi padega._\n\n' +
    'Sab bhejne ke baad DONE.';
}

const TERM_LABEL = {
  sumInsured: 'Sum insured', roomRentLimitPerDay: 'Room limit /day', coPayPct: 'Co-pay',
  deductible: 'Deductible', sublimitAmount: 'Sub-limit', policyStartDate: 'Policy shuru'
};

function termLine(k, v) {
  if (k === 'coPayPct') { return TERM_LABEL[k] + ' ' + (Number(v) || 0) + '%'; }
  if (k === 'policyStartDate') { return TERM_LABEL[k] + ' ' + v; }
  return TERM_LABEL[k] + ' ' + rs(v);
}

/** Shown above the first question, so it is obvious what did NOT have to be asked. */
function tplReadFromFile(found, polNo) {
  if (!found || !found.length) { return null; }
  return '📄 File se padh liya' + (polNo ? ' (policy ' + polNo + ')' : '') + ':\n' +
    found.map(k => '• ' + TERM_LABEL[k]).join('\n') + '\n\nBas itna aur:';
}

function tplSavedTerms(polNo, t, alsoFound) {
  let s = '📄 Policy *' + polNo + '* ke terms pehle se save hain:\n\n';
  ['sumInsured', 'roomRentLimitPerDay', 'coPayPct', 'policyStartDate'].forEach(k => {
    if (t[k] != null) { s += termLine(k, t[k]) + '\n'; }
  });
  if (alsoFound && alsoFound.length) { s += '\n_(kuch is file se bhi mila)_\n'; }
  s += '\nYahi use karun?';
  return s;
}

function tplQuestion(q, prefix) {
  return (prefix ? prefix + '\n\n' : '') + q.q;
}

function tplAssumptions(p) {
  const known = [];
  if (p.sumInsured != null) { known.push('Sum insured ' + rs(p.sumInsured)); }
  known.push(p.roomRentLimitPerDay != null ? 'Room limit ' + rs(p.roomRentLimitPerDay) + '/day' : 'Room limit ❓ nahi pata');
  known.push('Co-pay ' + (Number(p.coPayPct) || 0) + '%');
  known.push(p.policyStartDate ? 'Policy shuru ' + p.policyStartDate : 'Policy start ❓ nahi pata');

  const assumed = ['Balance SI ' + rs(p.balanceSI), 'Deductible 0', 'Sub-limit 0'];
  if (p.pedCase !== 'HAAN') { assumed.push('PED case nahi'); }
  else { assumed.push('PED wait ' + (Number(p.pedWaitYears) || 0) + ' saal'); }

  let s = '✅ *Ho gaya.*\n\n' + known.join('\n') + '\n\n' +
    '_Maan liya:_ ' + assumed.join(' · ') + '\n' +
    '_Room rent bill se khud padh lunga._\n';
  if (!p.policyStartDate) { s += '\n⚠️ Policy start date bina waiting period check nahi hoga.\n'; }
  s += '\nAb *bill* bhejein - PDF ya saaf photo.\n' +
    'IPD, OPD, pharmacy, imaging - sab alag-alag.\n' +
    'Sab bhejne ke baad DONE.';
  return s;
}


function tplDocAck(count, lines, docType) {
  return '✅ Document ' + count + ' mil gaya' + (docType ? ' (' + docType.replace(/_/g, ' ') + ')' : '') + '\n' +
    (lines > 0 ? lines + ' bill lines nikalin.\n' : 'Ismein koi bill line nahi mili - shayad report hai.\n') +
    '\nAur bhejein, ya DONE likhein.';
}

const SEV_ICON = { blocker: '🔴', major: '🟠', watch: '🟡' };

// CGPE's own settled claims lose a median of 13.9% and an average of 26.1% (55 records in the
// claims register). The engine can only see the deductions printed on a bill - non-payables and
// the room-rent cut - so it predicted ~1-3% on real files. Presenting its figure as "what you
// will get" would be wrong; the honest framing is what to fix before submitting.
const REAL_MEDIAN_DEDUCTION = '13-26%';

/** Patient / hospital / dates, taken from whichever document actually carried them. */
function caseInfo(documents) {
  const out = {};
  (documents || []).forEach(d => {
    const s = d.structured || {};
    ['patient_name', 'patient_age', 'hospital_name', 'diagnosis', 'admission_date', 'discharge_date']
      .forEach(k => { if (out[k] == null && s[k] != null && s[k] !== '') { out[k] = s[k]; } });
  });
  return out;
}

function shortDate(d) {
  const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? m[3] + '/' + m[2] : String(d || '');
}

function daysBetween(a, b) {
  const t1 = Date.parse(a), t2 = Date.parse(b);
  if (!isFinite(t1) || !isFinite(t2) || t2 < t1) { return null; }
  return Math.round((t2 - t1) / 86400000);
}

/**
 * The case in plain words - what the patient had, what will not be counted and WHY, and what is
 * still missing. Ved's senior asked for this specifically: the earlier version reported totals
 * and a checklist, which reads like an audit sheet rather than an answer.
 */
function tplCaseSummary(info, lines, w) {
  let s = '';
  if (info.patient_name) {
    s += '📋 *' + info.patient_name + '*' + (info.patient_age ? ', ' + info.patient_age + ' saal' : '') + '\n';
  }
  if (info.hospital_name) { s += String(info.hospital_name).slice(0, 50) + '\n'; }
  if (info.diagnosis) { s += String(info.diagnosis).slice(0, 70) + '\n'; }
  const dys = daysBetween(info.admission_date, info.discharge_date);
  if (info.admission_date) {
    s += shortDate(info.admission_date) + ' → ' + shortDate(info.discharge_date) +
      (dys != null ? '  (' + dys + ' din)' : '') + '\n';
  }
  s += 'Bill ' + rs(w.totalBill) + '\n';

  // disallowed lines, grouped by WHY - one reason line instead of repeating it per item
  const np = lines.filter(l => l.non_payable);
  if (np.length) {
    const groups = {};
    np.forEach(l => {
      const r = engine.nonPayableReason(l.matched);
      (groups[r.key] = groups[r.key] || { text: r.text, items: [], total: 0 });
      groups[r.key].items.push(String(l.description).slice(0, 28));
      groups[r.key].total += Number(l.amount) || 0;
    });
    s += '\n❌ *YE COUNT NAHI HOGA* - ' + rs(w.nonPayableTotal) + '\n';
    Object.keys(groups).slice(0, 3).forEach(k => {
      const g = groups[k];
      s += '• ' + g.items.slice(0, 3).join(', ') + (g.items.length > 3 ? ' +' + (g.items.length - 3) : '') +
        '  ' + rs(g.total) + '\n  _' + g.text + '_\n';
    });
  }

  const payable = lines.filter(l => !l.non_payable).length;
  if (payable) { s += '\n✅ Baaki ' + payable + ' cheezein count hongi\n'; }
  return s;
}

/**
 * Leads with what a human has to go and DO, not with a settlement figure. The number stays,
 * because it is useful for setting expectations, but it is clearly not a promise.
 */
function tplResult(alerts, w, checklist, info, lines, params) {
  const blockers = alerts.filter(a => a.severity === 'blocker');
  const missingDocs = (checklist || []).filter(x => x.isDoc && x.status === 'No');

  let s = tplCaseSummary(info || {}, lines || [], w);

  // things worth knowing that are not simply a missing document
  const others = alerts.filter(a => a.kind !== 'missing_doc' && a.kind !== 'unverified' && a.severity !== 'watch');
  if (others.length) {
    s += '\n⚠️ *DHYAN DEIN*\n';
    others.slice(0, 3).forEach(a => { s += '• ' + a.issue + '\n'; });
    if (others.length > 3) { s += '_(+' + (others.length - 3) + ' aur)_\n'; }
  }

  if (missingDocs.length) {
    s += '\n📄 *FILE MEIN NAHI HAI* - client se mangwayein\n';
    missingDocs.slice(0, 6).forEach((x, i) => { s += (i + 1) + '. ' + x.label + '\n'; });
  }

  // Nothing is asked any more, so whatever could not be worked out has to be said out loud -
  // otherwise a clean-looking result implies those checks passed.
  const p = params || {};
  const unknown = [];
  if (!Number(p.roomRentLimitPerDay)) { unknown.push('room limit'); }
  if (p.coPayPct == null) { unknown.push('co-pay'); }
  if (!p.policyStartDate) { unknown.push('policy start date'); }
  if (unknown.length) {
    s += '\n❓ *YE PATA NAHI CHALA* - ' + unknown.join(', ') + '\n' +
      '_Inke bina room-rent katauti aur waiting period check nahi ho paaya._\n' +
      '_Pata ho to UPDATE POLICY dabayein._\n';
  }

  s += '\n' + (blockers.length ? '🔴 *ABHI SUBMIT MAT KAREIN*' : '✅ *File poori lag rahi hai*') + '\n';
  s += 'Motaa-motee claimable ' + rs(w.totalClaimable) + '\n';
  s += '_Ye pakka amount NAHI hai - TPA aur bhi kaat sakta hai (pichle claims mein ' +
    REAL_MEDIAN_DEDUCTION + ' tak)._';
  return s;
}

// Sent without buttons: a long breakdown would blow the ~1024-char interactive cap, and plain
// text allows 4096.
function tplBreakdown(lines, w, p) {
  let s = '*Line-by-line*\n';
  lines.forEach(l => {
    const tag = l.non_payable ? '❌ non-payable' : (l.room_linked ? '📉 room-linked' : '✅ payable');
    s += '\n' + String(l.description).slice(0, 40) + '\n  ' + rs(l.amount) + '  ' + tag +
      (l.confident === false ? '  ⚠️ confirm karein' : '');
  });
  s += '\n\n*Waterfall*\n' +
    'Total bill                ' + rs(w.totalBill) + '\n' +
    '(-) Non-payable           ' + rs(w.nonPayableTotal) + '\n' +
    '(-) Proportionate         ' + rs(w.proportionateDeduction) +
      (w.roomRentRatio < 1 ? '  (ratio ' + w.roomRentRatio.toFixed(3) + ')' : '') + '\n' +
    '(=) Admissible            ' + rs(w.admissible) + '\n';
  if (w.sublimitExcess > 0) { s += '(-) Sub-limit excess      ' + rs(w.sublimitExcess) + '\n'; }
  if (w.deductible > 0) { s += '(-) Deductible            ' + rs(w.deductible) + '\n'; }
  s += '(-) Co-pay ' + Math.round(w.coPayPct * 100) + '%             ' + rs(w.coPay) + '\n';
  if (w.cappedAtSI) { s += '(-) Balance SI se upar    ' + rs(w.netAdmissible - w.totalClaimable) + '\n'; }
  s += '(=) *CLAIMABLE*           ' + rs(w.totalClaimable);
  return s;
}

function rs(n) { return '₹' + fmt(n); }

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

function allowed(role) {
  return ALLOWED_ROLES.indexOf(String(role || '').toLowerCase().replace(/[^a-z_]/g, '')) !== -1;
}

function classifyAll(docs) {
  const out = [];
  (docs || []).forEach(d => {
    const s = (d && d.structured) || {};
    (s.bills || []).forEach(b => {
      const billType = String(b.bill_type || 'OTHER').toUpperCase();
      // Proportionate deduction exists only because a room was chosen above the policy limit.
      // On an OPD, pharmacy or imaging bill there is no room at all, so nothing on it can be
      // room-linked - whatever the wording says. Found on a real Breach Candy file, where
      // "CONSULTATION" on five OPD bills was being marked room-linked by the keyword list.
      const canBeRoomLinked = billType === 'IPD_MAIN';
      (b.lines || []).forEach(l => {
        // the model read the document, the keyword lists are the spec - combine both
        const c = engine.classifyLineItem(l.description, { non_payable: l.non_payable, room_linked: l.room_linked });
        const roomLinked = canBeRoomLinked && c.room_linked;
        out.push({
          description: l.description, amount: Number(l.amount) || 0,
          non_payable: c.non_payable, room_linked: roomLinked,
          // a clash about room-linkage is moot once the bill type has ruled it out
          confident: c.confident || (c.disagreement && !canBeRoomLinked && c.non_payable === false),
          matched: c.matched, source: c.source, disagreement: c.disagreement && !(!canBeRoomLinked && c.room_linked),
          llm: c.llm, keyword: c.keyword, bill_type: billType,
          bill_number: b.bill_number || ''
        });
      });
    });
  });
  return out;
}

/**
 * The actual room rent is never asked for - it is printed on the bill, and the model already
 * returns it. Falling back to the room-rent line's own amount would be wrong (that is the total
 * for the whole stay, not the per-day rate), so if neither is available the ratio stays 1 and
 * no proportionate cut is applied.
 */
function roomRentFromBill(documents) {
  const found = (documents || [])
    .map(d => Number((d.structured || {}).room_rent_per_day))
    .filter(v => isFinite(v) && v > 0);
  return found.length ? Math.max.apply(null, found) : null;
}

/** Per bill: what the bill says its total is, vs what the lines we read add up to. */
function billTotals(documents) {
  const out = [];
  (documents || []).forEach(d => {
    ((d.structured || {}).bills || []).forEach(b => {
      if (b.stated_total == null || b.stated_total === '') { return; }
      const summed = (b.lines || []).reduce((s, l) => s + (Number(l.amount) || 0), 0);
      out.push({ billType: b.bill_type || 'OTHER', billNumber: b.bill_number || '',
        stated: Number(b.stated_total) || 0, summed: summed,
        lineCount: (b.lines || []).length });
    });
  });
  return out;
}

/**
 * The same bill usually arrives twice: once summarised inside the big claim file and once
 * itemised in a separate one. Counting both inflates the claim - on Komal Sojitra's two files
 * it added Rs 7,700 of OPD consultations that exist only once in reality.
 *
 * A line is a duplicate when the amount matches AND the descriptions are the same once
 * punctuation, case and doctor/code suffixes are stripped. Amount alone is not enough - two
 * genuinely different charges can cost the same.
 */
function dedupeKey(l) {
  const d = String(l.description || '').toLowerCase()
    .replace(/\(.*?\)/g, ' ')              // "(999312)" style codes
    .replace(/\|\|.*$/, ' ')               // "|| Dr. Arun"
    .replace(/\bdr\.?\s+\S+/g, ' ')        // doctor names
    .replace(/[^a-z0-9]+/g, ' ').trim();
  const words = d.split(' ').filter(Boolean).sort().join(' ');
  return words + '#' + (Number(l.amount) || 0);
}

function dedupeLines(lines) {
  const seen = {}, out = [], dropped = [];
  lines.forEach(l => {
    // A bill number is the only reliable identity - the same bill is worded differently in a
    // summary ("OPD Consultation") than in the itemised copy ("OPD Consultation - Privilege
    // || Dr. Arun"), so text alone misses it.
    const bn = String(l.bill_number || '').trim();
    const k = bn ? ('bill#' + bn.toLowerCase() + '#' + (Number(l.amount) || 0)) : dedupeKey(l);
    if (seen[k]) { dropped.push(l); return; }
    seen[k] = true;
    out.push(l);
  });
  return { lines: out, dropped: dropped };
}


/**
 * The same amount appearing in two different uploaded files is almost always one bill sent
 * twice - once summarised, once itemised. Reported, never silently removed.
 */
function suspectedDuplicates(documents) {
  const byAmount = {};
  (documents || []).forEach((d, di) => {
    ((d.structured || {}).bills || []).forEach(b => {
      (b.lines || []).forEach(l => {
        const a = Number(l.amount) || 0;
        if (a <= 0) { return; }
        (byAmount[a] = byAmount[a] || []).push({ doc: di, description: l.description, amount: a });
      });
    });
  });
  const out = [];
  Object.keys(byAmount).forEach(a => {
    const hits = byAmount[a];
    const docs = {};
    hits.forEach(h => { docs[h.doc] = true; });
    if (Object.keys(docs).length > 1) { out.push(hits[0]); }
  });
  return out;
}

function review(session) {
  const p = withDefaults(session.policyParams || {});
  if (p.actualRoomRentPerDay == null) { p.actualRoomRentPerDay = roomRentFromBill(session.documents); }
  const dd = dedupeLines(classifyAll(session.documents));
  const lines = dd.lines;
  const waterfall = engine.computeWaterfall(p, lines);
  const checklist = engine.buildDocumentChecklist(
    (session.documents || []).map(d => d.structured || {}), p);
  const alerts = engine.buildAlerts({
    policyParams: p, waterfall: waterfall, lines: lines, checklist: checklist,
    billTotals: billTotals(session.documents),
    suspectedDuplicates: suspectedDuplicates(session.documents)
  });
  return { lines: lines, waterfall: waterfall, checklist: checklist, alerts: alerts,
    policyParams: p, duplicates: dd.dropped };
}

/**
 * handleClaimPrecheckFlow(msg, deps)
 *
 * msg  : { phoneLast10, role, text, media: {mediaId, mimeType, fileName} | null }
 * deps : { sessions, downloadMedia(media), extractStructured(buffer, mimeType) }
 *        `sessions` is a Mongo collection (or any object with findOne/updateOne).
 *
 * -> null | { reply, buttons, step }
 */
async function handleClaimPrecheckFlow(msg, deps) {
  const phone = String((msg && msg.phoneLast10) || '').slice(-10);
  const text = String((msg && msg.text) || '').trim();
  const media = (msg && msg.media) || null;
  if (!phone) { return null; }

  const sessions = deps.sessions;
  let session = await sessions.findOne({ phoneLast10: phone, status: 'active' });

  // A stale session must release the number rather than swallow unrelated messages forever.
  if (session && Date.now() - new Date(session.updatedAt || 0).getTime() > STALE_MS) {
    await sessions.updateOne({ phoneLast10: phone }, { $set: { status: 'abandoned', updatedAt: new Date().toISOString() } });
    session = null;
  }

  // ---- no session: only an explicit trigger starts one ----
  if (!session) {
    if (!TRIGGER.test(text)) { return null; }
    if (!allowed(msg.role)) {
      return { reply: 'Claim pre-check sirf CGPE team ke liye hai. Aap claim documents bhej sakte hain, hum check kar denge.', buttons: [] };
    }
    // The file comes FIRST now. Policy schedules are usually inside the claim file, so most of
    // the answers can be read rather than asked - and the team handles many claims a day.
    const now = new Date().toISOString();
    await sessions.updateOne({ phoneLast10: phone },
      { $set: { phoneLast10: phone, status: 'active', step: STEP.BILL, policyParams: {},
                documents: [], createdAt: now, updatedAt: now } }, { upsert: true });
    return { reply: tplAskForFile(), buttons: [BTN.CANCEL], step: STEP.BILL };
  }

  const touch = async patch => {
    patch.updatedAt = new Date().toISOString();
    await sessions.updateOne({ phoneLast10: phone }, { $set: patch });
  };

  if (isCancel(text)) {
    await touch({ status: 'abandoned' });
    return { reply: 'Pre-check band kar diya. Dobara shuru karna ho to "claim precheck" likhein.', buttons: [] };
  }

  // "claim precheck" during an open session means a NEW claim, not a continuation. Without this
  // the trigger was ignored and files from four different claims - including a different
  // patient's - piled into one session and were reported as a single claim.
  if (TRIGGER.test(text)) {
    const had = (session.documents || []).length;
    await touch({ status: 'abandoned' });
    const now = new Date().toISOString();
    await sessions.updateOne({ phoneLast10: phone },
      { $set: { phoneLast10: phone, status: 'active', step: STEP.BILL, policyParams: {},
                documents: [], profileOffered: false, createdAt: now, updatedAt: now } }, { upsert: true });
    return { reply: (had ? '🔄 *Naya claim shuru.* Pichle ' + had + ' document hata diye.\n\n' : '') + tplAskForFile(),
      buttons: [BTN.CANCEL], step: STEP.BILL };
  }

  // Produce the result, remembering this policy's terms for next time.
  const finish = async (params) => {
    const filled = withDefaults(params);
    const sess = Object.assign({}, session, { policyParams: filled });
    const r = review(sess);
    const polNo = policyNumberOf(sess.documents, filled);
    if (polNo && deps.profiles) {
      try {
        await deps.profiles.updateOne({ policyNumber: polNo },
          { $set: { policyNumber: polNo, insurer: filled.insurer || '', terms: filled,
                    phoneLast10: phone, updatedAt: new Date().toISOString() } }, { upsert: true });
      } catch (e) { /* remembering is a convenience; never fail the review over it */ }
    }
    await touch({ policyParams: filled, step: STEP.RESULT, lastWaterfall: r.waterfall, lastAlerts: r.alerts });
    return { reply: tplResult(r.alerts, r.waterfall, r.checklist, caseInfo(sess.documents), r.lines, filled), buttons: [BTN.BREAKDOWN, BTN.POLICY, BTN.CANCEL],
      step: STEP.RESULT, review: r };
  };

  // Ask the next unanswered question, or finish if there are none left.
  const askNextOrFinish = async (params) => {
    const pend = pendingQuestions(params);
    if (!pend.length) { return finish(params); }
    await touch({ policyParams: params, step: pend[0].step });
    return { reply: tplQuestion(pend[0]), buttons: pend[0].buttons || [], step: pend[0].step };
  };

  // ---- step: confirm the terms saved for this policy ----
  if (session.step === STEP.CONFIRM) {
    const t = buttonTitle(text).toUpperCase();
    if (t === 'BADLO' || /badlo|change/i.test(t)) {
      // start over on the terms, keeping the documents
      const fresh = { policyNumber: (session.policyParams || {}).policyNumber };
      return askNextOrFinish(fresh);
    }
    if (t === 'HAAN' || /haan|yes|ok/i.test(t)) { return finish(session.policyParams || {}); }
    return { reply: 'Saved terms use karun?', buttons: ['HAAN', 'BADLO', BTN.CANCEL], step: STEP.CONFIRM };
  }

  // ---- steps: the one-at-a-time questions ----
  const q = questionAt(session.step);
  if (q) {
    if (media) {
      return { reply: 'Pehle ye sawaal - phir aur file bhejein.\n\n' + q.q, buttons: q.buttons || [], step: q.step };
    }
    const ans = parseAnswer(q, text);
    if (!ans.ok) {
      return { reply: ans.why + '\n\n' + q.q, buttons: q.buttons || [], step: q.step };
    }
    const params = Object.assign({}, session.policyParams || {});
    params[q.key] = ans.value;
    return askNextOrFinish(params);
  }

  // ---- steps: collecting documents ----
  if (session.step === STEP.BILL || session.step === STEP.MORE || session.step === STEP.RESULT) {

    if (buttonTitle(text).toUpperCase() === BTN.POLICY) {
      const q0 = QUESTIONS[0];
      await touch({ step: q0.step, policyParams: {} });
      return { reply: tplQuestion(q0), buttons: q0.buttons || [], step: q0.step };
    }
    if (buttonTitle(text).toUpperCase() === BTN.RECHECK) {
      await touch({ step: STEP.MORE });
      return { reply: 'Theek hai. Naya ya corrected bill bhejein, ya policy badalni ho to UPDATE POLICY likhein. Phir DONE.',
        buttons: [BTN.POLICY, BTN.DONE, BTN.CANCEL], step: STEP.MORE };
    }
    if (buttonTitle(text).toUpperCase() === BTN.BREAKDOWN) {
      if (!(session.documents || []).length) {
        return { reply: 'Abhi koi bill nahi mila. Pehle bill bhejein.', buttons: [], step: session.step };
      }
      const r = review(session);
      return { reply: tplBreakdown(r.lines, r.waterfall, session.policyParams), buttons: [], step: session.step };
    }

    if (media) {
      const docs = session.documents || [];
      if (docs.length >= MAX_DOCS) {
        return { reply: 'Bahut saare documents ho gaye (' + MAX_DOCS + '). DONE likhein.', buttons: [BTN.DONE], step: session.step };
      }
      let structured = null, err = null;
      try {
        const file = await deps.downloadMedia(media);
        const ex = await deps.extractStructured(file.buffer, file.mimeType || media.mimeType);
        if (ex && ex.success) { structured = ex.data; } else { err = (ex && ex.error) || 'extraction failed'; }
      } catch (e) { err = e.message; }

      if (!structured) {
        return { reply: '⚠️ Yeh document padha nahi gaya (' + String(err).slice(0, 80) + ').\nDobara bhejein ya agla bhejein.',
          buttons: [BTN.DONE, BTN.CANCEL], step: session.step };
      }
      docs.push({ mediaId: media.mediaId, fileName: media.fileName || '', mimeType: media.mimeType || '', structured: structured });
      const nLines = (structured.bills || []).reduce((n, b) => n + ((b.lines || []).length), 0);
      await touch({ documents: docs, step: STEP.MORE });
      return { reply: tplDocAck(docs.length, nLines, structured.doc_type), buttons: [BTN.DONE, BTN.CANCEL], step: STEP.MORE };
    }

    if (isDone(text)) {
      const docs = session.documents || [];
      if (!docs.length) {
        return { reply: 'Abhi tak koi file nahi mili. Claim file bhejein (PDF ya photo).', buttons: [BTN.CANCEL], step: session.step };
      }
      // Read whatever the documents give us, then look for terms saved from an earlier claim on
      // the same policy, and only then ask about what is still missing.
      const merged = termsFromDocuments(docs, session.policyParams || {});
      let params = merged.params;

      const polNo = policyNumberOf(docs, params);
      if (polNo && deps.profiles && !session.profileOffered) {
        let saved = null;
        try { saved = await deps.profiles.findOne({ policyNumber: polNo }); } catch (e) { saved = null; }
        if (saved && saved.terms) {
          const use = Object.assign({}, saved.terms, params, { policyNumber: polNo });
          await touch({ policyParams: use, step: STEP.CONFIRM, profileOffered: true });
          return { reply: tplSavedTerms(polNo, use, merged.found),
            buttons: ['HAAN', 'BADLO', BTN.CANCEL], step: STEP.CONFIRM };
        }
      }
      await touch({ profileOffered: true });
      // NOTHING is asked. Everything the tool is actually good at - missing documents, wrong
      // dates, disallowed items, a bill total that does not add up, the same bill counted twice
      // - needs no policy terms at all. Only the room-rent cut and the co-pay do, and those are
      // simply left out and declared when the terms are unknown. Asking six questions per claim
      // meant nobody would use it.
      return finish(params);
    }

    // anything else while a session is open
    return { reply: 'Bill bhejein, ya DONE likhein. Band karna ho to CANCEL.',
      buttons: [BTN.DONE, BTN.CANCEL], step: session.step };
  }

  return null;
}

module.exports = {
  buttonTitle: buttonTitle,
  handleClaimPrecheckFlow: handleClaimPrecheckFlow,
  caseInfo: caseInfo,
  dedupeLines: dedupeLines,
  parseAnswer: parseAnswer,
  termsFromDocuments: termsFromDocuments,
  pendingQuestions: pendingQuestions,
  policyNumberOf: policyNumberOf,
  withDefaults: withDefaults,
  QUESTIONS: QUESTIONS,
  classifyAll: classifyAll,
  review: review,
  COLLECTION: COLLECTION,
  STEP: STEP,
  BTN: BTN,
  TRIGGER: TRIGGER,
  STALE_MS: STALE_MS,
  ALLOWED_ROLES: ALLOWED_ROLES,
  _templates: { tplQuestion, tplAskForFile, tplSavedTerms, tplReadFromFile, tplAssumptions, tplDocAck, tplResult, tplBreakdown }
};
