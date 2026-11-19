'use strict';
/*
 * Aaziko Trade Intelligence Engine v1.0 - deterministic core (JS).
 * Pure functions: given the same normalized events + as_of + formula versions,
 * output is identical. No AI, no randomness, no wall-clock inside the math
 * (as_of is passed in). Mirrors the Python reference engine.
 */
const crypto = require('crypto');

const FV = {
  events: 'events.v1', freq: 'freq.v1', contact: 'contact.v1', supplier: 'supplier.v1',
  conf: 'conf.v1', score: 'score.v1', cost: 'cost.v1', master: 'master.v1', product: 'product.v1',
};

// §11 opportunity weights — named once so the UI can explain the score instead of re-typing them
const SCORE_WEIGHTS = { product_fit: 0.30, frequency: 0.20, volume: 0.20, supplier: 0.15, india_adv: 0.15 };

const clamp01 = x => Math.max(0, Math.min(1, x));
const round = (x, n = 2) => (x == null || Number.isNaN(x)) ? null : Math.round(x * 10 ** n) / 10 ** n;
const day = s => new Date(s + 'T00:00:00Z');
const diffDays = (a, b) => Math.round((b - a) / 86400000);
const slugKey = name => name.trim().toLowerCase().split(/\s+/).join('-');

// ---- entity resolution: bill-of-lading junk tokens found live in the data ----
function isJunkBuyer(name) {
  if (name == null) return true;
  const n = String(name).trim().toUpperCase();
  if (['', 'NULL', 'NA', 'N/A', 'NONE', 'ORDER'].includes(n)) return true;
  const d = n.replace(/[^A-Z]/g, '');           // despace/depunct to catch mangled variants
  if (!d || d.length < 3) return true;
  return d.startsWith('TOTHEORD') || d.startsWith('TOORDER') || d.startsWith('TOTHEODER') || d.startsWith('TOODER') || d.startsWith('TOTHEORDR');
}

// ---- stats helpers ----
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
function median(a) {
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function stdev(a) { // sample stdev
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

// ---------------------------------------------------------------- events (§04)
function dedupEvents(events) {
  // Same supplier + same date, and value AND quantity within ±2% (missing qty/value = wildcard)
  // => one shipment reported twice (e.g. string- and number-HS forms). Distinct same-day shipments stay separate.
  const within = (a, b) => (!a || !b) ? true : Math.abs(a - b) <= 0.02 * Math.max(a, b);
  const groups = new Map(), out = [];
  for (const e of events) {
    const g = `${e.supplier_std}|${e.event_date}`;
    if (!groups.has(g)) groups.set(g, []);
    const clusters = groups.get(g);
    const v = e.value_usd || 0, q = e.quantity || 0;
    const hit = clusters.find(c => within(c.v, v) && within(c.q, q));
    if (hit) { hit.ev._merged++; continue; }
    const key = crypto.createHash('sha1').update(`${g}|${v.toFixed(2)}|${q.toFixed(2)}`).digest('hex').slice(0, 12);
    const ev = { ...e, event_id: 'e_' + key, _merged: 1 };
    clusters.push({ v, q, ev }); out.push(ev);
  }
  return out;
}
// Merge supplier-name spelling variants ("LAMINAM SPA" / "LAMINAM S P A" / "LAMINAM S.P.A."):
// key = alphanumerics only; each key displays as its most frequent original spelling.
function canonicalizeSuppliers(events) {
  const key = s => String(s || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'UNKNOWN';
  const counts = {};
  for (const e of events) { const k = key(e.supplier_std); counts[k] = counts[k] || {}; counts[k][e.supplier_std] = (counts[k][e.supplier_std] || 0) + 1; }
  const best = {}; for (const k of Object.keys(counts)) best[k] = Object.entries(counts[k]).sort((a, b) => b[1] - a[1])[0][0];
  return events.map(e => ({ ...e, supplier_std: best[key(e.supplier_std)] }));
}

function eventConfidence(e) {
  const dps = e.date_precision === 'day' ? 1.0 : 0.6;
  const agree = clamp01(0.5 + 0.25 * ((e._merged || 1) - 1));
  return clamp01(0.40 * (e.value_usd ? 1 : 0) + 0.25 * (e.quantity ? 1 : 0) + 0.20 * dps + 0.15 * agree);
}

// ------------------------------------------------------- frequency & patterns
function tightestCluster(dates, win) {
  let best = { frac: 0, width: 0 };
  for (let i = 0; i < dates.length; i++) {
    let j = i;
    while (j + 1 < dates.length && diffDays(dates[i], dates[j + 1]) <= win) j++;
    const frac = (j - i + 1) / dates.length;
    if (frac > best.frac) best = { frac, width: diffDays(dates[i], dates[j]) };
  }
  return best;
}
function isSeasonal(dates) {
  const years = new Set(dates.map(d => d.getUTCFullYear()));
  if (years.size < 2) return false;
  const monthYears = new Map();
  for (const d of dates) {
    const m = d.getUTCMonth();
    if (!monthYears.has(m)) monthYears.set(m, new Set());
    monthYears.get(m).add(d.getUTCFullYear());
  }
  const recurring = new Set([...monthYears].filter(([, ys]) => ys.size >= 2).map(([m]) => m));
  if (!recurring.size) return false;
  const months = dates.map(d => d.getUTCMonth());
  const frac = months.filter(m => recurring.has(m)).length / months.length;
  return new Set(months).size <= 5 && frac >= 0.5;
}
function frequency(events) {
  const dates = events.filter(e => eventConfidence(e) >= 0.35).map(e => day(e.event_date)).sort((a, b) => a - b);
  const n = dates.length;
  const intervals = [];
  for (let i = 0; i < n - 1; i++) intervals.push(diffDays(dates[i], dates[i + 1]));
  const base = {
    n_events: n, intervals,
    first: n ? dates[0].toISOString().slice(0, 10) : null,
    last: n ? dates[n - 1].toISOString().slice(0, 10) : null,
    span_days: n > 1 ? diffDays(dates[0], dates[n - 1]) : 0,
  };
  if (intervals.length < 2)
    return { ...base, median_interval_days: null, mean_interval_days: null, stability: null, class: 'Unknown' };
  const med = median(intervals), mn = mean(intervals);
  const cv = mn > 0 ? stdev(intervals) / mn : 0;
  const stability = clamp01(1 - cv);
  const cluster = tightestCluster(dates, 60);
  const isProject = cluster.frac >= 0.6 && base.span_days > 2 * (cluster.width || 1) && med < 20;
  let cls;
  if (n >= 4 && isSeasonal(dates)) cls = 'Seasonal';
  else if (isProject) cls = 'Project';
  else if (n >= 3 && stability >= 0.7 && med >= 15 && med <= 180) cls = 'Regular';
  else if (n >= 3) cls = 'Irregular';
  else cls = 'Unknown';
  return { ...base, median_interval_days: med, mean_interval_days: round(mn, 1), stability: round(stability, 3), class: cls };
}

function annualized(events) {
  const ds = events.map(e => day(e.event_date)).sort((a, b) => a - b);
  const spanY = Math.max(diffDays(ds[0], ds[ds.length - 1]) / 365, 0.25);
  return events.reduce((s, e) => s + (e.value_usd || 0), 0) / spanY;
}

function supplierRelationship(events) {
  const val = new Map();
  for (const e of events) val.set(e.supplier_std, (val.get(e.supplier_std) || 0) + (e.value_usd || 0));
  const total = [...val.values()].reduce((s, x) => s + x, 0) || 1;
  const shares = [...val].map(([s, v]) => ({ supplier: s, share: v / total }));
  const hhi = shares.reduce((s, x) => s + x.share ** 2, 0) * 10000;
  const top1 = Math.max(...shares.map(x => x.share));
  let dep;
  if (top1 >= 0.8 || hhi >= 6000) dep = 'High dependency';
  else if (hhi >= 3500) dep = 'Concentrated';
  else if (hhi < 1800) dep = 'Open supply chain';
  else dep = 'Moderate';
  const approach = { 'High dependency': 'diversification', 'Concentrated': 'partial displacement',
    'Moderate': 'competitive sourcing', 'Open supply chain': 'competitive sourcing' }[dep];
  return {
    n_suppliers: shares.length,
    supplier_split: shares.sort((a, b) => b.share - a.share).map(x => ({ supplier: x.supplier, share: round(x.share, 4) })),
    hhi: Math.round(hhi), top1_share: round(top1, 4), dependency_class: dep, approach_signal: approach,
  };
}

function mostlyIncreasing(xs) {
  let ups = 0;
  for (let i = 0; i < xs.length - 1; i++) if (xs[i + 1] >= xs[i]) ups++;
  return ups >= xs.length - 2;
}
function behaviour(events, freq, supp) {
  const labels = [];
  const vals = [...events].sort((a, b) => a.event_date < b.event_date ? -1 : 1).map(e => e.value_usd || 0);
  const tail = vals.slice(-4);
  if (tail.length >= 3 && tail[0] > 0 && tail[tail.length - 1] >= tail[0] * 1.15 && mostlyIncreasing(tail))
    labels.push('capacity_seeking');
  if (supp.n_suppliers === 1 && freq.stability != null && freq.stability >= 0.7 && freq.span_days >= 300)
    labels.push('reliability_focused');
  if (supp.dependency_class === 'High dependency' && annualized(events) >= 150000)
    labels.push('diversification');
  if (freq.class === 'Project') labels.push('project');
  if (supp.n_suppliers >= 3) labels.push('price_sensitive_candidate');
  return labels.length ? labels : ['insufficient_signal'];
}

// ---------------------------------------------------------------- contact (§07)
function contactWindow(freq, asOf) {
  if (!['Regular', 'Seasonal'].includes(freq.class) || !freq.median_interval_days)
    return { emitted: false, reason: `class=${freq.class}: pattern not regular enough` };
  const cycle = freq.median_interval_days, last = day(freq.last);
  const expected = new Date(last.getTime() + cycle * 86400000);
  const lead = Math.max(21, Math.min(60, Math.round(0.4 * cycle)));
  const iso = d => d.toISOString().slice(0, 10);
  const cyclesSince = diffDays(last, asOf) / cycle;
  if (expected >= asOf)
    return { emitted: true, status: 'upcoming',
      from: iso(new Date(expected.getTime() - lead * 86400000)),
      to: iso(new Date(expected.getTime() - Math.floor(lead / 2) * 86400000)),
      expected_next: iso(expected), statement: 'Historical buying pattern suggests this window.' };
  return { emitted: true, status: 'lapsed', expected_next: iso(expected), cycles_since_last: round(cyclesSince, 1),
    statement: `Expected reorder window elapsed ~${round(cyclesSince, 1)} cycles ago; buyer appears lapsed on this product. Re-engage.` };
}

// ---------------------------------------------------------------- confidence
function confidence(events, freq, note = '') {
  const n = events.length;
  const vol = clamp01(n / 12);
  const cov = events.filter(e => e.date_precision === 'day' && e.value_usd).length / Math.max(n, 1);
  const cons = freq.stability || 0;
  const c = clamp01(0.45 * vol + 0.30 * cov + 0.25 * cons);
  const band = c >= 0.75 ? 'High' : c >= 0.5 ? 'Medium' : 'Low';
  let basis = `n=${n}; coverage=${round(cov, 2)}; stability=${cons}`;
  if (note) basis += `; ${note}`;
  return { score: round(c, 2), band, basis };
}

// ---------------------------------------------------------------- score (§10)
function opportunity(events, freq, supp, asOf, productFit = 90) {
  const cycle = freq.median_interval_days || 999;
  const cyclesSince = freq.last ? diffDays(day(freq.last), asOf) / cycle : 99;
  const recency = clamp01(1 - Math.max(0, (cyclesSince - 2) / 2));
  const frequencyComp = (freq.stability || 0) * 100 * recency;
  const ann = annualized(events);
  const volumeComp = clamp01((Math.log10(Math.max(ann, 1)) - 3) / 4) * 100;
  const supplierComp = (supp.top1_share || 0) * 100;
  const indiaAdv = 50; // UNKNOWN: freight source not wired
  const comps = {
    product_fit: Math.round(productFit), frequency: Math.round(frequencyComp), volume: Math.round(volumeComp),
    supplier: Math.round(supplierComp), india_adv: Math.round(indiaAdv),
  };
  const score = Math.round(Object.keys(SCORE_WEIGHTS).reduce((a, k) => a + SCORE_WEIGHTS[k] * comps[k], 0));
  return { score, components: comps, annualized_value_usd: Math.round(ann), recency_factor: round(recency, 2) };
}

// ---------------------------------------------------------------- tariff (§09/10)
function parseDuty(reported, ave) {
  const flags = [];
  const rl = (reported || '').toLowerCase();
  if (['whichever', 'usd', '/sqm', '/kg', 'eur'].some(k => rl.includes(k))) flags.push('compound_or_specific');
  const src = (ave && /\d/.test(ave)) ? ave : (reported || '');
  const m = src.match(/(\d+(?:\.\d+)?)\s*%/);
  return { rate: m ? parseFloat(m[1]) : null, flags };
}
function tariffLane(lane) {
  const mfn = []; let fta = false, ftaName = null, flags = [];
  for (const reg of lane.regimes || []) {
    if (reg.agreement_name || reg.AgreementName) { fta = true; ftaName = reg.agreement_name || reg.AgreementName; continue; }
    const { rate, flags: f } = parseDuty(reg.reported ?? reg.TariffReported, reg.ave ?? reg.TariffAve);
    if (rate != null) mfn.push(rate);
    flags = flags.concat(f);
  }
  const uniq = [...new Set(mfn)].sort((a, b) => a - b);
  return {
    importing_country: lane.importing_country, target_year: lane.target_year,
    mfn_rates_pct: uniq, mfn_representative_pct: uniq.length ? uniq[0] : null,
    fta_available: fta, fta_name: ftaName, flags: [...new Set(flags)].sort(),
  };
}
function costLane(t, sampleValue) {
  const rate = t.mfn_representative_pct;
  return {
    lane: `India -> ${t.importing_country}`, hs6: t.hs6, duty_regime: t.fta_available ? 'FTA-preferential available (verify RoO)' : 'MFN',
    duty_pct_applied: rate, fta_available: t.fta_available, fta_name: t.fta_name,
    duty_on_sample_shipment_usd: rate != null ? round(sampleValue * rate / 100, 2) : null,
    freight_usd: null, other_known_usd: null, india_advantage: 'UNKNOWN',
    reason: 'freight-rate source not bound; containers holds only capacity + daily rate', notes: t.flags,
  };
}

// ---------------------------------------------------------------- supplier change (§7)
// Signals only: detect a supplier handover on the same product. Never decides why.
function detectSupplierChanges(events, medianInterval) {
  const evs = [...events].sort((a, b) => a.event_date < b.event_date ? -1 : 1);
  const unitPrice = e => (e.quantity && e.value_usd) ? e.value_usd / e.quantity : null;
  const changes = [];
  for (let i = 1; i < evs.length; i++) {
    const prev = evs[i - 1], cur = evs[i];
    if (prev.supplier_std && cur.supplier_std && prev.supplier_std !== cur.supplier_std) {
      const qp = prev.quantity || 0, qc = cur.quantity || 0;
      const pp = unitPrice(prev), pc = unitPrice(cur);
      const pricePct = (pp && pc) ? round((pc - pp) / pp * 100, 1) : null;   // new vs old unit price
      const qtyPct = (qp && qc) ? round((qc - qp) / qp * 100, 1) : null;     // new vs old order size
      // Which candidate reasons the DATA supports (signals only — never a decided cause)
      const supported = [];
      if (pricePct != null && pricePct <= -3) supported.push('price');               // new supplier cheaper
      if (qtyPct != null && qtyPct >= 15) supported.push('capacity');                // scaled up to new supplier
      if (qtyPct != null && qtyPct <= -15) supported.push('risk_diversification');   // split / trial with new supplier
      changes.push({ from: prev.supplier_std, to: cur.supplier_std, date: cur.event_date,
        gap_days: Math.round((day(cur.event_date) - day(prev.event_date)) / 86400000),
        from_unit_price: pp != null ? round(pp, 4) : null, to_unit_price: pc != null ? round(pc, 4) : null,
        price_change_pct: pricePct, qty_change_pct: qtyPct,
        similar_quantity: (qp && qc) ? Math.abs(qc - qp) / Math.max(qp, qc) <= 0.25 : null,
        supported_reasons: supported,
        candidate_reasons: ['price', 'capacity', 'quality', 'delivery', 'risk_diversification', 'compliance'] });
    }
  }
  return changes;
}

// ---------------------------------------------------------------- run one buyer
function runBuyer(buyerStd, rawEvents, hs6, hsDesc, asOf, productFit = 90) {
  const events = dedupEvents(canonicalizeSuppliers(rawEvents));
  for (const e of events) e.confidence = round(eventConfidence(e), 2);
  const freq = frequency(events);
  const supp = supplierRelationship(events);
  const beh = behaviour(events, freq, supp);
  const supplierChanges = detectSupplierChanges(events, freq.median_interval_days);
  const cw = contactWindow(freq, asOf);
  const sliceNote = supp.n_suppliers === 1
    ? 'single-supplier reflects per-exporter upload slice, not confirmed full sourcing' : '';
  const conf = confidence(events, freq, sliceNote);
  const opp = opportunity(events, freq, supp, asOf, productFit);
  const key = slugKey(buyerStd);
  const totalValue = round(events.reduce((s, e) => s + (e.value_usd || 0), 0), 2);
  const avgQty = round(mean(events.map(e => e.quantity || 0)), 1);
  const cc = {}; for (const e of events) { if (e.importer_country) cc[e.importer_country] = (cc[e.importer_country] || 0) + 1; }
  const country = Object.keys(cc).sort((a, b) => cc[b] - cc[a])[0] || null;
  const importerName = (events.find(e => e.importer_name) || {}).importer_name || buyerStd;
  const prov = (fv) => ({ source_collections: ['common-service.standard_port_data'], formula_version: fv,
    calc_date: asOf.toISOString().slice(0, 10), evidence_ref: { event_count: events.length }, confidence: conf.score });
  return {
    buyer_key: key, name: buyerStd, country, importer_name: importerName, orders: events.length, value: totalValue, unit: events[0].qty_unit || '',
    avgQty, span: [freq.first, freq.last],
    freq: freq.class, median: freq.median_interval_days, mean_interval: freq.mean_interval_days,
    stability: freq.stability, intervals: freq.intervals,
    dependency: supp.dependency_class, hhi: supp.hhi, top1_share: supp.top1_share,
    supplier_split: supp.supplier_split, behaviour: beh, supplier_changes: supplierChanges, score: opp.score, comps: opp.components,
    annualized: opp.annualized_value_usd, conf: conf.score, band: conf.band, conf_basis: conf.basis,
    contact: cw, family: hsDesc,
    events: events.map(e => [e.event_date, Math.round(e.value_usd || 0)]),
    events_full: events.map(e => ({ date: e.event_date, value: round(e.value_usd || 0, 2), qty: e.quantity,
      unit: e.qty_unit, supplier: e.supplier_std,
      unit_price: e.quantity ? round((e.value_usd || 0) / e.quantity, 4) : null, conf: e.confidence })),
    _provenance: prov(FV.score),
  };
}

// Per-product patterns: group a buyer's full multi-HS event stream by HS6 and compute
// frequency + supplier + contact + behaviour for EACH product they trade.
// Per-supplier pattern: HOW the buyer buys from each supplier of a product — cadence, order size,
// unit price, active period, trends, and a deterministic role/status. Signals only.
function supplierPatterns(evs, productFreq, asOf) {
  const bySup = {};
  for (const e of evs) { const s = e.supplier_std || 'UNKNOWN'; (bySup[s] = bySup[s] || []).push(e); }
  const total = evs.reduce((a, e) => a + (e.value_usd || 0), 0) || 1;
  const prodMed = productFreq.median_interval_days || 30;
  const allDates = evs.map(e => e.event_date).sort();
  const spanStart = allDates.length ? day(allDates[0]) : asOf;
  const spanDays = Math.max(1, diffDays(spanStart, asOf));
  const rows = Object.entries(bySup).map(([s, se0]) => {
    const se = [...se0].sort((a, b) => a.event_date < b.event_date ? -1 : 1);
    const f = frequency(se);
    const value = se.reduce((a, e) => a + (e.value_usd || 0), 0);
    const qtys = se.map(e => e.quantity || 0);
    const ups = se.map(e => (e.quantity && e.value_usd) ? e.value_usd / e.quantity : null).filter(x => x != null);
    const k = Math.min(3, se.length);
    const trendPct = arr => { if (arr.length < 2) return null; const a = mean(arr.slice(0, k)), b = mean(arr.slice(-k)); return a ? round((b - a) / a * 100, 1) : null; };
    const qtyTrend = trendPct(qtys), priceTrend = trendPct(ups);
    const first = day(f.first), last = day(f.last);
    const sinceLast = diffDays(last, asOf);
    const othersAfter = evs.some(e => e.supplier_std !== s && day(e.event_date) > last);
    let status = 'active';
    const ownGap = f.median_interval_days || 0;   // respect this supplier's own cadence before calling it dropped
    if (othersAfter && sinceLast > Math.max(2 * ownGap, 2 * prodMed, 90)) status = 'dropped';
    else if (se.length <= 3 && diffDays(spanStart, first) > 0.75 * spanDays) status = 'new';
    return {
      supplier: s, shipments: se.length, total_qty: round(qtys.reduce((a, c) => a + c, 0), 1), value: round(value, 2), share: round(value / total, 4),
      avg_qty: round(mean(qtys), 1), avg_value: round(value / se.length, 2),
      avg_unit_price: ups.length ? round(mean(ups), 4) : null,
      cadence_class: f.class, median_gap: f.median_interval_days, stability: f.stability,
      first: f.first, last: f.last, days_since_last: sinceLast,
      qty_trend_pct: qtyTrend, price_trend_pct: priceTrend,
      qty_trend: qtyTrend == null ? 'n/a' : qtyTrend >= 15 ? 'growing' : qtyTrend <= -15 ? 'shrinking' : 'stable',
      price_trend: priceTrend == null ? 'n/a' : priceTrend >= 5 ? 'rising' : priceTrend <= -5 ? 'falling' : 'stable',
      status, events: se.map(e => ({ date: e.event_date, value: Math.round(e.value_usd || 0) })),
    };
  }).sort((a, b) => b.value - a.value);
  rows.forEach((r, i) => { r.role = i === 0 ? 'primary' : (r.share >= 0.15 ? 'secondary' : 'minor'); });
  return rows;
}

// Product-level sourcing pattern: sole source / migration A→B / alternating (parallel) / primary+secondary.
function switchingPattern(evs, rows, changes) {
  const n = rows.length;
  if (n <= 1) return { type: 'sole_source', n_suppliers: n, switches: 0,
    summary: `Sole source: ${rows[0] ? rows[0].supplier : '—'} supplies 100% of this product.` };
  const [A, B] = rows;
  const overlap = !(day(A.last) < day(B.first) || day(B.last) < day(A.first));
  const ratio = evs.length ? changes.length / evs.length : 0;
  if (!overlap) {
    const [earlier, later] = day(A.first) <= day(B.first) ? [A, B] : [B, A];
    return { type: 'migration', n_suppliers: n, switches: changes.length,
      summary: `Migrated from ${earlier.supplier} (${earlier.first} → ${earlier.last}) to ${later.supplier} (${later.first} → ${later.last}); ${changes.length} switch${changes.length === 1 ? '' : 'es'}.` };
  }
  if (ratio >= 0.3 || n >= 4) return { type: 'alternating', n_suppliers: n, switches: changes.length,
    summary: `Parallel / alternating sourcing across ${n} suppliers — ${changes.length} switches in ${evs.length} orders; primary ${A.supplier} at ${Math.round(A.share * 100)}%.` };
  return { type: 'primary_plus_secondary', n_suppliers: n, switches: changes.length,
    summary: `Primary ${A.supplier} (${Math.round(A.share * 100)}%) with secondary ${B.supplier} (${Math.round(B.share * 100)}%) used in parallel; ${changes.length} switch${changes.length === 1 ? '' : 'es'}.` };
}

// Monthly pattern for a product: buyer totals per calendar month (gaps filled with zeros) and a
// supplier x month grid for the top suppliers. Deterministic aggregation; no wall-clock.
function monthlyPattern(evs, sp) {
  if (!evs.length) return null;
  const ym = d => d.slice(0, 7);
  const dates = evs.map(e => e.event_date).sort();
  const months = [];
  for (let d = new Date(dates[0].slice(0, 7) + '-01T00:00:00Z'), end = new Date(dates[dates.length - 1].slice(0, 7) + '-01T00:00:00Z'); d <= end; d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.toISOString().slice(0, 7));
  const tot = {}; months.forEach(m => tot[m] = { orders: 0, qty: 0, value: 0 });
  const topSup = sp.slice(0, 8).map(r => r.supplier);
  const bySup = {}; topSup.forEach(s => { bySup[s] = {}; months.forEach(m => bySup[s][m] = { orders: 0, qty: 0, value: 0 }); });
  for (const e of evs) {
    const m = ym(e.event_date); if (!tot[m]) continue;
    tot[m].orders++; tot[m].qty += e.quantity || 0; tot[m].value += e.value_usd || 0;
    const s = e.supplier_std; if (bySup[s]) { bySup[s][m].orders++; bySup[s][m].qty += e.quantity || 0; bySup[s][m].value += e.value_usd || 0; }
  }
  const totals = months.map(m => ({ month: m, orders: tot[m].orders, qty: round(tot[m].qty, 1), value: round(tot[m].value, 2) }));
  const active = totals.filter(t => t.orders > 0);
  const peak = active.reduce((a, t) => (!a || t.value > a.value) ? t : a, null);
  return {
    months, totals,
    by_supplier: topSup.map(s => ({ supplier: s, cells: months.map(m => ({ month: m, orders: bySup[s][m].orders, qty: round(bySup[s][m].qty, 1), value: round(bySup[s][m].value, 2) })) })),
    summary: {
      total_months: months.length, active_months: active.length, idle_months: months.length - active.length,
      peak_month: peak ? peak.month : null, peak_value: peak ? peak.value : null,
      avg_orders_per_active_month: active.length ? round(active.reduce((a, t) => a + t.orders, 0) / active.length, 1) : null,
      avg_value_per_active_month: active.length ? round(active.reduce((a, t) => a + t.value, 0) / active.length, 2) : null,
    },
  };
}

// ---------------------------------------------------------------- pattern reliability
// Grades EACH detected pattern against the evidence it was computed from, so the page can
// say which patterns are trustworthy and which are just not supported by enough data.
// Deterministic thresholds; signals only — it never upgrades a pattern it cannot support.
// Grades: 'Strong' (usable as-is) | 'Weak' (directional only) | 'Not usable' (do not rely on).
function patternReliability(evs, freq, supp, sp, swp, monthly) {
  const n = evs.length;
  const gaps = (freq.intervals || []).length;
  const named = evs.filter(e => e.supplier_named).length;
  const originOnly = evs.filter(e => !e.supplier_named && e.origin_country).length;
  const dayPrec = evs.filter(e => e.date_precision === 'day').length;
  const withQty = evs.filter(e => e.quantity > 0).length;
  const value = evs.reduce((a, e) => a + (e.value_usd || 0), 0);
  const months = (monthly && monthly.months) ? monthly.months.length : 0;
  const supCount = (supp.supplier_split || []).length;
  const multiOrderSups = (sp || []).filter(x => x.shipments >= 2).length;
  const out = [];
  const add = (pattern, grade, why, need) => out.push({ pattern, grade, why, need: need || null });

  // 1. order cadence (median/mean gap, frequency class)
  if (gaps < 2) add('Order cadence', 'Not usable',
    `${n} order${n === 1 ? '' : 's'} gives ${gaps} gap${gaps === 1 ? '' : 's'}; a cadence needs at least 2 gaps.`, '3+ orders');
  else if (gaps < 4) add('Order cadence', 'Weak', `Based on only ${gaps} gaps — one odd shipment moves the median.`, '5+ orders');
  else if (freq.stability != null && freq.stability < 0.35) add('Order cadence', 'Weak',
    `${gaps} gaps but stability ${freq.stability} — the spacing is erratic, so the median is indicative only.`, 'a steadier buyer');
  else add('Order cadence', 'Strong', `${gaps} gaps, stability ${freq.stability == null ? '—' : freq.stability}.`);

  // 2. frequency CLASS (the label, stricter than the raw numbers)
  if (n < 3) add('Frequency class', 'Not usable', `"${freq.class}" is the fallback for under 3 orders.`, '3+ orders');
  else if (freq.class === 'Irregular' || freq.class === 'Unknown') add('Frequency class', 'Weak',
    `"${freq.class}" means no repeating rhythm was found — it is the absence of a pattern, not a pattern.`, null);
  else add('Frequency class', 'Strong', `"${freq.class}" met its rule over ${n} orders.`);

  // 3. supplier dependency / HHI
  if (!named && originOnly) add('Supplier dependency (HHI)', 'Not usable',
    `No row names the shipper; HHI ${supp.hhi} is computed over ${supCount} ORIGIN COUNTRIES, not suppliers.`, 'a feed that names the shipper');
  else if (!named) add('Supplier dependency (HHI)', 'Not usable', `No supplier and no origin country on any row.`, 'supplier or origin data');
  else if (named < n) add('Supplier dependency (HHI)', 'Weak',
    `Only ${named} of ${n} rows name the shipper; the rest are grouped by origin, so shares are mixed-basis.`, 'named shippers on all rows');
  else if (n < 3) add('Supplier dependency (HHI)', 'Weak', `All rows name the shipper, but only ${n} orders.`, '3+ orders');
  else add('Supplier dependency (HHI)', 'Strong', `All ${n} rows name the shipper across ${supCount} supplier${supCount === 1 ? '' : 's'}.`);

  // 4. supplier switching / comparison
  if (supCount < 2) add('Supplier switching', 'Not usable', `Only one supplier bucket — there is nothing to compare.`, '2+ suppliers');
  else if (multiOrderSups < 2) add('Supplier switching', 'Weak',
    `${supCount} suppliers but only ${multiOrderSups} of them has 2+ orders — a one-off order is not a switch.`, '2+ orders per supplier');
  else add('Supplier switching', 'Strong', `${swp && swp.class ? swp.class.replace(/_/g, ' ') : 'compared'} across ${supCount} suppliers, ${multiOrderSups} with repeat orders.`);

  // 5. monthly pattern
  if (months < 3) add('Monthly pattern', 'Not usable', `Activity spans ${months} month${months === 1 ? '' : 's'}.`, '3+ months');
  else if (months < 6) add('Monthly pattern', 'Weak', `Only ${months} months of history.`, '6+ months');
  else add('Monthly pattern', 'Strong', `${months} months of history.`);

  // 6. unit price / value basis
  if (value < 10) add('Value & unit price', 'Not usable',
    `Total value reads $${round(value, 2)} — the source value field is wrong on these rows, so unit price and annualized value are meaningless.`, 'corrected source values');
  else if (!withQty) add('Value & unit price', 'Not usable', `No row carries a quantity, so no unit price can be formed.`, 'quantity data');
  else if (withQty < n) add('Value & unit price', 'Weak', `Only ${withQty} of ${n} rows carry a quantity.`, 'quantity on all rows');
  else add('Value & unit price', 'Strong', `All ${n} rows carry value and quantity.`);

  // 7. date precision (affects every gap above)
  if (!dayPrec) add('Date precision', 'Not usable', `No row has a day-level date; gaps are month-approximations.`, 'day-level dates');
  else if (dayPrec < n) add('Date precision', 'Weak', `${dayPrec} of ${n} rows have a day-level date; the rest are month-only.`, 'day-level dates');
  else add('Date precision', 'Strong', `All ${n} rows have day-level dates.`);

  const strong = out.filter(x => x.grade === 'Strong').length;
  const weak = out.filter(x => x.grade === 'Weak').length;
  const unusable = out.filter(x => x.grade === 'Not usable').length;
  return { items: out, strong, weak, unusable, total: out.length,
    verdict: unusable === 0 && weak === 0 ? 'All patterns supported by the data'
           : strong === 0 ? 'No pattern here is supported by the data'
           : `${strong} of ${out.length} patterns supported; ${weak} directional, ${unusable} not usable` };
}

function productPatterns(events, asOf) {
  const byHs = {};
  for (const e of events) { (byHs[e.hs6] = byHs[e.hs6] || []).push(e); }
  const out = [];
  for (const hs6 of Object.keys(byHs)) {
    const evs = dedupEvents(canonicalizeSuppliers(byHs[hs6]));
    const freq = frequency(evs);
    const supp = supplierRelationship(evs);
    const beh = behaviour(evs, freq, supp);
    const cw = contactWindow(freq, asOf);
    const sc = detectSupplierChanges(evs, freq.median_interval_days);
    const sp = supplierPatterns(evs, freq, asOf);
    const swp = switchingPattern(evs, sp, sc);
    const mo = monthlyPattern(evs, sp);
    out.push({
      hs6, desc: (byHs[hs6].find(x => x.hs_desc && String(x.hs_desc).trim()) || {}).hs_desc || '', orders: evs.length,
      dedup: { rows: byHs[hs6].length, events: evs.length, merged: byHs[hs6].length - evs.length },
      value: round(evs.reduce((s, e) => s + (e.value_usd || 0), 0), 2),
      unit: evs[0].qty_unit || '', span: [freq.first, freq.last],
      frequency_class: freq.class, median: freq.median_interval_days, mean_interval: freq.mean_interval_days,
      stability: freq.stability, intervals: freq.intervals, dependency: supp.dependency_class, hhi: supp.hhi,
      supplier_split: supp.supplier_split, behaviour: beh, contact: cw,
      annualized: Math.round(annualized(evs)),
      avg_unit_price: (() => { const up = evs.map(e => e.quantity ? (e.value_usd || 0) / e.quantity : null).filter(x => x != null); return up.length ? round(up.reduce((a, c) => a + c, 0) / up.length, 4) : null; })(),
      events: evs.map(e => ({ date: e.event_date, value: Math.round(e.value_usd || 0) })),
      events_full: evs.map(e => ({ date: e.event_date, supplier: e.supplier_std, value: round(e.value_usd || 0, 2), qty: e.quantity, unit: e.qty_unit, unit_price: e.quantity ? round((e.value_usd || 0) / e.quantity, 4) : null, conf: round(eventConfidence(e), 2) })),
      suppliers_detail: (() => {
        const m = {};
        for (const e of evs) { const s = e.supplier_std || 'UNKNOWN'; (m[s] = m[s] || { supplier: s, shipments: 0, value: 0, ups: [], dates: [] }); m[s].shipments++; m[s].value += (e.value_usd || 0); const u = (e.quantity && e.value_usd) ? e.value_usd / e.quantity : null; if (u != null) m[s].ups.push(u); m[s].dates.push(e.event_date); }
        const tot = Object.values(m).reduce((a, x) => a + x.value, 0) || 1;
        return Object.values(m).map(x => { const ds = x.dates.sort(); return { supplier: x.supplier, shipments: x.shipments, value: round(x.value, 2), share: round(x.value / tot, 4), avg_unit_price: x.ups.length ? round(x.ups.reduce((a, c) => a + c, 0) / x.ups.length, 4) : null, first: ds[0], last: ds[ds.length - 1] }; }).sort((a, b) => b.value - a.value);
      })(),
      supplier_changes: sc, supplier_patterns: sp, switching_pattern: swp,
      monthly: mo,
      reliability: patternReliability(evs, freq, supp, sp, swp, mo),
    });
  }
  return out.sort((a, b) => b.value - a.value);
}

module.exports = {
  FV, SCORE_WEIGHTS, isJunkBuyer, runBuyer, productPatterns, tariffLane, costLane, slugKey,
  // exported for tests
  frequency, supplierRelationship, contactWindow, opportunity, parseDuty, patternReliability,
};
