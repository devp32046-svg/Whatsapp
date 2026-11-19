/*
 * intel.js — bridge from Jarvis (Sales) to the existing Trade Intelligence Engine.
 * Reuses the deterministic engine (engine.js) + read-only data layer (db.js) under
 * aaziko/trade-intelligence/. Gives Jarvis a buyer's REAL patterns so outreach is
 * pattern-aware and well-timed. Read-only; no writes anywhere.
 */
const path = require('path');
const TI = path.resolve(__dirname, '..', 'trade-intelligence', 'trade-intelligence');
const db = require(path.join(TI, 'db'));
const engine = require(path.join(TI, 'engine'));

const STOP = new Set(['the','and','for','with','without','other','than','not','nes','neso','nesoi','whether','containing','their','which','those','excl','including','of','or','in','to','a','by','on','is','are','used','parts','accessories','similar']);
function termsFromDesc(desc) {
  return String(desc || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 3 && !STOP.has(w)).slice(0, 3);
}

/* HS6 -> clean product name from our own hscodes (the port rows often have an empty description). */
async function hsDesc(hs6) {
  if (!hs6) return null;
  const cs = (await db.getClient()).db('common-service').collection('hscodes');
  const d = await cs.findOne({ hsCode: { $regex: '^' + String(hs6).replace(/[^0-9]/g, '') } }, { projection: { description: 1 } });
  return d && d.description ? d.description : null;
}

/* Full buyer intelligence. If searchedHs is given, the pattern is for THAT product (what we're pitching),
   not the buyer's overall biggest product. */
async function buyerIntel(buyerName, searchedHs, asOfISO) {
  const asOf = asOfISO ? new Date(asOfISO) : new Date();
  const events = await db.getBuyerAllEvents(buyerName, 25000);
  if (!events.length) return { name: buyerName, found: false };
  const products = engine.productPatterns(events, asOf);   // sorted by value desc
  const hs6 = searchedHs ? String(searchedHs).replace(/\D/g, '').slice(0, 6) : null;
  const top = (hs6 && products.find(p => p.hs6 === hs6)) || products[0];   // the SEARCHED product if given
  // fill missing product descriptions from our hscodes (port rows are often blank)
  for (const p of [top, ...products.slice(0, 6)]) { if (p && !(p.desc && String(p.desc).trim())) p.desc = (await hsDesc(p.hs6)) || ('HS ' + p.hs6); }
  let suppliers = [];
  try { suppliers = await db.getSupplierMatches(termsFromDesc(top.desc), 5); } catch (e) {}
  const cc = {}; for (const e of events) { if (e.importer_country) cc[e.importer_country] = (cc[e.importer_country] || 0) + 1; }
  const country = Object.keys(cc).sort((a, b) => cc[b] - cc[a])[0] || null;
  return {
    name: buyerName, found: true, asOf: asOf.toISOString().slice(0, 10), country,
    productsCount: products.length,
    top: top ? {
      hs6: top.hs6, desc: top.desc, orders: top.orders,
      cadence: top.frequency_class, median_days: top.median,
      peak_month: top.monthly && top.monthly.summary && top.monthly.summary.peak_month,
      active_months: top.monthly && top.monthly.summary && top.monthly.summary.active_months,
      contact: top.contact,
      dependency: top.dependency,
      suppliers: (top.supplier_split || []).slice(0, 3).map(s => ({ name: s.supplier, share: s.share })),
      switching: top.switching_pattern && top.switching_pattern.type,
      reliability: top.reliability && top.reliability.verdict,
      annualized: top.annualized, stability: top.stability, last: top.span && top.span[1],  // raw fields for the opportunity score (§10)
    } : null,
    india_supplier_matches: suppliers.map(s => ({ product: s.product, supplier: s.supplier, location: s.location, match_pct: s.match_pct })),
    portfolio: products.slice(0, 5).map(p => ({ hs6: p.hs6, desc: (p.desc || '').slice(0, 50), orders: p.orders, cadence: p.frequency_class })),
  };
}

/* Compact, grounded brief lines for the outreach prompt (facts only; no invented numbers). */
function intelBrief(intel) {
  if (!intel || !intel.found || !intel.top) return null;
  const t = intel.top, L = [];
  L.push('Primary product: ' + (t.desc || 'HS ' + t.hs6) + ' (' + t.orders + ' shipments in records)');
  if (intel.productsCount > 1) L.push('Also imports ' + (intel.productsCount - 1) + ' other product line(s): ' + intel.portfolio.slice(1, 4).map(p => p.desc).join('; '));
  if (t.cadence && t.cadence !== 'Unknown') L.push('Buying pattern: ' + t.cadence + (t.median_days ? ' (~every ' + t.median_days + ' days)' : ''));
  if (t.peak_month) L.push('Peak buying month (history): ' + t.peak_month);
  if (t.contact && t.contact.emitted) {
    if (t.contact.status === 'upcoming') L.push('TIMING: next reorder window ~' + t.contact.from + ' to ' + t.contact.to + ' — GOOD time to reach out now.');
    else if (t.contact.status === 'lapsed') L.push('TIMING: expected reorder window passed (~' + t.contact.cycles_since_last + ' cycles ago) — re-engage angle.');
  }
  if (t.dependency) L.push('Current sourcing: ' + t.dependency + (t.suppliers && t.suppliers.length ? ' (top supplier ~' + Math.round((t.suppliers[0].share || 0) * 100) + '% share)' : ''));
  if (intel.india_supplier_matches && intel.india_supplier_matches.length) L.push('India CAN supply this: ' + intel.india_supplier_matches.length + ' matching Indian supplier(s) found (do NOT name them in the email).');
  return L.join('\n');
}

/* Turn one buyer's intel into a salesperson-facing opportunity score + plain-language labels.
 * Reuses the engine's deterministic opportunity score (§10) and adds a timing boost (an open
 * reorder window is the most actionable signal). Nothing invented — every label cites a real fact. */
// faithful re-implementation of engine.opportunity (§10) from the fields productPatterns exposes
// (productPatterns computes everything EXCEPT the score, which the engine only attaches to the master product).
const _OPP_W = { product_fit: 0.30, frequency: 0.20, volume: 0.20, supplier: 0.15, india_adv: 0.15 };
function _opportunity(t, asOfMs, hasIndiaMatch) {
  const cycle = t.median_days || 999;
  const lastMs = t.last ? Date.parse(String(t.last) + 'T00:00:00Z') : null;
  const cyclesSince = lastMs ? ((asOfMs - lastMs) / 86400000) / cycle : 99;
  const recency = Math.max(0, Math.min(1, 1 - Math.max(0, (cyclesSince - 2) / 2)));
  const frequencyComp = (t.stability || 0) * 100 * recency;
  const ann = t.annualized || 0;
  const volumeComp = Math.max(0, Math.min(1, (Math.log10(Math.max(ann, 1)) - 3) / 4)) * 100;
  const supplierComp = ((t.suppliers && t.suppliers[0] && t.suppliers[0].share) || 0) * 100;
  const comps = { product_fit: hasIndiaMatch ? 90 : 60, frequency: Math.round(frequencyComp), volume: Math.round(volumeComp), supplier: Math.round(supplierComp), india_adv: 50 };
  const score = Math.round(Object.keys(_OPP_W).reduce((a, k) => a + _OPP_W[k] * comps[k], 0));
  return { score, comps };
}

function scoreBuyer(intel) {
  if (!intel || !intel.found || !intel.top) return { score: 0, tier: 'C', labels: ['no customs history for this product'], reasons: [], base: 0, timingBoost: 0, found: false };
  const t = intel.top, labels = [], reasons = [];
  const hasIndiaMatch = !!(intel.india_supplier_matches && intel.india_supplier_matches.length);
  const opp = _opportunity(t, Date.now(), hasIndiaMatch);
  const base = opp.score;
  let timingBoost = 0;

  const cs = t.contact && t.contact.status;
  if (cs === 'upcoming') { timingBoost = 15; labels.push('🔥 Reorder window open'); reasons.push('Expected reorder window is open now (' + (t.contact.from || '') + '–' + (t.contact.to || '') + ').'); }
  else if (cs === 'lapsed') { timingBoost = 8; labels.push('♻️ Overdue — re-engage'); reasons.push('Reorder window elapsed ~' + (t.contact.cycles_since_last != null ? t.contact.cycles_since_last : '?') + ' cycles ago.'); }

  if (t.switching === 'sole_source' || /high/i.test(t.dependency || '')) { labels.push('⚠️ Single-supplier → switch target'); reasons.push('Current sourcing: ' + (t.dependency || 'concentrated') + (t.suppliers && t.suppliers[0] ? ' (top supplier ~' + Math.round((t.suppliers[0].share || 0) * 100) + '%)' : '') + '.'); }

  if (['Regular', 'Seasonal', 'Frequent'].includes(t.cadence)) { labels.push('🔁 Steady repeat buyer'); reasons.push('Buying pattern: ' + t.cadence + (t.median_days ? ' (~every ' + t.median_days + ' days)' : '') + '.'); }

  if (t.annualized && t.annualized >= 1000000) { labels.push('💰 High volume'); reasons.push('Annualised ~$' + Math.round(t.annualized).toLocaleString('en-US') + ' on this product.'); }
  if (t.peak_month) reasons.push('Peak buying month (history): ' + t.peak_month + '.');
  if (hasIndiaMatch) labels.push('🇮🇳 India can supply');
  if ((t.orders || 0) < 5) labels.push('ℹ️ Thin data (few shipments)');

  const score = Math.max(0, Math.min(100, Math.round(base + timingBoost)));
  const tier = score >= 70 ? 'A' : score >= 50 ? 'B' : 'C';
  return { score, tier, base: Math.round(base), timingBoost, labels, reasons, product: t.desc, orders: t.orders, found: true };
}

/* Rank a set of buyers for one product: compute intel in parallel, score, sort hottest-first. */
async function rankBuyers(buyerNames, hs, asOfISO) {
  const names = Array.from(new Set((buyerNames || []).filter(Boolean))).slice(0, 12);
  const intels = await Promise.all(names.map(n => buyerIntel(n, hs, asOfISO).catch(() => null)));
  const scored = names.map((n, i) => {
    const intel = intels[i];
    return Object.assign({ buyer_name: n, country: intel && intel.country, hs: String(hs) }, scoreBuyer(intel));
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

module.exports = { buyerIntel, intelBrief, termsFromDesc, scoreBuyer, rankBuyers };
