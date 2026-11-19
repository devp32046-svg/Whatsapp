'use strict';
/*
 * Live, READ-ONLY MongoDB access for the Trade Intelligence Engine.
 * Applies the §03 normalization contract (field coalescing) so the engine
 * receives one clean event shape. Never issues a write.
 */
const { MongoClient } = require('mongodb');
const path = require('path');

const URI = process.env.TIE_MONGO_URI ||
  'mongodb://admin:Aaziko%21%40%23123@100.70.212.45:27017/?authSource=admin&directConnection=true';

let client = null;
async function getClient() {
  if (client) return client;
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 10000, maxPoolSize: 5 });
  await client.connect();
  return client;
}
async function close() { if (client) { await client.close(); client = null; } }

// ---- §03 coalesce priorities ----
const VALUE_KEYS = ['TOTAL_VALUE_USD', 'VALUE_USD', 'VALUE_IN_USD', 'INVOICE_VALUE_USD', 'TOTAL_USD', 'AMOUNT_USD', 'TOTAL_INVOICE_VALUE'];
const QTY_KEYS = ['TOTAL_QUANTITY', 'QUANTITY', 'COMMERCIAL_QUANTITY', 'NET_WEIGHT'];
const UNIT_KEYS = ['QUANTITY_UNIT', 'STD_UNIT'];
const SUPP_KEYS = ['STD_SUPPLIER_NAME', 'INDICATOR_OF_TRUE_SUPPLIER', 'STD_EXPORTER_NAME', 'SUPPLIER_NAME_EN', 'EXPORTER_NAME', 'SUPPLIER_NAME', 'SHIPPER_NAME'];
const DEST_KEYS = ['DESTINATION_COUNTRY', 'IMPORT_COUNTRY', 'CONSIGNEE_COUNTRY', 'COUNTRY'];
const ORIGIN_KEYS = ['ORIGIN_COUNTRY', 'ORIGIN_COUNTRY_EN', 'EXPORT_COUNTRY', 'EXPORTER_COUNTRY', 'SHIPMENT_COUNTRY', 'SHIPPER_COUNTRY'];
// Placeholders that are present-but-meaningless. raw_data.SHIPPER_NAME_EN is the literal
// string "NULL" (or "N/A") on ~9.7% of rows, so a naive fallback would invent a supplier
// literally named NULL. Measured on random samples of the full 222M collection.
const PLACEHOLDERS = new Set(['NULL', 'NA', 'N/A', 'NONE', 'NIL', '-', '--', 'UNKNOWN']);
function usableStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return (!s || PLACEHOLDERS.has(s.toUpperCase())) ? null : s;
}
// Top-level first, then the same key inside raw_data (some feeds only populate raw_data).
function deepStr(row, keys) {
  for (const k of keys) { const v = usableStr(row[k]); if (v) return v; }
  const rd = row.raw_data;
  if (rd && typeof rd === 'object') { for (const k of keys) { const v = usableStr(rd[k]); if (v) return v; } }
  return null;
}
// HS_CODE is stored in BOTH string ("69072100", ~1k curated rows) and number (69072100, ~51k rich rows)
// forms for the SAME code. Always match both, or the engine sees ~2% of the data.
const hsForms = hs => { const s = String(hs); const n = Number(s); return isNaN(n) ? [s] : [s, n]; };

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function firstNum(row, keys) {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'number' && isFinite(v) && v > 0) return v;
    if (typeof v === 'string' && v.trim() && isFinite(+v) && +v > 0) return +v;
  }
  return null;
}
function firstStr(row, keys) {
  for (const k of keys) { const v = row[k]; if (v != null && String(v).trim()) return String(v).trim(); }
  return null;
}
function isoDay(d) { return d.toISOString().slice(0, 10); }

function coalesceDate(row) {
  if (row.DATE_ISO instanceof Date) return { date: isoDay(row.DATE_ISO), precision: 'day' };
  for (const k of ['DATE', 'EXPORT_DATE', 'IMPORT_DATE', 'TRADE_DATE']) {
    const v = row[k];
    if (v instanceof Date) return { date: isoDay(v), precision: 'day' };
    if (typeof v === 'string') {
      if (/^\d{4}-\d{2}-\d{2}/.test(v)) return { date: v.slice(0, 10), precision: 'day' };
      const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);   // "8/12/25 0:00" — US M/D/YY(YY) export format (3rd format found in raw data)
      if (us) { const y = us[3].length === 2 ? 2000 + +us[3] : +us[3], m = +us[1], d = +us[2];
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return { date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, precision: 'day' }; }
    }
  }
  const my = row.MONTH_YEAR || row.MONTHYEAR;         // e.g. "Apr 2025"
  if (typeof my === 'string') {
    const m = my.trim().match(/^([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
    if (m && MONTHS[m[1].toLowerCase()] != null)
      return { date: isoDay(new Date(Date.UTC(+m[2], MONTHS[m[1].toLowerCase()], 1))), precision: 'month' };
  }
  return { date: null, precision: null };
}

// Canonical supplier name so spelling variants group together:
// "LAMINAM S P A" == "LAMINAM SPA", "X PRIVATE LIMITED" == "X PVT LTD", punctuation/spacing ignored.
function canonName(s) {
  if (!s) return s;
  let n = String(s).toUpperCase().replace(/[.,'"()\-\/&]+/g, ' ').replace(/\s+/g, ' ').trim();
  n = n.replace(/\b(?:[A-Z] )+[A-Z]\b/g, m => m.replace(/ /g, ''));      // "S P A" -> "SPA", "L L C" -> "LLC"
  n = n.replace(/\bPRIVATE\b/g, 'PVT').replace(/\bLIMITED\b/g, 'LTD').replace(/\bCOMPANY\b/g, 'CO');
  return n.replace(/\s+/g, ' ').trim();
}

// every coalesced field, top-level AND its raw_data mirror (subfield projection stays cheap)
const EVENT_FIELD_PROJECTION = Object.fromEntries(
  [...VALUE_KEYS, ...QTY_KEYS, ...UNIT_KEYS, ...SUPP_KEYS, ...DEST_KEYS, ...ORIGIN_KEYS]
    .flatMap(k => [[k, 1], ['raw_data.' + k, 1]]));

function originOf(row) { return deepStr(row, ORIGIN_KEYS); }
function normalizeEvent(row) {
  const { date, precision } = coalesceDate(row);
  const sup = deepStr(row, SUPP_KEYS), origin = originOf(row);
  return {
    event_date: date, date_precision: precision,
    value_usd: firstNum(row, VALUE_KEYS),
    quantity: firstNum(row, QTY_KEYS),
    qty_unit: (firstStr(row, UNIT_KEYS) || '').toUpperCase(),
    // Supplier NAME is genuinely missing on ~9.7% of rows (source feed ships "NULL"),
    // but the ORIGIN COUNTRY survives on ~93% of those. Bucketing by origin keeps a
    // multi-origin buyer from looking like a single "UNKNOWN" sole-source with HHI 10000.
    supplier_std: canonName(sup) || (origin ? 'ORIGIN: ' + origin.toUpperCase() : 'UNKNOWN'),
    supplier_named: !!sup,
    origin_country: origin,
    importer_country: deepStr(row, DEST_KEYS),
    importer_name: row.BUYER_NAME || row.IMPORTER_NAME || null,
  };
}

const JUNK_RE = /^\s*TO\s+(THE\s+)?ORDER/i;
// Robust junk-consignee check: despace/depunct then match mangled "TO THE ORDER" variants
// (TO TH EORDER, T O THE ORDER, TO THE O RDER OF, TO THE ORDE, …) that a plain regex misses.
function isJunkName(name) {
  if (name == null) return true;
  const n = String(name).trim().toUpperCase();
  if (['', 'NULL', 'NA', 'N/A', 'NONE', 'ORDER'].includes(n)) return true;
  const d = n.replace(/[^A-Z]/g, '');
  if (!d || d.length < 3) return true;
  return d.startsWith('TOTHEORD') || d.startsWith('TOORDER') || d.startsWith('TOTHEODER') || d.startsWith('TOODER') || d.startsWith('TOTHEORDR');
}

// Discover top real buyers within an indexed HS slice (junk consignees excluded).
async function discoverBuyers(hs, limit) {
  const coll = (await getClient()).db('common-service').collection('standard_port_data');
  const rows = await coll.aggregate([
    { $match: { HS_CODE: { $in: hsForms(hs) }, BUYER_NAME: { $nin: [null, 'NULL', ''] } } },
    { $group: { _id: '$BUYER_NAME', n: { $sum: 1 }, value: { $sum: { $ifNull: ['$TOTAL_VALUE_USD', 0] } } } },
    { $match: { n: { $gte: 3 } } },
    { $sort: { value: -1, n: -1 } },
    { $limit: 500 },
  ], { allowDiskUse: true }).toArray();
  return rows.filter(r => !isJunkName(r._id)).slice(0, limit).map(r => ({ buyer_std: r._id, n: r.n, value: r.value }));
}

async function getBuyerEvents(hs, buyerStd, cap = 800) {
  const coll = (await getClient()).db('common-service').collection('standard_port_data');
  const rows = await coll.find(
    { HS_CODE: { $in: hsForms(hs) }, BUYER_NAME: buyerStd },
    { projection: { DATE_ISO: 1, DATE: 1, MONTH_YEAR: 1, BUYER_NAME: 1, IMPORTER_NAME: 1, ...EVENT_FIELD_PROJECTION },
      limit: cap }).toArray();
  return rows.map(normalizeEvent).filter(e => e.event_date && (e.value_usd || e.quantity))
    .sort((a, b) => a.event_date < b.event_date ? -1 : 1);
}

// A buyer's FULL cross-product history via the indexed IMPORTER_NAME (fast). Merges the
// string+number HS forms into one HS6 row each. Answers "what does this buyer actually trade?"
async function getBuyerPortfolio(importerName, limit = 40) {
  if (!importerName) return [];
  const coll = (await getClient()).db('common-service').collection('standard_port_data');
  const rows = await coll.aggregate([
    { $match: { BUYER_NAME: importerName } },
    { $group: { _id: '$HS_CODE', shipments: { $sum: 1 }, value: { $sum: { $ifNull: ['$TOTAL_VALUE_USD', 0] } },
        desc: { $first: '$HS_CODE_DESCRIPTION' }, suppliers: { $addToSet: '$STD_SUPPLIER_NAME' }, dests: { $addToSet: '$DESTINATION_COUNTRY' } } },
    { $sort: { shipments: -1 } }, { $limit: 300 },
  ], { allowDiskUse: true }).toArray();
  const byHs6 = new Map();
  for (const r of rows) {
    const hs6 = String(r._id).replace(/\D/g, '').slice(0, 6);
    if (!hs6) continue;
    const cur = byHs6.get(hs6) || { hs6, shipments: 0, value: 0, desc: r.desc, suppliers: new Set(), dests: new Set() };
    cur.shipments += r.shipments; cur.value += r.value; if (!cur.desc) cur.desc = r.desc;
    (r.suppliers || []).forEach(s => s && cur.suppliers.add(s));
    (r.dests || []).forEach(d => d && cur.dests.add(d));
    byHs6.set(hs6, cur);
  }
  return [...byHs6.values()].map(x => ({ hs6: x.hs6, shipments: x.shipments, value: Math.round(x.value),
    desc: x.desc, suppliers: [...x.suppliers].slice(0, 6), destinations: [...x.dests].slice(0, 6) }))
    .sort((a, b) => b.shipments - a.shipments).slice(0, limit);
}

// `prefer` = the countries our scored buyers actually import into. Without it the lane list was
// just the first N rows for the HS, which matched ZERO buyer countries (measured) — the tariff,
// compliance and freight sections were answering questions about markets with no buyers in them.
async function getTariffLanes(hs, exporter, limit = 12, prefer = []) {
  const coll = (await getClient()).db('Dhruval2').collection('macmap_tariff');
  const PROJ = { HsCode: 1, ImportingCountry: 1, TargetYear: 1, 'Data.TariffRegime': 1, 'Data.TariffReported': 1, 'Data.TariffAve': 1, 'Data.AgreementName': 1 };
  const base = { HsCode: hs, ExportingCountry: exporter };
  const want = [...new Set((prefer || []).map(c => String(c).toUpperCase()).filter(Boolean))];
  const shape = r => ({
    hs6: hs, importing_country: r.ImportingCountry, target_year: r.TargetYear,
    regimes: (r.Data || []).map(d => ({ regime: d.TariffRegime, reported: d.TariffReported, ave: d.TariffAve, agreement_name: d.AgreementName })),
  });
  let out = [];
  const have = new Set();
  if (want.length) {   // $expr for case-insensitive exact match; the HS+exporter filter is already tiny
    const pref = await coll.find({ ...base, $expr: { $in: [{ $toUpper: '$ImportingCountry' }, want] } },
      { projection: PROJ, limit: limit * 3 }).toArray();
    // One row per country, but the feed carries several TargetYears and the newer one is often
    // EMPTY (e.g. UAE 2026 has no regimes while 2025 reports 5%). Keep the doc that actually
    // carries a rate, newest first — otherwise the most important lanes render a blank duty.
    const rated = d => (d.Data || []).some(x => x && (x.TariffReported != null || x.TariffAve != null));
    const byCountry = new Map();
    for (const r of pref) {
      const k = String(r.ImportingCountry).toUpperCase();
      const cur = byCountry.get(k);
      if (!cur) { byCountry.set(k, r); continue; }
      const better = (rated(r) !== rated(cur)) ? (rated(r) ? r : cur)
                   : ((+r.TargetYear || 0) > (+cur.TargetYear || 0) ? r : cur);
      byCountry.set(k, better);
    }
    for (const [k, r] of byCountry) { if (out.length >= limit) break; have.add(k); out.push(shape(r)); }
  }
  if (out.length < limit) {
    const rest = await coll.find(base, { projection: PROJ, limit: limit * 3 }).toArray();
    for (const r of rest) {
      if (out.length >= limit) break;
      if (have.has(String(r.ImportingCountry).toUpperCase())) continue;
      have.add(String(r.ImportingCountry).toUpperCase());
      out.push(shape(r));
    }
  }
  return out;
}

// Movement fingerprint: per HS, row count + latest shipment date. Changes => recompute.
async function getFingerprint(hsList) {
  const coll = (await getClient()).db('common-service').collection('standard_port_data');
  const parts = {};
  for (const hs of hsList) {
    const count = await coll.countDocuments({ HS_CODE: { $in: hsForms(hs) } });
    const latest = await coll.find({ HS_CODE: { $in: hsForms(hs) } }, { projection: { DATE_ISO: 1 }, sort: { DATE_ISO: -1 }, limit: 1 }).toArray();
    parts[hs] = { count, maxDate: latest[0]?.DATE_ISO ? isoDay(latest[0].DATE_ISO) : null };
  }
  const str = Object.entries(parts).map(([k, v]) => `${k}:${v.count}:${v.maxDate}`).join('|');
  return { parts, fingerprint: str };
}

// ---- compliance / non-tariff measures (macmap_regulatory) ----
const NTM_CAT = { A: 'SPS (sanitary)', B: 'Technical (TBT)', C: 'Pre-shipment inspection',
  D: 'Contingent trade-protective', E: 'Licensing / quantity control', F: 'Price control',
  G: 'Finance measures', H: 'Anti-competitive', P: 'Export-related' };
const catLabel = code => NTM_CAT[(code || '?')[0]] || 'Other measures';

async function getRegulatory(hs6, importingCountry, exporter) {
  const coll = (await getClient()).db('Dhruval2').collection('macmap_regulatory');
  const doc = await coll.findOne(
    { HsCode6Digit: hs6, ImportingCountry: importingCountry, ExportingCountry: exporter },
    { projection: { 'Data.AllMeasures.Code': 1, 'Data.AllMeasures.Title': 1,
        'Data.AllMeasures.LegislationTitle': 1, 'Data.AllMeasures.ImplementationAuthority': 1 },
      sort: { DateUpdated: -1 } });
  if (!doc) return null;
  const seen = new Set(), cats = new Map(), steps = new Set(), legis = new Map();
  for (const d of (doc.Data || [])) for (const m of (d.AllMeasures || [])) {
    const key = `${m.Code || ''}|${m.LegislationTitle || ''}|${m.Title || ''}`;
    if (seen.has(key)) continue; seen.add(key);
    const cl = catLabel(m.Code); cats.set(cl, (cats.get(cl) || 0) + 1);
    if (m.Title) steps.add(m.Title);
    if (m.LegislationTitle) legis.set(m.LegislationTitle, { title: m.LegislationTitle, authority: m.ImplementationAuthority || '' });
  }
  return {
    country: importingCountry, exporter, total: seen.size,
    categories: [...cats].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
    steps: [...steps], legislation: [...legis.values()].slice(0, 3),
  };
}

// Rank importing countries by number of NTMs on this HS6 for the given exporter.
async function discoverComplianceCountries(hs6, exporter, limit, prefer = []) {
  const coll = (await getClient()).db('Dhruval2').collection('macmap_regulatory');
  const rows = await coll.aggregate([
    { $match: { HsCode6Digit: hs6, ExportingCountry: exporter } },
    { $addFields: { mc: { $sum: { $map: { input: { $ifNull: ['$Data', []] }, as: 'd',
      in: { $size: { $ifNull: ['$$d.AllMeasures', []] } } } } } } },
    { $group: { _id: '$ImportingCountry', n: { $max: '$mc' } } },
    { $sort: { n: -1 } },
  ], { allowDiskUse: true }).toArray();
  const all = rows.map(r => r._id).filter(Boolean);
  const want = new Set((prefer || []).map(c => String(c).toUpperCase()));
  const hit = all.filter(c => want.has(String(c).toUpperCase()));      // buyer destinations first
  const rest = all.filter(c => !want.has(String(c).toUpperCase()));
  return [...hit, ...rest].slice(0, limit);
}

// A buyer's FULL multi-product event stream via indexed IMPORTER_NAME (all HS codes).
async function getBuyerAllEvents(importerName, cap = 25000, stats) {
  if (!importerName) return [];
  const coll = (await getClient()).db('common-service').collection('standard_port_data');
  const t0 = Date.now();
  const rows = await coll.find({ BUYER_NAME: importerName },
    { projection: { HS_CODE: 1, HS_CODE_DESCRIPTION: 1, DATE_ISO: 1, DATE: 1, MONTH_YEAR: 1, BUYER_NAME: 1, IMPORTER_NAME: 1,
        ...EVENT_FIELD_PROJECTION },
      limit: cap }).toArray();
  const mapped = rows.map(r => { const e = normalizeEvent(r); e.hs6 = String(r.HS_CODE).replace(/\D/g, '').slice(0, 6); e.hs_desc = r.HS_CODE_DESCRIPTION || ''; return e; });
  const kept = mapped.filter(e => e.hs6 && e.event_date && (e.value_usd || e.quantity));
  if (stats) {                       // optional out-param: lets the API explain what it did
    stats.read_ms = Date.now() - t0;
    stats.db_rows = rows.length;
    stats.usable_rows = kept.length;
    stats.dropped_rows = rows.length - kept.length;
    stats.row_cap = cap;
    stats.capped = rows.length >= cap;
    stats.supplier_named = kept.filter(e => e.supplier_named).length;
    stats.supplier_origin_only = kept.filter(e => !e.supplier_named && e.origin_country).length;
    stats.supplier_unknown = kept.filter(e => !e.supplier_named && !e.origin_country).length;
  }
  return kept.sort((a, b) => a.event_date < b.event_date ? -1 : 1);
}

// ---- §9 India supplier matching (product-service.indiaProduct; no HS, so match by product name) ----
async function getSupplierMatches(terms, limit = 12) {
  if (!terms || !terms.length) return [];
  const coll = (await getClient()).db('product-service').collection('indiaProduct');
  const rx = new RegExp(terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
  const rows = await coll.find(
    { productName: { $regex: rx }, isActive: true },
    { projection: { productName: 1, seller_name: 1, full_address: 1, 'seller_address.state': 1, 'seller_address.city': 1,
        'product_details.price': 1, 'product_details.Minimum Order Quantity': 1, minQuantity: 1, 'priceRanges.price': 1 },
      limit: limit * 4 }).toArray();
  const seen = new Set(), out = [];
  for (const r of rows) {
    const price = (r.product_details && r.product_details.price) || (r.priceRanges && r.priceRanges[0] && r.priceRanges[0].price) || null;
    const moq = (r.product_details && r.product_details['Minimum Order Quantity']) || r.minQuantity || null;
    const supplier = r.seller_name || null;
    const loc = (r.seller_address && (r.seller_address.state || r.seller_address.city)) || r.full_address || null;
    const name = r.productName || '';
    const key = (supplier || '') + '|' + name;
    if (seen.has(key)) continue; seen.add(key);
    const hits = terms.filter(t => name.toLowerCase().includes(t.toLowerCase())).length;
    const match_pct = Math.min(100, 55 + Math.round((hits / terms.length) * 45));
    out.push({ product: name, price, moq, supplier, location: loc, match_pct });
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => b.match_pct - a.match_pct);
}

// ---- §10 ocean freight (parse aaziko_MASTER_ocean_rates_UPLOAD.xlsx once) ----
let FREIGHT = null;
function loadFreight() {
  if (FREIGHT) return FREIGHT;
  try {
    const XLSX = require('xlsx');
    const file = path.join(__dirname, '..', 'aaziko_MASTER_ocean_rates_UPLOAD.xlsx');
    const wb = XLSX.readFile(file);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });
    FREIGHT = rows.map(r => ({ pol: r.POL_Name, pod: r.POD_Name, line: r.Shipping_Line, service: r.Service_Name,
      container: r.Container_Type_Size, base: r.Ocean_Freight_Base, allin: r.All_In_Total,
      currency: r.Total_Currency || r.Freight_Currency, transit: r.Transit_Time_Days, scope: r.Quote_Scope,
      valid_to: r.Valid_To, confidence: r.Rate_Confidence })).filter(x => x.pod && x.allin != null);
  } catch (e) { FREIGHT = []; }
  return FREIGHT;
}
// POD name -> country via searates-scraper.ports (4,399 ports / 209 countries; the freight sheet
// carries no country column). Cached per process; exact match first, then prefix.
let PORT_COUNTRY = null;
async function loadPortCountries() {
  if (PORT_COUNTRY) return PORT_COUNTRY;
  PORT_COUNTRY = new Map();
  try {
    const coll = (await getClient()).db('searates-scraper').collection('ports');
    const pods = [...new Set(loadFreight().map(r => r.pod).filter(Boolean))];
    for (const p of pods) {
      const esc = String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = await coll.findOne({ port_name: new RegExp('^' + esc + '$', 'i') }, { projection: { country_name: 1 } })
             || await coll.findOne({ port_name: new RegExp('^' + esc, 'i') }, { projection: { country_name: 1 } });
      if (m && m.country_name) PORT_COUNTRY.set(p, m.country_name);
    }
  } catch (e) { /* mapping is an enrichment; freight still renders without it */ }
  return PORT_COUNTRY;
}
// Freight lanes with the buyers' destination countries first (async: needs the port->country map).
async function getFreightLanesFor(prefer = [], limit = 14) {
  const map = await loadPortCountries();
  const want = new Set((prefer || []).map(c => String(c).toUpperCase()));
  const seen = new Set(), rows = [];
  for (const r of loadFreight()) {
    const key = `${r.pol}->${r.pod}|${r.container}`;
    if (seen.has(key)) continue; seen.add(key);
    const country = map.get(r.pod) || null;
    rows.push({ ...r, pod_country: country, has_buyers: !!(country && want.has(country.toUpperCase())) });
  }
  const hit = rows.filter(r => r.has_buyers), rest = rows.filter(r => !r.has_buyers);
  return [...hit, ...rest].slice(0, limit);
}
function getFreightLanes(limit = 14) {
  const f = loadFreight();
  const seen = new Set(), out = [];
  for (const r of f) {
    const key = `${r.pol}->${r.pod}|${r.container}`;
    if (seen.has(key)) continue; seen.add(key);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

// Company search by NAME PREFIX. Anchored ^regex uses the IMPORTER_NAME index (~2s over 222M rows).
// A non-anchored "contains" regex also index-scans but walks every key (>120s) — so prefix only.
async function searchCompanies(q, limit = 25) {
  const term = String(q || '').trim().toUpperCase();
  if (term.length < 2) return [];
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const coll = (await getClient()).db('common-service').collection('standard_port_data');
  const rows = await coll.aggregate([
    { $match: { BUYER_NAME: { $regex: '^' + esc } } },
    { $group: { _id: '$BUYER_NAME', rows: { $sum: 1 }, value: { $sum: { $ifNull: ['$TOTAL_VALUE_USD', 0] } },
        countries: { $addToSet: '$DESTINATION_COUNTRY' }, hs: { $addToSet: '$HS_CODE' },
        first: { $min: '$DATE' }, suppliers: { $addToSet: '$STD_SUPPLIER_NAME' } } },
    { $sort: { value: -1 } }, { $limit: limit },
  ], { allowDiskUse: true }).toArray();
  return rows.map(r => ({
    name: r._id, rows: r.rows, value: Math.round(r.value),
    countries: [...new Set((r.countries || []).filter(Boolean))].slice(0, 3),
    products: new Set((r.hs || []).map(h => String(h).replace(/\D/g, '').slice(0, 6)).filter(Boolean)).size,
    suppliers: (r.suppliers || []).filter(Boolean).length,
  }));
}

module.exports = { getClient, searchCompanies, close, discoverBuyers, getBuyerEvents, getBuyerPortfolio, getBuyerAllEvents, getTariffLanes, getFingerprint, normalizeEvent, getRegulatory, discoverComplianceCountries, getSupplierMatches, getFreightLanes, getFreightLanesFor, loadPortCountries, loadFreight };
