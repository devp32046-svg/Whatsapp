'use strict';
/**
 * Health claim pre-submission review - the business logic, ported from the health-claim-review
 * skill (calculation-logic.md, non-payable-items.md, document-checklist.md).
 *
 * Deliberately pure: no I/O, no require of anything. The arithmetic must not be left to an LLM,
 * and keeping this file dependency-free means the same code can run in the Node service, in a
 * test, or pasted into an n8n Code node (which disallows every module).
 *
 * Validated against the worked example in calculation-logic.md:
 *   Rs 2,00,000 bill -> Rs 1,25,437 claimable / Rs 74,563 non-claimable.
 */

// ---------------------------------------------------------------------------
// A. Line classification
// ---------------------------------------------------------------------------

// Checked FIRST. non-payable-items.md is explicit that these must not be flagged non-payable by
// reflex just because they sound incidental.
const PAYABLE_EXCEPTIONS = [
  'implant', 'stent', 'prosthes', 'prosthetic', 'graft',
  'ot consumable', 'surgical consumable', 'procedure consumable',
  'prescribed diet', 'patient diet', 'diet as advised',
  'pharmacy administered', 'medicine administered'
];

const NON_PAYABLE_KEYWORDS = [
  'baby food', 'baby utility',
  'attendant', 'visitor', 'extra bed', 'companion',
  'beauty', 'cosmetic', 'hair removal', 'hairdye', 'hair dye',
  'telephone', 'television', ' tv ', 'internet', 'newspaper',
  'toiletr', 'toothpaste', 'toothbrush', 'tooth brush', 'soap', 'comb', 'slipper', 'powder',
  'laundry',
  'mineral water', 'packaged water', 'drinking water',
  'documentation', 'medical record', 'record charge',
  'administrat', 'admin charge', 'admission charge', 'admission fee',
  'registration',
  'surcharge', 'service charge',
  'glove', 'mask', 'ppe', 'apron', 'cap charge',
  'vitamin', 'tonic',
  'sanitary', 'diaper', 'napkin',
  'thermometer', 'bp monitor', 'nebuliser mask', 'nebulizer mask', 'take home', 'take-home',
  'swab', 'lancet', 'bed bath', 'wipes'
];

const ROOM_LINKED_KEYWORDS = [
  'room rent', 'room charge', 'bed charge', 'ward charge', 'icu', 'iccu', 'hdu',
  'nursing',
  'surgeon', 'consultant', 'doctor visit', 'physician visit', 'visiting charge', 'consultation',
  'ot charge', 'operation theatre', 'operation theater', 'theatre charge',
  'anaesthet', 'anesthet'
];

// Explicitly exempt per IRDAI - these do not scale with room category. Checked before the
// room-linked list so e.g. "pharmacy consultation kit" cannot be dragged in by "consultation".
const NOT_ROOM_LINKED_KEYWORDS = [
  'medicine', 'pharmacy', 'drug',
  'implant', 'stent', 'prosthes',
  'diagnostic', 'investigation', 'laborator', 'lab charge', 'patholog', 'radiolog',
  'x-ray', 'xray', 'mri', 'ct scan', 'usg', 'ultrasound', 'ecg', 'echo',
  'consumable',
  'ambulance'
];

// Why a line was disallowed, in words a client can be shown. Keyed by the keyword that matched,
// so the explanation always corresponds to the actual reason the rule fired - not a guess.
const NON_PAYABLE_REASON = {
  consumable: 'IRDAI ki non-payable list mein - koi bhi policy inhe nahi deti',
  admin: 'Administrative charge hai, ilaaj ka hissa nahi',
  lifestyle: 'Aaram/suvidha ka kharcha hai, ilaaj ka nahi',
  attendant: 'Attendant/visitor ka kharcha - policy sirf patient ka deti hai',
  takehome: 'Ghar le jaane wali cheez hai, hospital ke ilaaj ka hissa nahi',
  other: 'Policy is tarah ke kharche nahi deti'
};

const REASON_OF = {
  glove: 'consumable', mask: 'consumable', ppe: 'consumable', apron: 'consumable',
  swab: 'consumable', lancet: 'consumable', wipes: 'consumable', 'bed bath': 'consumable',
  'cap charge': 'consumable', sanitary: 'consumable', diaper: 'consumable', napkin: 'consumable',
  registration: 'admin', 'admission charge': 'admin', 'admission fee': 'admin',
  'admin charge': 'admin', administrat: 'admin', documentation: 'admin',
  'medical record': 'admin', 'record charge': 'admin', surcharge: 'admin', 'service charge': 'admin',
  telephone: 'lifestyle', television: 'lifestyle', ' tv ': 'lifestyle', internet: 'lifestyle',
  newspaper: 'lifestyle', laundry: 'lifestyle', toiletr: 'lifestyle', toothpaste: 'lifestyle',
  toothbrush: 'lifestyle', 'tooth brush': 'lifestyle', soap: 'lifestyle', comb: 'lifestyle',
  slipper: 'lifestyle', powder: 'lifestyle', 'mineral water': 'lifestyle',
  'packaged water': 'lifestyle', 'drinking water': 'lifestyle', beauty: 'lifestyle',
  cosmetic: 'lifestyle', 'hair removal': 'lifestyle', 'baby food': 'lifestyle',
  'baby utility': 'lifestyle',
  attendant: 'attendant', visitor: 'attendant', 'extra bed': 'attendant', companion: 'attendant',
  thermometer: 'takehome', 'bp monitor': 'takehome', 'take home': 'takehome',
  'take-home': 'takehome', 'nebuliser mask': 'takehome', 'nebulizer mask': 'takehome',
  vitamin: 'other', tonic: 'other'
};

/** -> {key, text} for a disallowed line, based on which keyword actually fired. */
function nonPayableReason(matched) {
  const key = REASON_OF[String(matched || '')] || 'other';
  return { key: key, text: NON_PAYABLE_REASON[key] };
}

function norm(s) {
  // pad so that ' tv ' style boundary keywords can match at the ends too
  return ' ' + String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
}

function hit(text, list) {
  for (let i = 0; i < list.length; i++) {
    if (text.indexOf(list[i]) !== -1) { return list[i]; }
  }
  return null;
}

/**
 * classifyLineItem(description, hint) -> { non_payable, room_linked, confident, source, disagreement }
 *
 * Two independent opinions are combined. The keyword lists are the spec written down, so they win
 * whenever they have an opinion; `hint` is what the model that actually read the document thought,
 * and it fills the gaps the lists cannot cover (hospitals invent their own bill-head wording).
 *
 * Neither is trusted silently: a disagreement, or no opinion at all, sets confident=false so the
 * line is surfaced to a human rather than quietly folded into the total.
 */
function classifyLineItem(description, hint) {
  const t = norm(description);

  const exception = hit(t, PAYABLE_EXCEPTIONS);
  const npHit = exception ? null : hit(t, NON_PAYABLE_KEYWORDS);
  const exempt = hit(t, NOT_ROOM_LINKED_KEYWORDS);
  const rlHit = (npHit || exempt) ? null : hit(t, ROOM_LINKED_KEYWORDS);

  const kwHasNpView = !!(exception || npHit);
  const kwHasRlView = !!(exempt || rlHit || npHit);
  const kwNonPayable = !!npHit;
  const kwRoomLinked = !!rlHit;

  const h = hint && typeof hint === 'object' ? hint : null;
  const hNonPayable = h && typeof h.non_payable === 'boolean' ? h.non_payable : null;
  const hRoomLinked = h && typeof h.room_linked === 'boolean' ? h.room_linked : null;

  let nonPayable, rlFinal, npSource, rlSource;

  if (kwHasNpView) { nonPayable = kwNonPayable; npSource = 'keyword'; }
  else if (hNonPayable !== null) { nonPayable = hNonPayable; npSource = 'llm'; }
  else { nonPayable = false; npSource = 'default'; }

  if (nonPayable) { rlFinal = false; rlSource = npSource; }
  else if (kwHasRlView) { rlFinal = kwRoomLinked; rlSource = 'keyword'; }
  else if (hRoomLinked !== null) { rlFinal = hRoomLinked; rlSource = 'llm'; }
  else { rlFinal = false; rlSource = 'default'; }

  const npDisagree = kwHasNpView && hNonPayable !== null && hNonPayable !== kwNonPayable;
  const rlDisagree = !nonPayable && kwHasRlView && hRoomLinked !== null && hRoomLinked !== kwRoomLinked;
  const disagreement = npDisagree || rlDisagree;

  // "no opinion at all" is the dangerous case - a line nobody could place is being silently
  // treated as an ordinary payable charge.
  const anyOpinion = kwHasNpView || kwHasRlView || hNonPayable !== null || hRoomLinked !== null;

  return {
    non_payable: nonPayable,
    room_linked: rlFinal,
    confident: !disagreement && anyOpinion,
    // whichever judge decided the operative verdict - the rulebook counts even when it only had
    // a view on room-linkage, otherwise a keyword-decided line reads as "the AI told us"
    source: (kwHasNpView || kwHasRlView) ? 'keyword' : (anyOpinion ? 'llm' : 'default'),
    disagreement: disagreement,
    // what the other opinion was, so a human can see both sides
    llm: h ? { non_payable: hNonPayable, room_linked: hRoomLinked } : null,
    keyword: kwHasNpView || kwHasRlView ? { non_payable: kwNonPayable, room_linked: kwRoomLinked } : null,
    matched: exception || npHit || rlHit || exempt || null
  };
}

// ---------------------------------------------------------------------------
// B. The deduction waterfall (calculation-logic.md, steps 1-8)
// ---------------------------------------------------------------------------

function num(v) {
  const n = Number(String(v == null ? 0 : v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? n : 0;
}

// The skill's config writes co-pay as a fraction (0.10); humans type "10". Both must work, and
// 1 is ambiguous - treat it as 1% rather than 100%, since a 100% co-pay is not a real policy.
function coPayFraction(v) {
  const n = num(v);
  if (n <= 0) { return 0; }
  const f = n > 1 ? n / 100 : n;
  // A bad answer once produced coPayPct 5000, which the waterfall happily turned into a
  // claimable of MINUS Rs 2.33 crore. Garbage in must not become a confident wrong number.
  return Math.min(1, f);
}

/**
 * computeWaterfall(policyParams, classifiedLines) -> every intermediate total.
 *
 * classifiedLines: [{ description, amount, non_payable, room_linked }]
 * Rounding is per line, matching the workbook's ROUND($G*ratio,0) per row.
 */
function computeWaterfall(policyParams, classifiedLines) {
  const p = policyParams || {};
  const lines = Array.isArray(classifiedLines) ? classifiedLines : [];

  const eligibleRoom = num(p.roomRentLimitPerDay);
  const actualRoom = num(p.actualRoomRentPerDay);
  const proportionateOn = p.proportionateApplicable === undefined ? true
    : (p.proportionateApplicable === true || String(p.proportionateApplicable).toLowerCase() === 'yes');

  // 1. total of every billed line
  const totalBill = lines.reduce((s, l) => s + num(l.amount), 0);

  // 2. non-payable items removed in full
  const nonPayableTotal = lines.filter(l => l.non_payable).reduce((s, l) => s + num(l.amount), 0);
  const afterNonPayable = totalBill - nonPayableTotal;

  // 3. room-rent cap via proportionate deduction, applied ONLY to room-linked charges
  const ratio = (proportionateOn && actualRoom > eligibleRoom && eligibleRoom > 0)
    ? eligibleRoom / actualRoom : 1;
  const admissible = lines
    .filter(l => !l.non_payable)
    .reduce((s, l) => s + (l.room_linked ? Math.round(num(l.amount) * ratio) : num(l.amount)), 0);
  const proportionateDeduction = afterNonPayable - admissible;

  // 4. procedure / disease sub-limit
  const sublimit = num(p.sublimitAmount);
  const sublimitExcess = sublimit > 0 ? Math.max(0, admissible - sublimit) : 0;
  const afterSublimit = admissible - sublimitExcess;

  // 5. deductible
  const deductible = num(p.deductible);
  const deductibleApplied = Math.min(deductible, afterSublimit);
  const afterDeductible = Math.max(0, afterSublimit - deductible);

  // 6. co-pay, charged on what remains after the deductible
  const coPayPct = coPayFraction(p.coPayPct);
  const coPay = Math.round(coPayPct * afterDeductible);
  const netAdmissible = Math.max(0, afterDeductible - coPay);

  // 7. cap at the balance sum insured
  const balanceSI = num(p.balanceSI) || num(p.sumInsured);
  const capped = balanceSI > 0 && netAdmissible > balanceSI;
  const totalClaimable = Math.max(0, capped ? balanceSI : netAdmissible);
  const siCapDeduction = capped ? netAdmissible - balanceSI : 0;

  // 8. the patient's out-of-pocket
  const totalNonClaimable = totalBill - totalClaimable;

  const deductions = [
    { key: 'non_payable', label: 'Non-payable / non-medical items', amount: nonPayableTotal },
    { key: 'proportionate', label: 'Room-rent proportionate deduction', amount: proportionateDeduction },
    { key: 'sublimit', label: 'Sub-limit excess', amount: sublimitExcess },
    { key: 'deductible', label: 'Deductible', amount: deductibleApplied },
    { key: 'copay', label: 'Co-payment', amount: coPay },
    { key: 'si_cap', label: 'Above balance sum insured', amount: siCapDeduction }
  ];
  const biggest = deductions.slice().sort((a, b) => b.amount - a.amount)[0];

  return {
    totalBill: totalBill,
    nonPayableTotal: nonPayableTotal,
    afterNonPayable: afterNonPayable,
    roomRentRatio: ratio,
    proportionateDeduction: proportionateDeduction,
    admissible: admissible,
    sublimitExcess: sublimitExcess,
    afterSublimit: afterSublimit,
    deductible: deductibleApplied,
    afterDeductible: afterDeductible,
    coPayPct: coPayPct,
    coPay: coPay,
    netAdmissible: netAdmissible,
    balanceSI: balanceSI,
    cappedAtSI: capped,
    totalClaimable: totalClaimable,
    totalNonClaimable: totalNonClaimable,
    deductions: deductions,
    biggestDeduction: biggest && biggest.amount > 0 ? { label: biggest.label, amount: biggest.amount } : null
  };
}

// ---------------------------------------------------------------------------
// C. Pre-submission document checklist (document-checklist.md)
// ---------------------------------------------------------------------------

// `doc` is the doc_type that satisfies the item; `required` mirrors the workbook's Required?
// column. Items with no doc_type can only be answered from data we do not collect yet - they
// stay Pending and are reported as a gap rather than silently passed.
const CHECKS = [
  { key: 'claim_form', item: 'Duly filled & signed claim form', doc: 'claim_form', required: 'Yes' },
  { key: 'discharge_summary', item: 'Discharge summary (diagnosis & treatment)', doc: 'discharge_summary', required: 'Yes' },
  { key: 'itemized_bill', item: 'Final itemized hospital bill (with break-up)', doc: 'itemized_bill', required: 'Yes' },
  { key: 'payment_receipt', item: 'Hospital payment receipts', doc: 'payment_receipt', required: 'Yes' },
  { key: 'investigation', item: 'All investigation / diagnostic reports', doc: 'investigation_report', required: 'Yes' },
  { key: 'prescription', item: "Doctor's prescriptions / treatment sheet", doc: 'prescription', required: 'Yes' },
  { key: 'pharmacy_bill', item: 'Pharmacy bills matching prescriptions', doc: 'pharmacy_bill', required: 'Yes' },
  { key: 'implant_invoice', item: 'Implant invoice + sticker / barcode (if used)', doc: 'implant_invoice', required: 'If implant' },
  { key: 'kyc', item: 'Patient KYC / photo ID', doc: 'kyc', required: 'Yes' },
  { key: 'bank', item: 'Cancelled cheque / bank details (NEFT)', doc: null, required: 'Yes' },
  { key: 'mlc', item: 'MLC / FIR copy (accident cases)', doc: null, required: 'NA' },
  { key: 'preauth', item: 'Pre-authorisation / cashless letter (if any)', doc: null, required: 'NA' },
  { key: 'prev_consult', item: 'Previous consultation papers (PED / chronic)', doc: null, required: 'NA' },
  { key: 'name_consistent', item: 'Patient name consistent across all documents', doc: null, required: 'Yes' },
  { key: 'dates_consistent', item: 'Admission & discharge dates consistent', doc: null, required: 'Yes' },
  { key: 'diagnosis_match', item: 'Diagnosis matches treatment & investigations', doc: null, required: 'Yes' },
  { key: 'duration', item: 'Hospitalisation > 24 hrs or listed day-care', doc: null, required: 'Yes' },
  { key: 'signatures', item: 'Signatures & hospital stamp on bill & summary', doc: null, required: 'Yes' },
  { key: 'policy_active', item: 'Policy active on date of admission', doc: null, required: 'Yes' },
  { key: 'waiting_period', item: 'Waiting period / PED clause satisfied', doc: null, required: 'Yes' },
  { key: 'not_excluded', item: 'Treatment not in exclusion list', doc: null, required: 'Yes' },
  { key: 'si_sufficient', item: 'Sum insured / balance sufficient', doc: null, required: 'Yes' },
  { key: 'room_eligible', item: 'Room category within eligibility', doc: null, required: 'Yes' }
];

// Checks that stay unanswerable from what the conversation collects. waiting_period,
// not_excluded and policy_active moved OUT of this list once the flow started asking for the
// policy inception date, the PED waiting period and an explicit exclusion answer - the skill
// rates the first two BLOCKER, so guessing them was not acceptable.
const UNVERIFIABLE = ['bank', 'signatures', 'diagnosis_match', 'mlc', 'preauth', 'prev_consult'];

// Short names for the "ask the client for this" list - the checklist wording is written for an
// audit sheet and reads badly as an instruction on WhatsApp.
const DOC_LABEL = {
  claim_form: 'Claim form (bhara hua, signed)',
  discharge_summary: 'Discharge summary',
  itemized_bill: 'Itemized hospital bill (break-up ke saath)',
  payment_receipt: 'Hospital payment receipt',
  investigation: 'Saari investigation / lab reports',
  prescription: 'Doctor ki prescriptions',
  pharmacy_bill: 'Pharmacy bills',
  implant_invoice: 'Implant invoice + sticker',
  kyc: 'Patient ka KYC / photo ID'
};

const DAY = 24 * 3600 * 1000;
const INITIAL_WAIT_DAYS = 30;    // standard initial waiting period, accidents excepted

function parseDate(v) {
  if (!v) { return NaN; }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) { return Date.UTC(+m[1], +m[2] - 1, +m[3]); }
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);   // DD/MM/YYYY - Indian order
  if (m) { return Date.UTC(+m[3], +m[2] - 1, +m[1]); }
  const t = Date.parse(s);
  return isFinite(t) ? t : NaN;
}

function uniq(arr) {
  const seen = {}, out = [];
  arr.forEach(v => { const k = String(v); if (v != null && v !== '' && !seen[k]) { seen[k] = 1; out.push(v); } });
  return out;
}

function nameKey(s) { return String(s || '').toLowerCase().replace(/[^a-z]/g, ''); }

/**
 * buildDocumentChecklist(structuredDocs) -> [{key, item, status, required, action}]
 * status: Yes | No | NA | Pending
 */
function buildDocumentChecklist(structuredDocs, policyParams) {
  const docs = Array.isArray(structuredDocs) ? structuredDocs : [];
  const pp = policyParams || {};
  const types = {};
  docs.forEach(d => {
    const t = String((d && d.doc_type) || '').toLowerCase();
    if (t && t !== 'other' && t !== 'mixed') { types[t] = true; }
    // a "mixed" page can still carry the bill, so trust the itemisation flag too
    if (d && d.has_full_itemized_breakup) { types.itemized_bill = true; }
    if (d && Array.isArray(d.bills)) {
      d.bills.forEach(b => {
        const bt = String((b && b.bill_type) || '').toUpperCase();
        if (bt === 'PHARMACY') { types.pharmacy_bill = true; }
        if (bt === 'IPD_MAIN' && Array.isArray(b.lines) && b.lines.length > 1) { types.itemized_bill = true; }
      });
    }
  });

  const implantUsed = docs.some(d => d && d.implant_used === true);
  const names = uniq(docs.map(d => d && d.patient_name).filter(Boolean));
  const adm = uniq(docs.map(d => d && d.admission_date).filter(Boolean));
  const dis = uniq(docs.map(d => d && d.discharge_date).filter(Boolean));

  return CHECKS.map(c => {
    let status = 'Pending';
    let action = '';

    if (c.doc) {
      if (c.key === 'implant_invoice' && !implantUsed) {
        status = 'NA';
      } else {
        status = types[c.doc] ? 'Yes' : 'No';
        if (status === 'No') { action = c.item + ' file mein nahi mila - hospital se lein'; }
      }
    } else if (c.key === 'name_consistent') {
      if (names.length === 0) { status = 'Pending'; }
      else if (uniq(names.map(nameKey)).length === 1) { status = 'Yes'; }
      else { status = 'No'; action = 'Naam alag-alag hai: ' + names.join(' / ') + ' - correction karwayein'; }
    } else if (c.key === 'dates_consistent') {
      const a0 = adm[0] ? Date.parse(adm[0]) : NaN;
      const d0 = dis[0] ? Date.parse(dis[0]) : NaN;
      if (adm.length === 0 && dis.length === 0) { status = 'Pending'; }
      else if (isFinite(a0) && isFinite(d0) && d0 < a0) {
        // A discharge before the admission is a data error, not a short stay - say the right thing
        status = 'No';
        action = 'Discharge date (' + dis[0] + ') admission (' + adm[0] + ') se PEHLE hai - hospital se correction lein';
      }
      else if (adm.length <= 1 && dis.length <= 1) { status = 'Yes'; }
      else { status = 'No'; action = 'Admission/discharge dates documents mein alag hain - milaayein'; }
    } else if (c.key === 'duration') {
      const a = adm[0] ? Date.parse(adm[0]) : NaN;
      const d = dis[0] ? Date.parse(dis[0]) : NaN;
      // leave this to the dates_consistent check when the dates are reversed
      if (isFinite(a) && isFinite(d) && d >= a) {
        status = (d - a) >= 24 * 3600 * 1000 ? 'Yes' : 'No';
        if (status === 'No') { action = 'Stay 24 ghante se kam - day-care procedure ka justification chahiye'; }
      }
    } else if (c.key === 'waiting_period') {
      // Two separate waits: the standard 30-day initial one, and the policy's PED wait when the
      // user has said this admission is for a pre-existing condition.
      const start = parseDate(pp.policyStartDate);
      const admit = parseDate(adm[0]);
      const pedYears = Number(pp.pedWaitYears);
      if (!isFinite(start) || !isFinite(admit)) { status = 'Pending'; action = 'Policy start date ya admission date nahi mili'; }
      else if (admit < start) { status = 'No'; action = 'Admission policy shuru hone se PEHLE hai - cover nahi hoga'; }
      else if (admit - start < INITIAL_WAIT_DAYS * DAY) {
        status = 'No';
        action = '30-din ka initial waiting period poora nahi hua (policy ' + pp.policyStartDate + ', admission ' + adm[0] + ') - sirf accident cover hoga';
      } else if (pedYears > 0 && (admit - start) < pedYears * 365 * DAY) {
        status = 'No';
        const done = Math.floor((admit - start) / (365 * DAY) * 10) / 10;
        action = 'PED waiting period ' + pedYears + ' saal ka hai, abhi ' + done + ' saal hue - PED claim reject ho sakta hai';
      } else { status = 'Yes'; }
    } else if (c.key === 'not_excluded') {
      const ex = String(pp.exclusionStatus == null ? '' : pp.exclusionStatus);
      if (ex === '1' || ex === 'yes') { status = 'No'; action = 'Treatment exclusion list mein hai - claim pass nahi hoga'; }
      else if (ex === '0' || ex === 'no') { status = 'Yes'; }
      else { status = 'Pending'; action = 'Policy wording se exclusion list check karein'; }
    } else if (c.key === 'policy_active') {
      const start = parseDate(pp.policyStartDate);
      const admit = parseDate(adm[0]);
      if (!isFinite(start) || !isFinite(admit)) { status = 'Pending'; }
      else { status = admit >= start ? 'Yes' : 'No'; if (status === 'No') { action = 'Admission date policy start se pehle hai'; } }
    } else if (c.key === 'si_sufficient') {
      status = 'Pending';   // decided by the waterfall, reported there
    } else if (c.key === 'room_eligible') {
      const lim = Number(pp.roomRentLimitPerDay), act = Number(pp.actualRoomRentPerDay);
      if (!lim || !act) { status = 'Pending'; }
      else { status = act <= lim ? 'Yes' : 'No'; if (status === 'No') { action = 'Room limit se upar - proportionate deduction lagega'; } }
    } else if (UNVERIFIABLE.indexOf(c.key) !== -1) {
      status = 'Pending';
      action = 'Bot yeh verify nahi kar sakta - manually check karein';
    }
    // isDoc marks the ones a human can actually go and fetch - they become the "ask the client
    // for this" list, which is the whole point of a pre-submission check.
    return { key: c.key, item: c.item, status: status, required: c.required, action: action,
      isDoc: !!c.doc, label: DOC_LABEL[c.key] || c.item };
  });
}

// ---------------------------------------------------------------------------
// D. Alerts (SKILL.md step 4a - blocker / major / watch)
// ---------------------------------------------------------------------------

// A proportionate cut this large is the thing most worth telling the patient about, since a room
// within limit would have avoided most of it.
const BIG_DEDUCTION_PCT = 0.10;
const WATCH_LINE_AMOUNT = 5000;
// a single line worth this much is a summary bill, not an itemisation
const LUMP_SUM_LIMIT = 25000;

/**
 * buildAlerts({ policyParams, waterfall, lines, checklist }) -> [{severity, issue, action}]
 * Sorted blocker -> major -> watch.
 */
function buildAlerts(ctx) {
  const c = ctx || {};
  const p = c.policyParams || {};
  const w = c.waterfall || {};
  const lines = Array.isArray(c.lines) ? c.lines : [];
  const checklist = Array.isArray(c.checklist) ? c.checklist : [];
  const out = [];
  // `kind` lets the WhatsApp template drop alerts it has already shown as a "fetch this" item,
  // instead of listing the same missing document twice in one message.
  const add = (severity, issue, action, kind) =>
    out.push({ severity: severity, issue: issue, action: action, kind: kind || 'other' });

  // --- blockers: a missing core document stops the claim being paid ---
  const CORE = {
    itemized_bill: 'Itemized hospital bill (break-up ke saath)',
    payment_receipt: 'Hospital payment receipt',
    pharmacy_bill: 'Pharmacy bills',
    discharge_summary: 'Discharge summary',
    claim_form: 'Claim form'
  };
  // One combined blocker, not one per document: four near-identical "missing" lines push the
  // money issues below the fold, and it is the same single action either way.
  const missingCore = checklist.filter(x => x.status === 'No' && CORE[x.key]).map(x => CORE[x.key]);
  if (missingCore.length) {
    add('blocker',
      missingCore.length === 1
        ? missingCore[0] + ' file mein nahi hai'
        : missingCore.length + ' zaroori documents file mein nahi hain: ' + missingCore.join(', '),
      'Submit karne se pehle file mein lagayein', 'missing_doc');
  }
  // The skill rates these BLOCKER: no document can fix a waiting period that has not run, or a
  // treatment the policy excludes.
  const POLICY_BLOCKERS = {
    waiting_period: 'Waiting period poora nahi hua',
    not_excluded: 'Treatment exclusion list mein hai',
    policy_active: 'Policy admission date pe active nahi thi'
  };
  checklist.filter(x => x.status === 'No' && POLICY_BLOCKERS[x.key]).forEach(x => {
    add('blocker', POLICY_BLOCKERS[x.key], x.action || 'Policy wording check karein');
  });

  // Two different patients' files in one review is not a "mismatch" to note further down - it
  // means two claims got mixed together, and every number above it is meaningless. Ved's test
  // ended up with Jadav Haribhai Riziya's bills inside Komal Sojitra's claim.
  const nameCheck = checklist.filter(x => x.key === 'name_consistent')[0];
  if (nameCheck && nameCheck.status === 'No') {
    add('blocker', 'Documents mein PATIENT KE NAAM ALAG hain - shayad do alag claim mil gaye',
      nameCheck.action || 'Har claim alag se check karein - "claim precheck" likh kar naya shuru karein');
  }
  checklist.filter(x => x.status === 'No' && !CORE[x.key] && !POLICY_BLOCKERS[x.key] && x.key !== 'room_eligible' && x.key !== 'name_consistent').forEach(x => {
    add('major', x.item + ' - missing ya mismatch', x.action || 'Theek karke dobara check karein',
      x.isDoc ? 'missing_doc' : 'other');
  });

  // Waiting period and exclusions are BLOCKER-class checks. When one could not be run, say so at
  // major - as a watch it fell below the five-alert cutoff and vanished, which reads exactly like
  // "we checked and it was fine".
  const wp = checklist.filter(x => x.key === 'waiting_period')[0];
  if (wp && wp.status === 'Pending') {
    add('major', 'Waiting period check nahi ho paaya - policy start date nahi mili',
      'Policy ki pehli start date daalein, ya manually check karein', 'unverified');
  }
  const ex = checklist.filter(x => x.key === 'not_excluded')[0];
  if (ex && ex.status === 'Pending') {
    add('major', 'Exclusion check nahi ho paaya',
      'Policy wording se confirm karein ki ye treatment excluded to nahi', 'unverified');
  }

  // --- major: money and admissibility ---
  if (w.cappedAtSI) {
    add('major', 'Claim balance sum insured se zyada hai (₹' + fmt(w.netAdmissible) + ' vs ₹' + fmt(w.balanceSI) + ')',
      'Sirf ₹' + fmt(w.totalClaimable) + ' tak milega - patient ko pehle bata dein');
  }
  if (w.proportionateDeduction > 0 && w.totalBill > 0 &&
      (w.proportionateDeduction / w.totalBill) >= BIG_DEDUCTION_PCT) {
    add('major', 'Room limit se upar - proportionate deduction ₹' + fmt(w.proportionateDeduction) +
      ' (room ₹' + fmt(num(p.actualRoomRentPerDay)) + '/day vs eligible ₹' + fmt(num(p.roomRentLimitPerDay)) + ')',
      'Room-category justification lein, ya patient ko deduction ka bata dein');
  }
  if (w.sublimitExcess > 0) {
    add('major', 'Sub-limit breach - ₹' + fmt(w.sublimitExcess) + ' limit se upar',
      'Policy ka sub-limit confirm karein');
  }

  // The strongest single check there is: the lines we read should add up to the total printed on
  // the bill. A gap means a page or a whole bill is missing from the file - which is exactly the
  // thing that comes back as a TPA query weeks later.
  // A big bill that came through as a single line is a summary, not the itemized break-up the
  // spec calls a blocker. Nothing on it can be classified, so no deduction can be predicted.
  (c.billTotals || []).forEach(b => {
    if (b.lineCount === 1 && num(b.summed) >= LUMP_SUM_LIMIT) {
      add('blocker',
        'Bill "' + (b.billNumber || b.billType) + '" (₹' + fmt(b.summed) + ') sirf ek lump-sum hai, itemized break-up nahi',
        'Hospital se full itemized bill lein - iske bina non-payable items nahi nikal sakte');
    }
  });

  (c.billTotals || []).forEach(b => {
    const gap = Math.round(num(b.stated) - num(b.summed));
    if (Math.abs(gap) <= 1) { return; }                       // paise-level rounding, ignore
    const sev = Math.abs(gap) >= 0.02 * num(b.stated) ? 'blocker' : 'major';
    add(sev,
      'Bill "' + (b.billNumber || b.billType) + '" pe likha total ₹' + fmt(b.stated) +
        ', par lines ka jod ₹' + fmt(b.summed) + ' (' + (gap > 0 ? 'kam' : 'zyada') + ' ₹' + fmt(Math.abs(gap)) + ')',
      gap > 0 ? 'Koi page ya bill file mein nahi hai - poora bill lein'
              : 'Lines do baar gin li gayi lagti hain - breakdown check karein');
  });

  // The same bill often arrives twice - summarised in the big claim file and itemised in a
  // separate one, with different wording and sometimes no bill number. Neither dropping it
  // silently (a real charge could vanish) nor counting it twice (the claim inflates) is safe,
  // so it is put in front of a human instead.
  const rs2 = v => '₹' + fmt(v);
  (c.suspectedDuplicates || []).forEach(d => {
    add('major',
      'Ye kharcha do documents mein aaya hai: "' + String(d.description).slice(0, 38) +
        '" ' + rs2(d.amount) + ' - abhi DO BAAR gina gaya hai',
      'Agar ek hi bill hai to ek file hata kar RE-CHECK karein');
  });

  // --- watch: worth noting, not fatal ---
  if (w.nonPayableTotal > 0) {
    add('watch', 'Non-payable items ₹' + fmt(w.nonPayableTotal) + ' bill mein hain',
      'Yeh amount insurer nahi dega - patient ko bata dein');
  }
  // Two different kinds of uncertainty, and they need different words. A disagreement means both
  // judges had an opinion and they clashed; "no opinion" means the line was silently assumed to be
  // an ordinary payable charge. Neither may be hidden.
  lines.filter(l => l.disagreement && num(l.amount) >= WATCH_LINE_AMOUNT).forEach(l => {
    const said = l.llm && l.llm.non_payable === true ? 'AI ne non-payable kaha, rulebook ne payable'
      : (l.llm && l.llm.room_linked !== null && l.keyword && l.llm.room_linked !== l.keyword.room_linked
        ? 'AI aur rulebook room-linked pe alag hain' : 'AI aur rulebook alag hain');
    add('watch', said + ': "' + String(l.description).slice(0, 45) + '" (₹' + fmt(num(l.amount)) + ')',
      'Bill dekh kar khud decide karein - rulebook ka jawab liya gaya hai');
  });
  lines.filter(l => !l.disagreement && l.confident === false && num(l.amount) >= WATCH_LINE_AMOUNT).forEach(l => {
    add('watch', 'Line classify nahi hui: "' + String(l.description).slice(0, 50) + '" (₹' + fmt(num(l.amount)) + ')',
      'Payable maan liya gaya hai - manually confirm karein');
  });

  // The skill rates waiting-period and exclusion checks BLOCKER. We cannot run them, so say so
  // rather than letting a clean-looking result imply they passed.
  const pend = checklist.filter(x => x.status === 'Pending' && UNVERIFIABLE.indexOf(x.key) !== -1);
  if (pend.length) {
    add('watch', pend.length + ' checks bot verify nahi kar sakta (waiting period, exclusion, bank details, signatures)',
      'Yeh manually check karein - inme se kuch claim rok sakte hain');
  }

  // blocker's rank is 0, so `rank[x] || 3` would sort blockers LAST - compare against undefined
  const rank = { blocker: 0, major: 1, watch: 2 };
  const rankOf = s => (rank[s] === undefined ? 3 : rank[s]);
  return out.sort((a, b) => rankOf(a.severity) - rankOf(b.severity));
}

function fmt(n) {
  // Indian grouping - 1,25,437 not 125,437
  const s = String(Math.round(num(n)));
  if (s.length <= 3) { return s; }
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  return rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
}

module.exports = {
  classifyLineItem: classifyLineItem,
  computeWaterfall: computeWaterfall,
  buildDocumentChecklist: buildDocumentChecklist,
  buildAlerts: buildAlerts,
  formatINR: fmt,
  nonPayableReason: nonPayableReason,
  CHECKS: CHECKS,
  UNVERIFIABLE: UNVERIFIABLE,
  PAYABLE_EXCEPTIONS: PAYABLE_EXCEPTIONS,
  NON_PAYABLE_KEYWORDS: NON_PAYABLE_KEYWORDS,
  ROOM_LINKED_KEYWORDS: ROOM_LINKED_KEYWORDS,
  NOT_ROOM_LINKED_KEYWORDS: NOT_ROOM_LINKED_KEYWORDS
};
