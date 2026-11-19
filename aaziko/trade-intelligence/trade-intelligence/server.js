'use strict';
/*
 * Trade Intelligence Engine - live dashboard service.
 *   - reads Mongo READ-ONLY, recomputes the deterministic engine on demand
 *   - "every movement": a watcher polls a DB fingerprint (row count + latest
 *      shipment date) for the watched HS codes; a change triggers a recompute
 *   - "every day": a scheduled full recompute at config.daily_hour_utc
 *   - snapshots cached to ./cache/latest.json (local disk; never to Mongo)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const eng = require('./engine');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const CACHE = path.join(__dirname, 'cache', 'latest.json');
const PUBLIC = path.join(__dirname, 'public');
const HS_LIST = CFG.watch_hs.map(w => w.hs);
const FAMILY = Object.fromEntries(CFG.watch_hs.map(w => [w.hs, w]));

const searchCache = new Map();
const state = {
  snapshot: null, computing: false, lastComputed: null, lastError: null,
  fingerprint: null, lastDailyDate: null, runs: 0,
};

function log(...a) { console.log(new Date().toISOString(), ...a); }

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function compute(reason) {
  if (state.computing) return state.snapshot;
  state.computing = true;
  const asOf = new Date();
  const t0 = Date.now();
  try {
    const buyers = [], supplierMatches = [];
    for (const { hs } of CFG.watch_hs) {
      const fam = FAMILY[hs];
      const matches = await db.getSupplierMatches(fam.match_terms || [], 12);   // §9 India supply
      matches.forEach(m => { m.hs = hs; supplierMatches.push(m); });
      const productFit = matches.length ? Math.min(95, 60 + matches.length * 3) : 50;  // real product-fit input
      const discovered = await db.discoverBuyers(hs, CFG.buyers_per_hs);
      for (const d of discovered) {
        const raw = await db.getBuyerEvents(hs, d.buyer_std);
        if (raw.length < 3) continue;
        const b = eng.runBuyer(d.buyer_std, raw, hs, fam.family, asOf, productFit);
        b.hs = hs; b.hs_label = fam.label;
        buyers.push(b);
      }
    }
    buyers.sort((a, b) => b.score - a.score);

    // sample shipment for the cost lanes = median event value across scope (dynamic)
    const allVals = buyers.flatMap(b => b.events.map(e => e[1])).filter(v => v > 0);
    const sampleValue = Math.round(median(allVals)) || 50000;

    // the markets our scored buyers actually import into — lanes/compliance/freight follow these
    const buyerCountries = [...new Set(buyers.map(b => b.country).filter(Boolean))];
    const buyersPerCountry = {};
    for (const b of buyers) if (b.country) buyersPerCountry[b.country.toUpperCase()] = (buyersPerCountry[b.country.toUpperCase()] || 0) + 1;

    const lanes = [], costs = [];
    for (const { hs } of CFG.watch_hs) {
      const hs6 = String(hs).replace(/\D/g, '').slice(0, 6);   // macmap_tariff keys on HS6
      const raw = await db.getTariffLanes(hs6, CFG.tariff_exporter, 12, buyerCountries);
      for (const l of raw) {
        const t = eng.tariffLane(l); t.hs6 = hs6;
        t.buyers_here = buyersPerCountry[String(t.importing_country).toUpperCase()] || 0;
        lanes.push(t);
        costs.push(eng.costLane(t, sampleValue));
      }
    }

    // ---- compliance / non-tariff measures per destination (macmap_regulatory) ----
    const hs6c = String(CFG.watch_hs[0].hs).replace(/\D/g, '').slice(0, 6);
    const compMap = new Map();
    for (const c of [...new Set(lanes.map(l => l.importing_country))]) {
      const reg = await db.getRegulatory(hs6c, c, CFG.tariff_exporter);
      if (reg && reg.total) compMap.set(c, reg);
    }
    if (compMap.size < 4) {                 // ensure a few detailed cards even if tariff-lane countries lack NTM records
      for (const c of await db.discoverComplianceCountries(hs6c, CFG.tariff_exporter, 6, buyerCountries)) {
        if (!compMap.has(c)) { const reg = await db.getRegulatory(hs6c, c, CFG.tariff_exporter); if (reg && reg.total) compMap.set(c, reg); }
      }
    }
    for (const cst of costs) { const c = cst.lane.replace('India -> ', ''); cst.compliance_count = compMap.has(c) ? compMap.get(c).total : 0; }
    const compliance = [...compMap.values()].map(c => ({ ...c,
      buyers_here: buyersPerCountry[String(c.importing_country || c.country || '').toUpperCase()] || 0 }))
      .sort((a, b) => (b.buyers_here - a.buyers_here) || (b.total - a.total));   // buyer markets first

    const freight = await db.getFreightLanesFor(buyerCountries, 14);   // §10 ocean freight, buyer destinations first

    const snapshot = {
      run_id: 'run_' + asOf.toISOString().replace(/[:.]/g, '').slice(0, 15),
      as_of: asOf.toISOString().slice(0, 10),
      generated_at: asOf.toISOString(),
      reason,
      versions: [eng.FV.freq, eng.FV.supplier, eng.FV.score, eng.FV.cost].join(' · '),
      watch: CFG.watch_hs,
      tariff_exporter: CFG.tariff_exporter,
      sample_shipment_usd: sampleValue,
      buyers, tariff_lanes: lanes, cost_analysis_results: costs, compliance,
      supplier_matches: supplierMatches, freight,
      buyer_countries: buyerCountries, buyers_per_country: buyersPerCountry,
      meta: {
        buyers_scored: buyers.length,
        total_value_usd: Math.round(buyers.reduce((s, b) => s + b.value, 0)),
        shipment_events: buyers.reduce((s, b) => s + b.orders, 0),
        avg_confidence: buyers.length ? +(buyers.reduce((s, b) => s + b.conf, 0) / buyers.length).toFixed(2) : 0,
        tariff_lanes: lanes.length,
        compliance_lanes: compliance.length,
        supplier_matches: supplierMatches.length,
        freight_lanes: freight.length,
        supplier_changes: buyers.reduce((s, b) => s + ((b.supplier_changes && b.supplier_changes.length) || 0), 0),
        lane_coverage: {
          buyer_countries: buyerCountries.length,
          tariff_matched: lanes.filter(l => l.buyers_here > 0).length,
          compliance_matched: compliance.filter(c => c.buyers_here > 0).length,
          freight_matched: freight.filter(f => f.has_buyers).length,
          uncovered_tariff: buyerCountries.filter(c => !lanes.some(l => String(l.importing_country).toUpperCase() === c.toUpperCase())),
          uncovered_compliance: buyerCountries.filter(c => !compliance.some(x => String(x.importing_country || x.country || '').toUpperCase() === c.toUpperCase())),
          uncovered_freight: buyerCountries.filter(c => !freight.some(f => String(f.pod_country || '').toUpperCase() === c.toUpperCase())),
        },
        compute_ms: 0,
      },
    };
    snapshot.meta.compute_ms = Date.now() - t0;

    // --- how fresh is the underlying DATA (not the recompute)? every recency-based output
    // --- (frequency component, contact windows, "lapsed") is measured against as_of.
    const lastDates = buyers.map(b => b.span && b.span[1]).filter(Boolean).sort();
    const newest = lastDates[lastDates.length - 1] || null;
    const ageDays = newest ? Math.round((asOf - new Date(newest + 'T00:00:00Z')) / 86400000) : null;
    snapshot.meta.freshness = {
      as_of: snapshot.as_of, newest_shipment: newest, age_days: ageDays,
      oldest_buyer_last: lastDates[0] || null,
      stale: ageDays != null && ageDays > 90,
      affects: ['frequency score component', 'contact windows', 'lapsed / upcoming status', 'days_since_last'],
    };

    // --- which score components actually separate these buyers, and which are the same for all?
    const compKeys = Object.keys(eng.SCORE_WEIGHTS);
    const disc = compKeys.map(k => {
      const vals = buyers.map(b => (b.comps || {})[k]).filter(v => v != null);
      const uniq = [...new Set(vals)];
      return { component: k, weight: eng.SCORE_WEIGHTS[k], values: uniq.length === 1 ? uniq[0] : null,
        constant: uniq.length <= 1, spread: uniq.length <= 1 ? 0 : Math.max(...vals) - Math.min(...vals) };
    });
    const varying = disc.filter(d => !d.constant);
    snapshot.meta.score_discrimination = {
      components: disc,
      ranking_weight: +varying.reduce((a, d) => a + d.weight, 0).toFixed(2),
      constant_weight: +disc.filter(d => d.constant).reduce((a, d) => a + d.weight, 0).toFixed(2),
      constant_components: disc.filter(d => d.constant).map(d => d.component),
    };

    const fp = await db.getFingerprint(HS_LIST);
    state.fingerprint = fp.fingerprint;
    snapshot.meta.data_fingerprint = fp.fingerprint;
    snapshot.meta.fingerprint_parts = fp.parts;

    state.snapshot = snapshot;
    state.lastComputed = asOf.toISOString();
    state.lastError = null;
    state.runs++;
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(snapshot));
    log(`compute(${reason}) ok: ${buyers.length} buyers, ${lanes.length} lanes, ${snapshot.meta.compute_ms}ms`);
  } catch (e) {
    state.lastError = e.message;
    log(`compute(${reason}) FAILED: ${e.message}`);
  } finally {
    state.computing = false;
  }
  return state.snapshot;
}

async function movementCheck() {
  if (state.computing) return;
  try {
    const fp = await db.getFingerprint(HS_LIST);
    if (fp.fingerprint !== state.fingerprint) {
      log('movement detected -> recompute');
      await compute('movement');
    }
  } catch (e) { log('movementCheck error:', e.message); }
}

function dailyCheck() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (now.getUTCHours() >= CFG.daily_hour_utc && state.lastDailyDate !== today) {
    state.lastDailyDate = today;
    compute('daily');
  }
}

// ---------------------------------------------------------------- HTTP
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function serveFile(res, file, type) {
  fs.readFile(file, (err, buf) => err ? send(res, 404, { error: 'not found' }) : send(res, 200, buf, type));
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') return serveFile(res, path.join(PUBLIC, 'index.html'), 'text/html; charset=utf-8');
  if (url === '/health') return send(res, 200, { ok: true, runs: state.runs, lastComputed: state.lastComputed, lastError: state.lastError, computing: state.computing });
  if (url === '/api/state') {
    return send(res, 200, {
      snapshot: state.snapshot,
      server: { lastComputed: state.lastComputed, computing: state.computing, lastError: state.lastError,
        poll_seconds: CFG.poll_seconds, daily_hour_utc: CFG.daily_hour_utc, runs: state.runs, now: new Date().toISOString() },
    });
  }
  if (url === '/api/refresh') { await compute('manual'); return send(res, 200, { ok: true, lastComputed: state.lastComputed, error: state.lastError }); }
  if (url === '/api/portfolio') {
    const name = new URL(req.url, 'http://localhost').searchParams.get('name');
    if (!name) return send(res, 400, { error: 'name query param required' });
    try { const portfolio = await db.getBuyerPortfolio(name); return send(res, 200, { name, portfolio }); }
    catch (e) { return send(res, 500, { error: e.message }); }
  }
  if (url === '/api/buyer_full') {   // per-product patterns across ALL the buyer's HS codes
    const name = new URL(req.url, 'http://localhost').searchParams.get('name');
    if (!name) return send(res, 400, { error: 'name query param required' });
    try {
      const asOf = new Date();
      const t0 = Date.now();
      const stats = {};
      const evs = await db.getBuyerAllEvents(name, 25000, stats);
      const products = eng.productPatterns(evs, asOf);
      // buyer-level summary for the top product, so the detail page works for ANY company (not just the console 8)
      let buyer = null;
      if (products.length) {
        const top = products[0];
        const matches = ((state.snapshot && state.snapshot.supplier_matches) || []).filter(m => String(m.hs || '').startsWith(top.hs6));
        const productFit = matches.length ? Math.min(95, 60 + matches.length * 3) : 90;
        buyer = eng.runBuyer(name, evs.filter(e => e.hs6 === top.hs6), top.hs6, top.desc, asOf, productFit);
        buyer.hs = top.hs6; buyer.hs_label = top.desc; buyer.importer_name = name;
      }
      // How this company's numbers were produced — real counts for THIS company, no AI anywhere.
      const merged = products.reduce((a, p) => a + ((p.dedup && p.dedup.merged) || 0), 0);
      const dates = products.map(p => p.span).filter(x => x && x[0]);
      const pipeline = {
        engine: 'deterministic rules + arithmetic (no AI / no LLM / no model inference)',
        ai_used: false,
        source_collections: ['common-service.standard_port_data'],
        enrichment_collections: ['Dhruval2.macmap_tariff', 'Dhruval2.macmap_regulatory', 'product-service.indiaProduct'],
        read_path: 'IMPORTER_NAME index (exact match)',
        db_rows: stats.db_rows, usable_rows: stats.usable_rows, dropped_rows: stats.dropped_rows,
        row_cap: stats.row_cap, capped: stats.capped, read_ms: stats.read_ms,
        duplicates_merged: merged,
        shipment_events: products.reduce((a, p) => a + p.orders, 0),
        hs_codes: products.length,
        supplier_named: stats.supplier_named,
        supplier_origin_only: stats.supplier_origin_only,
        supplier_unknown: stats.supplier_unknown,
        span: dates.length ? [dates.map(x => x[0]).sort()[0], dates.map(x => x[1]).sort().slice(-1)[0]] : null,
        formula_versions: [eng.FV.events, eng.FV.freq, eng.FV.supplier, eng.FV.score, eng.FV.product].join(' · '),
        computed_at: asOf.toISOString(), compute_ms: Date.now() - t0,
        write_policy: 'READ-ONLY — the engine never writes to MongoDB',
      };
      return send(res, 200, { name, buyer, products, pipeline });
    }
    catch (e) { return send(res, 500, { error: e.message }); }
  }
  if (url === '/api/search') {
    const q = new URL(req.url, 'http://localhost').searchParams.get('q') || '';
    const key = q.trim().toUpperCase();
    if (searchCache.has(key)) return send(res, 200, searchCache.get(key));
    try {
      const results = await db.searchCompanies(q, 25);
      const payload = { q, results, note: 'matches company names that START WITH your text (indexed); a mid-name search would scan 222M index keys' };
      if (searchCache.size > 200) searchCache.clear();
      searchCache.set(key, payload);
      return send(res, 200, payload);
    } catch (e) { return send(res, 500, { error: e.message }); }
  }
  return send(res, 404, { error: 'unknown route', routes: ['/', '/api/state', '/api/refresh', '/api/portfolio', '/health'] });
});

async function start() {
  // warm from cache for instant first paint
  try { if (fs.existsSync(CACHE)) { state.snapshot = JSON.parse(fs.readFileSync(CACHE, 'utf8')); log('warm cache loaded'); } } catch (e) { log('cache read failed:', e.message); }
  server.listen(CFG.port, () => log(`Trade Intelligence dashboard on http://0.0.0.0:${CFG.port}`));
  await compute('startup');
  state.lastDailyDate = new Date().toISOString().slice(0, 10);
  setInterval(movementCheck, CFG.poll_seconds * 1000);
  setInterval(dailyCheck, 5 * 60 * 1000);
}

process.on('SIGTERM', async () => { await db.close(); process.exit(0); });
process.on('SIGINT', async () => { await db.close(); process.exit(0); });
start();
