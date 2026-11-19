/*
 * spec-match.js — DETERMINISTIC COA-vs-required-spec matcher (code decides PASS/FAIL, never the LLM).
 * Mirrors Sagar's real step: a buyer states a spec (e.g. "iodine value 2 max", "assay 99% min"); the supplier COA
 * states what the product actually guarantees; we compare each parameter and flag conformance / deviation.
 *
 * Params (both COA and required) share the shape {name, value, unit, basis} where basis ∈ min|max|range|exact|typical.
 * A param is turned into a numeric bound [lo, hi]; open sides are ±Infinity. Non-numeric → text compare.
 *
 * Verdict per parameter:
 *   PASS    — the COA guarantee provably satisfies the requirement
 *   FAIL    — the COA guarantee provably violates it (wrong side of a limit)
 *   REVIEW  — cannot prove either way (open bound on the constrained side, or non-numeric) → human check
 *   MISSING — the required parameter is not present in the COA
 */
'use strict';

const num = (s) => { const m = String(s == null ? '' : s).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null; };
const normName = (s) => String(s || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const worse = (a, b) => { const r = { PASS: 0, REVIEW: 1, FAIL: 2 }; return r[b] > r[a] ? b : a; };

// a param {value, basis} → {lo, hi} numeric bound, or {text} if not numeric
function bound(p) {
  const v = String((p && p.value) != null ? p.value : '').trim();
  const basis = String((p && p.basis) || '').toLowerCase();
  const rng = v.match(/(-?\d+(?:\.\d+)?)\s*(?:-|to|–|—|~)\s*(-?\d+(?:\.\d+)?)/i);
  if (rng) return { lo: parseFloat(rng[1]), hi: parseFloat(rng[2]) };
  const n = num(v);
  if (n === null) return { text: v };
  const isMax = /<|≤|max|not more|nmt|below|up to/i.test(v) || basis === 'max';
  const isMin = />|≥|min|not less|nlt|above|at least/i.test(v) || basis === 'min';
  if (isMax && !isMin) return { lo: -Infinity, hi: n };
  if (isMin && !isMax) return { lo: n, hi: Infinity };
  if (basis === 'range') return { lo: n, hi: n };
  return { lo: n, hi: n };   // exact / typical
}

const fmtParam = (p) => { if (!p) return '—'; const u = p.unit ? ' ' + p.unit : ''; const b = p.basis && !/exact/i.test(p.basis) ? ' ' + p.basis : ''; return String(p.value == null ? '' : p.value) + u + b; };

// find the COA parameter that corresponds to a required parameter (name-based, WORD-boundary — not raw substring,
// so "pH" does not match "Phosphate")
const wordContains = (hay, needle) => { if (!needle || needle.length < 2) return false; const re = new RegExp('(^| )' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( |$)'); return re.test(hay); };
function findCoaParam(reqName, coaParams) {
  const rn = normName(reqName); if (!rn) return null;
  for (const c of coaParams) { if (normName(c.name) === rn) return c; }                               // 1. exact
  for (const c of coaParams) { const cn = normName(c.name); if (wordContains(cn, rn) || wordContains(rn, cn)) return c; }   // 2. whole-phrase at word boundary
  const rt = rn.split(' ').filter(w => w.length > 2);
  if (rt.length) { for (const c of coaParams) { const ct = new Set(normName(c.name).split(' ')); if (rt.every(w => ct.has(w))) return c; } }   // 3. all significant tokens present
  const rset = new Set(rt);
  if (rset.size) { for (const c of coaParams) { const ct = normName(c.name).split(' '); if (ct.some(w => rset.has(w))) return c; } }           // 4. any significant token overlap
  return null;
}

// compare one required param against the matched COA param
function matchOne(req, coa) {
  if (!coa) return { status: 'MISSING', note: 'not stated in COA' };
  const r = bound(req), c = bound(coa);
  if (r.text !== undefined || c.text !== undefined) {
    const rt = String(req.value || '').toLowerCase().trim(), ct = String(coa.value || '').toLowerCase();
    if (rt && ct && (ct.includes(rt) || rt.includes(ct))) return { status: 'PASS', note: 'text match' };
    return { status: 'REVIEW', note: 'non-numeric — verify manually' };
  }
  let status = 'PASS'; const notes = [];
  if (isFinite(r.hi)) {                                   // requirement imposes a MAX
    if (isFinite(c.hi)) { if (c.hi > r.hi) { status = 'FAIL'; notes.push(c.hi + ' exceeds max ' + r.hi); } }
    else { status = worse(status, 'REVIEW'); notes.push('COA has no upper bound to confirm max ' + r.hi); }
  }
  if (isFinite(r.lo)) {                                   // requirement imposes a MIN
    if (isFinite(c.lo)) { if (c.lo < r.lo) { status = 'FAIL'; notes.push(c.lo + ' below min ' + r.lo); } }
    else { status = worse(status, 'REVIEW'); notes.push('COA has no lower bound to confirm min ' + r.lo); }
  }
  return { status, note: notes.join('; ') };
}

// main: match a COA's parameters against a list of required parameters
function matchSpec(coaParams, requiredParams) {
  coaParams = Array.isArray(coaParams) ? coaParams : [];
  requiredParams = Array.isArray(requiredParams) ? requiredParams : [];
  const rows = []; let pass = 0, fail = 0, review = 0, missing = 0;
  for (const req of requiredParams) {
    const coa = findCoaParam(req.name, coaParams);
    const m = matchOne(req, coa);
    rows.push({ name: req.name, required: fmtParam(req), coa: fmtParam(coa), status: m.status, note: m.note });
    if (m.status === 'FAIL') fail++; else if (m.status === 'REVIEW') review++; else if (m.status === 'MISSING') missing++; else pass++;
  }
  const verdict = fail ? 'DEVIATION' : (missing || review) ? 'REVIEW' : (requiredParams.length ? 'CONFORM' : 'NO_SPEC');
  return { verdict, summary: { pass, fail, review, missing, total: requiredParams.length }, rows };
}

module.exports = { matchSpec, matchOne, bound, findCoaParam, normName };

// --- self-test: node aaziko/service/spec-match.js ---
if (require.main === module) {
  const coa = [ // Vinipul DAP (OCR'd)
    { name: 'Phosphate (P2O5)', value: '> 52.0', unit: '%', basis: 'min' },
    { name: 'Total Nitrogen (as N)', value: '> 21.0', unit: '%', basis: 'min' },
    { name: 'Assay (On dried basis)', value: '> 98.0', unit: '% w/w', basis: 'min' },
    { name: 'Chloride (Cl)', value: '< 0.01', unit: '% w/w', basis: 'max' },
    { name: 'Moisture', value: '< 1.0', unit: '%', basis: 'max' },
    { name: 'pH of 1% aqueous solution', value: '7.6-8.4', unit: '', basis: 'range' },
  ];
  const req = [
    { name: 'Phosphate', value: '50', unit: '%', basis: 'min' },   // PASS (COA min 52 ≥ 50)
    { name: 'Assay', value: '99', unit: '%', basis: 'min' },       // FAIL (COA min 98 < 99)
    { name: 'Chloride', value: '0.02', unit: '%', basis: 'max' },  // PASS (COA max 0.01 ≤ 0.02)
    { name: 'Moisture', value: '0.5', unit: '%', basis: 'max' },   // REVIEW? COA max 1.0 > 0.5 → FAIL
    { name: 'Iodine Value', value: '2', unit: '', basis: 'max' },  // MISSING
    { name: 'pH', value: '7-9', unit: '', basis: 'range' },        // PASS (7.6-8.4 within 7-9)
  ];
  console.log(JSON.stringify(matchSpec(coa, req), null, 2));
}
