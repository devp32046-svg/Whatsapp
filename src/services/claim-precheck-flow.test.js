'use strict';
/**
 * Drives the whole conversation with in-memory fakes - no Mongo, no WhatsApp, no Gemini - so the
 * state transitions can be checked before anything is wired to a live number.
 * Run: node src/services/claim-precheck-flow.test.js
 */
const flow = require('./claim-precheck-flow');
const { handleClaimPrecheckFlow: handle, parseAnswer, withDefaults, QUESTIONS, BTN, STEP } = flow;

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? '   ' + String(extra).slice(0, 90) : '')); }
}

function coll() {
  const store = {};
  const key = q => q.phoneLast10 || q.policyNumber;
  return {
    store: store,
    async findOne(q) {
      const d = store[key(q)];
      if (!d) { return null; }
      if (q.status && d.status !== q.status) { return null; }
      return JSON.parse(JSON.stringify(d));
    },
    async updateOne(q, upd) { store[key(q)] = Object.assign({}, store[key(q)] || {}, upd.$set || {}); }
  };
}

const IPD_LINES = [
  { description: 'Room rent (5 days @ 8,000)', amount: 40000, non_payable: false, room_linked: true },
  { description: 'Nursing charges', amount: 15000, non_payable: false, room_linked: true },
  { description: 'Surgeon fee', amount: 60000, non_payable: false, room_linked: true },
  { description: 'OT charges', amount: 20000, non_payable: false, room_linked: true },
  { description: 'Investigations / diagnostics', amount: 25000, non_payable: false, room_linked: false },
  { description: 'Medicines / pharmacy', amount: 30000, non_payable: false, room_linked: false },
  { description: 'Consumables / gloves (non-medical)', amount: 8000, non_payable: true, room_linked: false },
  { description: 'Attendant / food charges', amount: 2000, non_payable: true, room_linked: false }
];
// the worked example, with the room rent printed on the bill and no policy schedule in the file
const BILL_ONLY = {
  doc_type: 'itemized_bill', patient_name: 'Rajesh Kumar', has_full_itemized_breakup: true,
  admission_date: '2026-06-01', discharge_date: '2026-06-06', implant_used: false,
  room_rent_per_day: 8000,
  bills: [{ bill_type: 'IPD_MAIN', stated_total: 200000, lines: IPD_LINES }]
};
// the same file, but with the policy schedule inside it
const BILL_WITH_POLICY = Object.assign({}, BILL_ONLY, {
  policy_terms: { policy_number: 'POL-999/2022', insurer: 'Oriental', sum_insured: 500000,
    room_rent_limit_per_day: 5000, co_pay_pct: 10, deductible: 0, sublimit: 0,
    policy_start_date: '01/04/2022' }
});

function deps(structured, failExtract) {
  return {
    sessions: coll(), profiles: coll(),
    async downloadMedia() { return { buffer: Buffer.from('x'), mimeType: 'application/pdf' }; },
    async extractStructured() {
      if (failExtract) { return { success: false, error: 'Gemini 503' }; }
      return { success: true, data: structured || BILL_ONLY };
    }
  };
}

const ADMIN = { phoneLast10: '9601775061', role: 'admin' };
const say = (d, text, media) => handle(Object.assign({}, ADMIN, { text: text || '', media: media || null }), d);
const PDF = { mediaId: 'm1', mimeType: 'application/pdf', fileName: 'bill.pdf' };
const GAP_ANSWERS = ['5 lakh', '5000', '10', '01/04/2022', 'pc0 (NAHI)', 'pc0 (NAHI)'];

// --- 1. answer parsing -----------------------------------------------------
console.log('\n1. answer parsing');
const qNum = QUESTIONS[0], qRoom = QUESTIONS[1], qDate = QUESTIONS[3], qChoice = QUESTIONS[4];
ok('plain number', parseAnswer(qNum, '500000').value === 500000);
ok('indian commas', parseAnswer(qNum, '5,00,000').value === 500000);
ok('rupee sign', parseAnswer(qNum, '₹500000').value === 500000);
ok('words rejected', parseAnswer(qNum, 'pata nahi').ok === false);
// "5 lakh" parsed as 5 on the first real WhatsApp run, capping the whole claim at Rs 5.
ok('5 lakh', parseAnswer(qNum, '5 lakh').value === 500000);
ok('5lakh', parseAnswer(qNum, '5lakh').value === 500000);
ok('5 lac', parseAnswer(qNum, '5 lac').value === 500000);
ok('5L', parseAnswer(qNum, '5L').value === 500000);
ok('5.5 lakh', parseAnswer(qNum, '5.5 lakh').value === 550000);
ok('1 crore', parseAnswer(qNum, '1 crore').value === 10000000);
ok('1.2 cr', parseAnswer(qNum, '1.2 cr').value === 12000000);
ok('implausibly small SI rejected', parseAnswer(qNum, '5').ok === false);
ok('and it says why', /pura amount/i.test(parseAnswer(qNum, '5').why));
ok('co-pay 10 is a percent, not an amount', parseAnswer(QUESTIONS[2], '10').value === 10);
ok('SKIP where offered', parseAnswer(qRoom, 'SKIP').value === null);
ok('SKIP refused where not offered', parseAnswer(qNum, 'SKIP').ok === false);
ok('date parsed', parseAnswer(qDate, '01/04/2022').value === '01/04/2022');
ok('bad date rejected', parseAnswer(qDate, 'april 2022').ok === false);
ok('tapped choice', parseAnswer(qChoice, 'pc0 (PATA NAHI)').value === 'PATA NAHI');
ok('typed choice', parseAnswer(qChoice, 'nahi').value === 'NAHI');
ok('junk choice rejected', parseAnswer(qChoice, 'maybe later').ok === false);

// --- 1b. OPD bills can never be room-linked --------------------------------
console.log('\n1b. OPD bills can never be room-linked');
const opd = flow.classifyAll([{ structured: { bills: [
  { bill_type: 'OPD', lines: [
    { description: 'Dr. SHIRISH M HASTAK (CONSULTATION)', amount: 5750, non_payable: false, room_linked: false },
    { description: 'REGISTRATION FEES', amount: 150, non_payable: true, room_linked: false } ] },
  { bill_type: 'IPD_MAIN', lines: [
    { description: 'Doctor visit charges', amount: 9000, non_payable: false, room_linked: true } ] },
  { bill_type: 'PHARMACY', lines: [
    { description: 'Nursing charges', amount: 1000, non_payable: false, room_linked: false } ] }
] } }]);
const byDesc = {}; opd.forEach(l => { byDesc[l.description] = l; });
ok('OPD consultation not room-linked', byDesc['Dr. SHIRISH M HASTAK (CONSULTATION)'].room_linked === false);
ok('OPD registration still non-payable', byDesc['REGISTRATION FEES'].non_payable === true);
ok('IPD doctor visit stays room-linked', byDesc['Doctor visit charges'].room_linked === true);
ok('pharmacy never room-linked', byDesc['Nursing charges'].room_linked === false);
ok('no phantom clash on OPD', byDesc['Dr. SHIRISH M HASTAK (CONSULTATION)'].disagreement === false);

// --- 1c. printed total vs the lines we read --------------------------------
console.log('\n1c. printed total vs the lines we read');
function totalsAlerts(stated, lines) {
  const docs = [{ structured: { bills: [{ bill_type: 'IPD_MAIN', bill_number: 'B1', stated_total: stated, lines: lines }] } }];
  return flow.review({ policyParams: { sumInsured: 500000 }, documents: docs }).alerts;
}
ok('totals match -> no alert',
  !totalsAlerts(50000, [{ description: 'Surgery', amount: 30000 }, { description: 'Room rent', amount: 20000 }])
    .some(a => /likha total/.test(a.issue)));
const missingPage = totalsAlerts(200000, [{ description: 'Surgery', amount: 30000 }]);
ok('big gap -> blocker', missingPage.some(a => a.severity === 'blocker' && /likha total/.test(a.issue)));
ok('gap says a bill is missing', missingPage.some(a => /file mein nahi hai/.test(a.action)));
ok('small gap -> major', totalsAlerts(50400, [{ description: 'Surgery', amount: 50000 }])
  .some(a => a.severity === 'major' && /likha total/.test(a.issue)));
ok('paise rounding ignored', !totalsAlerts(50000.38, [{ description: 'Surgery', amount: 50000 }])
  .some(a => /likha total/.test(a.issue)));
ok('double-counted lines caught',
  totalsAlerts(30000, [{ description: 'Surgery', amount: 30000 }, { description: 'Surgery', amount: 30000 }])
    .some(a => /do baar gin/.test(a.action)));
ok('no printed total -> no false alarm', !totalsAlerts(null, [{ description: 'Surgery', amount: 30000 }])
  .some(a => /likha total/.test(a.issue)));
// the real 51 MB Breach Candy file came back as one line per bill - a summary, not an itemisation
const lump = totalsAlerts(439631, [{ description: 'Hospital bill', amount: 439631 }]);
ok('lump-sum bill is a blocker', lump.some(a => a.severity === 'blocker' && /lump-sum/.test(a.issue)));
ok('small single-line bill is fine', !totalsAlerts(2700, [{ description: 'Consultation', amount: 2700 }])
  .some(a => /lump-sum/.test(a.issue)));

// --- 2. defaults -----------------------------------------------------------
console.log('\n2. defaults');
const dflt = withDefaults({ sumInsured: 500000, exclusionStatus: 'NAHI' });
ok('balance SI defaults to sum insured', dflt.balanceSI === 500000);
ok('deductible defaults to 0', dflt.deductible === 0);
ok('NAHI -> exclusion 0', dflt.exclusionStatus === 0);
ok('PATA NAHI -> 2 (stays Pending)', withDefaults({ exclusionStatus: 'PATA NAHI' }).exclusionStatus === 2);
ok('unanswered exclusion -> 2, never a pass', withDefaults({}).exclusionStatus === 2);
ok('ICU limit is gone', QUESTIONS.every(q => q.key !== 'icuLimitPerDay'));
ok('actual room rent never asked', QUESTIONS.every(q => q.key !== 'actualRoomRentPerDay'));

(async () => {
  // --- 3. file first, then straight to the answer ---------------------------
  console.log('\n3. file in, answer out - nothing is asked');
  const d = deps();
  ok('unrelated message ignored', (await say(d, 'kitne claims hain')) === null);

  const r1 = await say(d, 'claim precheck');
  ok('trigger asks for the file', /Claim file bhejein/.test(r1.reply));

  const rDoc = await say(d, '', PDF);
  ok('bill accepted', /8 bill lines/.test(rDoc.reply), rDoc.reply);

  const result = await say(d, 'DONE');
  ok('DONE goes straight to the result', result.step === STEP.RESULT);
  ok('nothing is asked', !/kitna hai\?|kitni hai\?|kitne %/.test(result.reply), result.reply.slice(0, 70));
  ok('leads with the case', /YE COUNT NAHI HOGA/.test(result.reply));
  ok('explains WHY a line is disallowed', /IRDAI ki non-payable list|Attendant/.test(result.reply));
  ok('lists what to fetch', /FILE MEIN NAHI HAI/.test(result.reply));
  ok('says what it could not work out', /YE PATA NAHI CHALA/.test(result.reply), result.reply);
  ok('names room limit as unknown', /room limit/.test(result.reply));
  ok('offers UPDATE POLICY', result.buttons.indexOf(BTN.POLICY) !== -1);
  ok('no room limit -> no proportionate cut', /1,90,000/.test(result.reply), result.reply);
  ok('number is not sold as a promise', /pakka amount NAHI hai/.test(result.reply));

  const brk = await say(d, 'pc0 (VIEW BREAKDOWN)');
  ok('breakdown works', /Line-by-line/.test(brk.reply));

  const upd = await say(d, 'pc1 (UPDATE POLICY)');
  ok('UPDATE POLICY still lets terms be given', /Sum insured kitna hai/.test(upd.reply));

  console.log('\n4. policy schedule in the file -> terms come from it');
  const dp = deps(BILL_WITH_POLICY);
  await say(dp, 'claim precheck');
  await say(dp, '', PDF);
  const pFinal = await say(dp, 'DONE');
  ok('still no questions', pFinal.step === STEP.RESULT);
  ok('terms read from the file are used', /1,25,437/.test(pFinal.reply), pFinal.reply);
  ok('nothing reported as unknown', !/YE PATA NAHI CHALA/.test(pFinal.reply), pFinal.reply);
  ok('profile remembered for next time', !!dp.profiles.store['POL-999/2022']);
  ok('profile stores the terms', dp.profiles.store['POL-999/2022'].terms.sumInsured === 500000);

  // --- 5. a repeat claim on the same policy --------------------------------
  console.log('\n5. repeat claim on the same policy -> one tap');
  const d2 = deps(BILL_WITH_POLICY);
  d2.profiles.store['POL-999/2022'] = { policyNumber: 'POL-999/2022',
    terms: { sumInsured: 500000, roomRentLimitPerDay: 5000, coPayPct: 10,
             policyStartDate: '01/04/2022', pedCase: 'NAHI', exclusionStatus: 0,
             deductible: 0, sublimitAmount: 0 } };
  await say(d2, 'claim precheck');
  await say(d2, '', PDF);
  const offer = await say(d2, 'DONE');
  ok('offers the saved terms', /pehle se save hain/.test(offer.reply), offer.reply);
  ok('shows them', /5,00,000/.test(offer.reply) && /10%/.test(offer.reply));
  ok('HAAN / BADLO buttons', offer.buttons.indexOf('HAAN') !== -1 && offer.buttons.indexOf('BADLO') !== -1);
  const oneTap = await say(d2, 'pc0 (HAAN)');
  ok('one tap -> straight to the result', oneTap.step === STEP.RESULT);
  ok('and the numbers are right', /1,25,437/.test(oneTap.reply), oneTap.reply);

  const d3 = deps(BILL_WITH_POLICY);
  d3.profiles.store['POL-999/2022'] = { policyNumber: 'POL-999/2022',
    terms: { sumInsured: 300000, roomRentLimitPerDay: 3000, coPayPct: 20 } };
  await say(d3, 'claim precheck');
  await say(d3, '', PDF);
  await say(d3, 'DONE');
  const changed = await say(d3, 'pc1 (BADLO)');
  ok('BADLO re-asks from the top', /Sum insured kitna hai/.test(changed.reply), changed.reply);

  // Four claims - including a different patient's - piled into one session on the first real
  // multi-claim run, because the trigger was ignored while a session was open.
  console.log('\n5b. "claim precheck" again starts a FRESH claim');
  const dnew = deps();
  await say(dnew, 'claim precheck');
  await say(dnew, '', PDF);
  await say(dnew, '', PDF);
  ok('two documents in', dnew.sessions.store['9601775061'].documents.length === 2);
  const again2 = await say(dnew, 'claim precheck');
  ok('trigger starts over', /Naya claim shuru/.test(again2.reply), again2.reply);
  ok('old documents dropped', dnew.sessions.store['9601775061'].documents.length === 0);
  ok('says how many were dropped', /Pichle 2 document/.test(again2.reply));
  ok('back at the file step', again2.step === STEP.BILL);

  // two patients in one review means two claims got mixed - every number above is meaningless
  const mixed = require('./claim-review-engine');
  const mixedList = mixed.buildDocumentChecklist([
    { doc_type: 'claim_form', patient_name: 'Komal Sojitra' },
    { doc_type: 'itemized_bill', patient_name: 'Jadav Haribhai Riziya' }], {});
  const mixedAlerts = mixed.buildAlerts({ policyParams: {},
    waterfall: { totalBill: 0, nonPayableTotal: 0, totalClaimable: 0 }, lines: [], checklist: mixedList });
  ok('different patients -> blocker', mixedAlerts.some(a => a.severity === 'blocker' && /NAAM ALAG/.test(a.issue)));
  ok('and said only once', mixedAlerts.filter(a => /naam|name/i.test(a.issue)).length === 1);

  // --- 6. guards -----------------------------------------------------------
  console.log('\n6. guards');
  const dc = deps();
  ok('client refused', /sirf CGPE team/.test(
    (await handle({ phoneLast10: '9999999999', role: 'client', text: 'claim precheck' }, dc)).reply));

  const dnodoc = deps();
  await say(dnodoc, 'claim precheck');
  ok('DONE with no file is refused', /koi file nahi mili/.test((await say(dnodoc, 'DONE')).reply));

  const dbad = deps();
  await say(dbad, 'claim precheck');
  await say(dbad, '', PDF);
  await say(dbad, 'DONE');
  await say(dbad, 'pc1 (UPDATE POLICY)');      // questions only exist behind this button now
  const retry = await say(dbad, 'bahut sara');
  ok('bad answer re-asks the same question', /Sirf number likhein/.test(retry.reply) && /Sum insured/.test(retry.reply));
  ok('bad answer does not advance', retry.step === QUESTIONS[0].step);

  // terms supplied by hand, but room limit and start date skipped
  const dskip = deps();
  await say(dskip, 'claim precheck');
  await say(dskip, '', PDF);
  await say(dskip, 'DONE');
  await say(dskip, 'pc1 (UPDATE POLICY)');
  await say(dskip, '5 lakh');
  await say(dskip, 'SKIP');          // no room limit
  await say(dskip, '0');
  await say(dskip, 'SKIP');          // no policy start date
  await say(dskip, 'pc0 (NAHI)');
  const skipped = await say(dskip, 'pc0 (NAHI)');
  ok('no room limit -> no proportionate cut', /1,90,000/.test(skipped.reply), skipped.reply);
  ok('skipped date -> reported as not worked out', /YE PATA NAHI CHALA/.test(skipped.reply) &&
    /policy start date/.test(skipped.reply), skipped.reply);
  ok('and not said twice', (skipped.reply.match(/policy start date/g) || []).length === 1);

  const dcan = deps();
  await say(dcan, 'claim precheck');
  ok('cancel confirms', /band kar diya/.test((await say(dcan, 'pc2 (CANCEL)')).reply));
  ok('cancel releases the number', (await say(dcan, 'hello bot')) === null);

  const dstale = deps();
  await say(dstale, 'claim precheck');
  dstale.sessions.store['9601775061'].updatedAt = new Date(Date.now() - flow.STALE_MS - 1000).toISOString();
  ok('stale session falls through', (await say(dstale, 'random')) === null);

  const dfail = deps(null, true);
  await say(dfail, 'claim precheck');
  ok('extraction failure survivable', /padha nahi gaya/.test((await say(dfail, '', PDF)).reply));

  // --- 7. WhatsApp limits --------------------------------------------------
  console.log('\n7. WhatsApp limits');
  ok('every question under 1024', QUESTIONS.every(q => q.q.length <= 1024));
  ok('ask-for-file under 1024', r1.reply.length <= 1024, 'len=' + r1.reply.length);
  ok('result under 1024', result.reply.length <= 1024, 'len=' + result.reply.length);
  ok('saved-terms offer under 1024', offer.reply.length <= 1024, 'len=' + offer.reply.length);
  ok('breakdown under 4096', brk.reply.length <= 4096, 'len=' + brk.reply.length);
  ok('never more than 3 buttons', [r1, rDoc, result, offer].every(x => (x.buttons || []).length <= 3));
  ok('button titles <= 20 chars',
    [].concat(rDoc.buttons, result.buttons, offer.buttons).every(b => b.length <= 20));

  console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASSED' : pass + ' passed, ' + fail + ' FAILED'));
  process.exit(fail === 0 ? 0 : 1);
})();
