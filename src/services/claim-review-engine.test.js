'use strict';
/**
 * The waterfall is the cheapest place to catch a math bug, so it is pinned to the worked example
 * in calculation-logic.md before anything is wired to it. Run: node src/services/claim-review-engine.test.js
 */
const { classifyLineItem, computeWaterfall, buildDocumentChecklist, buildAlerts, formatINR } = require('./claim-review-engine');

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = got === want;
  if (ok) { pass++; } else { fail++; }
  console.log('  ' + (ok ? 'PASS ' : 'FAIL ') + label.padEnd(42) + 'got=' + got + (ok ? '' : '   want=' + want));
}

// --------------------------------------------------------------------------
console.log('\n1. worked example - calculation-logic.md');
// Rs 5,00,000 SI, eligible room 5,000/day, co-pay 10%, no deductible, no sub-limit,
// patient took an 8,000/day room for 5 days.
const POLICY = {
  sumInsured: 500000, balanceSI: 500000,
  roomRentLimitPerDay: 5000, icuLimitPerDay: 10000, actualRoomRentPerDay: 8000,
  coPayPct: 0.10, deductible: 0, sublimitAmount: 0, proportionateApplicable: true
};
const LINES = [
  { description: 'Room rent (5 days @ 8,000)', amount: 40000, non_payable: false, room_linked: true },
  { description: 'Nursing charges', amount: 15000, non_payable: false, room_linked: true },
  { description: 'Surgeon fee', amount: 60000, non_payable: false, room_linked: true },
  { description: 'OT charges', amount: 20000, non_payable: false, room_linked: true },
  { description: 'Investigations / diagnostics', amount: 25000, non_payable: false, room_linked: false },
  { description: 'Medicines / pharmacy', amount: 30000, non_payable: false, room_linked: false },
  { description: 'Consumables / gloves (non-medical)', amount: 8000, non_payable: true, room_linked: false },
  { description: 'Attendant / food charges', amount: 2000, non_payable: true, room_linked: false }
];
const w = computeWaterfall(POLICY, LINES);
eq('total bill', w.totalBill, 200000);
eq('non-payable removed', w.nonPayableTotal, 10000);
eq('after non-payable', w.afterNonPayable, 190000);
eq('room rent ratio', w.roomRentRatio, 0.625);
eq('proportionate deduction', w.proportionateDeduction, 50625);
eq('admissible', w.admissible, 139375);
eq('co-pay 10%', w.coPay, 13938);
eq('TOTAL CLAIMABLE', w.totalClaimable, 125437);
eq('TOTAL NON-CLAIMABLE', w.totalNonClaimable, 74563);
eq('biggest deduction is proportionate', w.biggestDeduction && w.biggestDeduction.label,
  'Room-rent proportionate deduction');
eq('biggest deduction amount', w.biggestDeduction && w.biggestDeduction.amount, 50625);

// --------------------------------------------------------------------------
console.log('\n2. classification - the same 8 lines must self-classify');
LINES.forEach(l => {
  const c = classifyLineItem(l.description);
  eq(l.description.slice(0, 34) + ' np', c.non_payable, l.non_payable);
  eq(l.description.slice(0, 34) + ' rl', c.room_linked, l.room_linked);
});

// --------------------------------------------------------------------------
console.log('\n3. the traps non-payable-items.md warns about');
const traps = [
  ['Implant - titanium hip stent', false, false],      // never non-payable by reflex
  ['OT consumables (surgical package)', false, false], // consumable word, but a payable exception
  ['Prescribed diet as advised', false, false],        // patient diet is payable, attendant food is not
  ['Pharmacy - medicines administered', false, false], // exempt from proportionate deduction
  ['Diagnostics - MRI brain', false, false],
  ['Ambulance charges', false, false],
  ['Attendant food charges', true, false],
  ['Telephone and TV charges', true, false],
  ['Registration / admission fee', true, false],
  ['Anaesthetist charges', false, true],
  ['ICU charges per day', false, true],
  ['Doctor visit charges', false, true]
];
traps.forEach(t => {
  const c = classifyLineItem(t[0]);
  eq(t[0].slice(0, 34) + ' np', c.non_payable, t[1]);
  eq(t[0].slice(0, 34) + ' rl', c.room_linked, t[2]);
});

// --------------------------------------------------------------------------
console.log('\n4. edge cases');
const noRoomCap = computeWaterfall(
  Object.assign({}, POLICY, { roomRentLimitPerDay: 0, actualRoomRentPerDay: 0 }), LINES);
eq('no room cap -> ratio 1', noRoomCap.roomRentRatio, 1);
eq('no room cap -> no proportionate cut', noRoomCap.proportionateDeduction, 0);

const roomWithinLimit = computeWaterfall(
  Object.assign({}, POLICY, { actualRoomRentPerDay: 4000 }), LINES);
eq('room within limit -> ratio 1', roomWithinLimit.roomRentRatio, 1);

const propOff = computeWaterfall(
  Object.assign({}, POLICY, { proportionateApplicable: 'No' }), LINES);
eq('proportionate=No -> ratio 1', propOff.roomRentRatio, 1);

const lowSI = computeWaterfall(Object.assign({}, POLICY, { balanceSI: 50000 }), LINES);
eq('capped at balance SI', lowSI.totalClaimable, 50000);
eq('cappedAtSI flag', lowSI.cappedAtSI, true);

const withDeductible = computeWaterfall(Object.assign({}, POLICY, { deductible: 25000 }), LINES);
eq('deductible before co-pay', withDeductible.afterDeductible, 114375);
eq('co-pay on post-deductible amt', withDeductible.coPay, 11438);

const withSublimit = computeWaterfall(Object.assign({}, POLICY, { sublimitAmount: 100000 }), LINES);
eq('sub-limit excess', withSublimit.sublimitExcess, 39375);
eq('after sub-limit', withSublimit.afterSublimit, 100000);

eq('co-pay typed as "10" not 0.10',
  computeWaterfall(Object.assign({}, POLICY, { coPayPct: 10 }), LINES).coPay, 13938);
eq('empty bill is safe', computeWaterfall(POLICY, []).totalClaimable, 0);

// --------------------------------------------------------------------------
console.log('\n5. document checklist');
const DOCS = [
  { doc_type: 'discharge_summary', patient_name: 'Rajesh Kumar', admission_date: '2026-06-01', discharge_date: '2026-06-06' },
  { doc_type: 'itemized_bill', patient_name: 'Rajesh Kumar', has_full_itemized_breakup: true, implant_used: false,
    bills: [{ bill_type: 'IPD_MAIN', lines: [{ description: 'Room rent', amount: 40000 }, { description: 'Nursing', amount: 15000 }] }] },
  { doc_type: 'claim_form', patient_name: 'Rajesh Kumar' }
];
const cl = buildDocumentChecklist(DOCS);
const byKey = {};
cl.forEach(x => { byKey[x.key] = x; });
eq('discharge summary present', byKey.discharge_summary.status, 'Yes');
eq('itemized bill present', byKey.itemized_bill.status, 'Yes');
eq('payment receipt missing', byKey.payment_receipt.status, 'No');
eq('pharmacy bill missing', byKey.pharmacy_bill.status, 'No');
eq('implant NA when unused', byKey.implant_invoice.status, 'NA');
eq('name consistent', byKey.name_consistent.status, 'Yes');
eq('dates consistent', byKey.dates_consistent.status, 'Yes');
eq('stay > 24h', byKey.duration.status, 'Yes');
eq('waiting period unverifiable', byKey.waiting_period.status, 'Pending');

const mismatch = buildDocumentChecklist([
  { doc_type: 'claim_form', patient_name: 'Rajes Kumar' },
  { doc_type: 'kyc', patient_name: 'Rajesh Kumar' }
]);
eq('name mismatch caught', mismatch.filter(x => x.key === 'name_consistent')[0].status, 'No');

// a real defect seen in test-claim-ocr.pdf: discharge printed before admission
const reversed = buildDocumentChecklist([
  { doc_type: 'claim_form', patient_name: 'X', admission_date: '2026-07-08', discharge_date: '2026-07-05' }
]);
const revBy = {};
reversed.forEach(x => { revBy[x.key] = x; });
eq('reversed dates caught', revBy.dates_consistent.status, 'No');
eq('reversed dates message', /PEHLE hai/.test(revBy.dates_consistent.action), true);
eq('duration stays Pending, not "short stay"', revBy.duration.status, 'Pending');

const dayCare = buildDocumentChecklist([
  { doc_type: 'claim_form', admission_date: '2026-07-05', discharge_date: '2026-07-05' }
]);
eq('same-day stay flagged', dayCare.filter(x => x.key === 'duration')[0].status, 'No');

// --------------------------------------------------------------------------
console.log('\n6. alerts');
const alerts = buildAlerts({ policyParams: POLICY, waterfall: w,
  lines: LINES.map(l => Object.assign({ confident: true }, l)), checklist: cl });
const sev = s => alerts.filter(a => a.severity === s);
eq('missing core docs -> one blocker', sev('blocker').length, 1);
eq('that blocker names them all', /payment receipt/i.test(sev('blocker')[0].issue) && /pharmacy/i.test(sev('blocker')[0].issue), true);
eq('big proportionate cut is major', sev('major').some(a => /proportionate/i.test(a.issue)), true);
eq('non-payable is a watch', sev('watch').some(a => /non-payable/i.test(a.issue)), true);
eq('unverifiable checks reported', sev('watch').some(a => /verify nahi/i.test(a.issue)), true);
eq('blockers sort first', alerts[0].severity, 'blocker');

const lowSIAlerts = buildAlerts({ policyParams: POLICY, waterfall: lowSI, lines: [], checklist: [] });
eq('over sum insured is major', lowSIAlerts.some(a => a.severity === 'major' && /sum insured/i.test(a.issue)), true);

const unsure = buildAlerts({ policyParams: POLICY, waterfall: w, checklist: [],
  lines: [{ description: 'Misc hospital charge XYZ', amount: 12000, confident: false }] });
eq('unclassified big line -> watch', unsure.some(a => /classify nahi hui/.test(a.issue)), true);

const unsureSmall = buildAlerts({ policyParams: POLICY, waterfall: w, checklist: [],
  lines: [{ description: 'Misc', amount: 200, confident: false }] });
eq('unclassified small line ignored', unsureSmall.some(a => /classify nahi hui/.test(a.issue)), false);

// --------------------------------------------------------------------------
console.log('\n8. two judges - keyword list vs the model that read the document');
// agreement
const agree = classifyLineItem('Attendant food charges', { non_payable: true, room_linked: false });
eq('agreement -> confident', agree.confident, true);
eq('agreement keeps the verdict', agree.non_payable, true);

// the rulebook wins a clash, but the clash is surfaced
const clash = classifyLineItem('Attendant food charges', { non_payable: false, room_linked: false });
eq('clash -> rulebook wins', clash.non_payable, true);
eq('clash -> not confident', clash.confident, false);
eq('clash flagged', clash.disagreement, true);
eq('clash keeps the model opinion', clash.llm.non_payable, false);

// wording the lists cannot cover - the model fills the gap
const novel = classifyLineItem('Bio-medical waste handling charge', { non_payable: true, room_linked: false });
eq('llm fills a gap', novel.non_payable, true);
eq('llm-sourced is marked', novel.source, 'llm');
eq('llm-only is still confident', novel.confident, true);

const nobody = classifyLineItem('Charge XYZ-42');
eq('nobody knows -> payable by default', nobody.non_payable, false);
eq('nobody knows -> not confident', nobody.confident, false);

const roomClash = classifyLineItem('Nursing charges', { non_payable: false, room_linked: false });
eq('room-linked clash -> rulebook wins', roomClash.room_linked, true);
eq('room-linked clash flagged', roomClash.disagreement, true);

// the model must never drag an IRDAI-exempt item into the proportionate cut
const pharmaClash = classifyLineItem('Medicines / pharmacy', { non_payable: false, room_linked: true });
eq('pharmacy stays exempt', pharmaClash.room_linked, false);

const clashAlerts = buildAlerts({ policyParams: POLICY, waterfall: w, checklist: [],
  lines: [{ description: 'Attendant food charges', amount: 9000, non_payable: true,
            disagreement: true, confident: false, llm: { non_payable: false, room_linked: false },
            keyword: { non_payable: true, room_linked: false } }] });
eq('disagreement raises a watch', clashAlerts.some(a => /AI ne non-payable kaha|AI aur rulebook/.test(a.issue)), true);

// --------------------------------------------------------------------------
console.log('\n9. waiting period & exclusion - now actually checked');
const admitted = d => [{ doc_type: 'claim_form', admission_date: d }];

const served = buildDocumentChecklist(admitted('2026-06-01'),
  { policyStartDate: '01/04/2022', pedWaitYears: 0, exclusionStatus: 0 });
const servedBy = {}; served.forEach(x => { servedBy[x.key] = x; });
eq('waiting period served', servedBy.waiting_period.status, 'Yes');
eq('exclusion answered no', servedBy.not_excluded.status, 'Yes');
eq('policy active', servedBy.policy_active.status, 'Yes');

const tooSoon = buildDocumentChecklist(admitted('2026-06-01'),
  { policyStartDate: '20/05/2026', pedWaitYears: 0, exclusionStatus: 0 });
const soonBy = {}; tooSoon.forEach(x => { soonBy[x.key] = x; });
eq('30-day wait not served', soonBy.waiting_period.status, 'No');
eq('30-day wait explained', /initial waiting period/.test(soonBy.waiting_period.action), true);

const pedShort = buildDocumentChecklist(admitted('2026-06-01'),
  { policyStartDate: '01/04/2024', pedWaitYears: 4, exclusionStatus: 0 });
eq('PED wait not served', pedShort.filter(x => x.key === 'waiting_period')[0].status, 'No');
const pedOk = buildDocumentChecklist(admitted('2026-06-01'),
  { policyStartDate: '01/04/2020', pedWaitYears: 4, exclusionStatus: 0 });
eq('PED wait served', pedOk.filter(x => x.key === 'waiting_period')[0].status, 'Yes');

const excluded = buildDocumentChecklist(admitted('2026-06-01'),
  { policyStartDate: '01/04/2022', pedWaitYears: 0, exclusionStatus: 1 });
eq('exclusion answered yes -> No', excluded.filter(x => x.key === 'not_excluded')[0].status, 'No');

const dunno = buildDocumentChecklist(admitted('2026-06-01'),
  { policyStartDate: '01/04/2022', pedWaitYears: 0, exclusionStatus: 2 });
eq('exclusion unknown stays Pending', dunno.filter(x => x.key === 'not_excluded')[0].status, 'Pending');

const noDate = buildDocumentChecklist(admitted('2026-06-01'), { pedWaitYears: 0, exclusionStatus: 0 });
eq('no policy date -> Pending, not a pass', noDate.filter(x => x.key === 'waiting_period')[0].status, 'Pending');

// these must be BLOCKERs, not buried as "missing document" majors
const waitAlerts = buildAlerts({ policyParams: {}, waterfall: w, lines: [], checklist: tooSoon });
eq('waiting period is a blocker', waitAlerts.some(a => a.severity === 'blocker' && /Waiting period/.test(a.issue)), true);
const exAlerts = buildAlerts({ policyParams: {}, waterfall: w, lines: [], checklist: excluded });
eq('exclusion is a blocker', exAlerts.some(a => a.severity === 'blocker' && /exclusion/i.test(a.issue)), true);

// --------------------------------------------------------------------------
console.log('\n7. Indian number format');
eq('125437 -> 1,25,437', formatINR(125437), '1,25,437');
eq('74563 -> 74,563', formatINR(74563), '74,563');
eq('500 -> 500', formatINR(500), '500');
eq('10000000 -> 1,00,00,000', formatINR(10000000), '1,00,00,000');

// --------------------------------------------------------------------------
console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASSED' : pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
