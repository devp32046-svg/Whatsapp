'use strict';
/*
 * Upgrade find_buyers to hybrid:
 *   HS code present → shortlist_buyer_seller (9.8M, indexed, range query)
 *   keyword only    → buyer_intelligence (1,933, clean scored data)
 *
 * node aaziko/brain/deploy/fix-find-buyers-hybrid.js         -- dry run
 * node aaziko/brain/deploy/fix-find-buyers-hybrid.js --write -- deploy
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');
const FB_ID = 'WPAowCu3eKOHz4Yr';
const DHRUVAL_CRED = { id: '3lzVlfXxWT73tkXl', name: 'Aaziko - Dhruval (buyers)' };
const WRITE = process.argv.includes('--write');

// ── Updated Buyer Prep ────────────────────────────────────────────────────────
const NEW_BUYER_PREP = `let inp = {};
try { inp = typeof $input.first().json === "string" ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}

var query   = String(inp.keyword || inp.product || inp.query || inp.chatInput || "").trim();
const country  = String(inp.country || "").trim();
const minScore = parseInt(inp.min_score || "0", 10) || 0;

// Extract HS code from query (4-6 digits)
var hsRaw = String(inp.hs_code || inp.hs || "").replace(/\\D/g, "").slice(0, 6);
if (!hsRaw) {
  var hsMat = query.match(/\\b([0-9]{4,6})\\b/);
  if (hsMat) { hsRaw = hsMat[1]; query = query.replace(hsMat[0], "").replace(/\\s+/g," ").trim(); }
}

// Strip bare 6-digit HS codes from keyword text
query = query.replace(/\\b\\d{6}\\b/g, "").replace(/\\s+/g, " ").trim() || query;

// Decide route
const useShortlist = hsRaw.length >= 4;

if (useShortlist) {
  // Build 10-digit range: hs6 padded to 10 digits
  const hs6 = hsRaw.padEnd(6, "0").slice(0, 6);
  const rangeMin = parseInt(hs6.padEnd(10, "0"));
  const rangeMax = parseInt(hs6.padEnd(10, "9"));
  const matchQ = { type: "buyer", hsCodes: { "$elemMatch": { "$gte": rangeMin, "$lte": rangeMax } } };
  if (country) matchQ.country = { "$regex": country, "$options": "i" };

  const pipeline = JSON.stringify([
    { "$match": matchQ },
    { "$sort": { "transactionCount": -1, "totalAmount": -1 } },
    { "$facet": {
      "rows": [
        { "$limit": 10 },
        { "$project": { "name": 1, "country": 1, "transactionCount": 1, "totalAmount": 1, "apollo_free.domain": 1, "apollo_free.contacts": 1 } }
      ],
      "total": [{ "$count": "n" }]
    }}
  ]);
  return [{ json: { hs6, hsRaw, country: country || null, useShortlist: true, pipeline } }];
}

// Keyword path → buyer_intelligence
if (!query) {
  return [{ json: { _error: "keyword or hs_code required — e.g. cotton t-shirts, solar panels, or HS code 610910" } }];
}

var words = query.split(/\\s+/).filter(function(w){ return w.length > 2; });
var regexPat = words.map(function(w){ return w.replace(/[.*+?^()|\\[\\]]/g, "\\\\$&"); }).join("|");

const matchQ2 = {
  "$or": [
    { "buyer_name":        { "$regex": regexPat, "$options": "i" } },
    { "category":          { "$regex": regexPat, "$options": "i" } },
    { "suggested_product": { "$regex": regexPat, "$options": "i" } }
  ]
};
if (country) matchQ2.buyer_country = { "$regex": country, "$options": "i" };
if (minScore > 0) matchQ2.score = { "$gte": minScore };

const pipeline2 = JSON.stringify([
  { "$match": matchQ2 },
  { "$sort": { "score": -1 } },
  { "$facet": { "rows": [{ "$limit": 8 }] } }
]);
return [{ json: { keyword: query, country: country || null, useShortlist: false, pipeline: pipeline2 } }];`;

// ── Updated Format Result ─────────────────────────────────────────────────────
const NEW_FORMAT = `const prep = $("Buyer Prep").first().json;
// Get data from whichever mongo node ran
var data = {};
try { data = $input.first().json; } catch(e) {}
const rows = (data.rows || []).flat ? (data.rows || []).flat() : (data.rows || []);

if (prep._error) return [{ json: { ok: false, error: prep._error } }];

if (!rows.length) {
  var noResultMsg = prep.useShortlist
    ? "HS " + prep.hs6 + " ke liye koi buyer nahi mila" + (prep.country ? " in " + prep.country : "") + ". Try broader HS code (4-digit)."
    : "No buyers found for: " + (prep.keyword||"") + (prep.country ? " in " + prep.country : "") + ". Try broader keywords.";
  return [{ json: { ok: false, summary: noResultMsg } }];
}

var total = data.total && data.total[0] ? data.total[0].n : rows.length;
var lines;

if (prep.useShortlist) {
  // Shortlist (customs data) format
  lines = rows.slice(0, 8).map(function(r, i) {
    var val  = r.totalAmount ? " | $" + Number(r.totalAmount).toLocaleString("en-IN", {maximumFractionDigits:0}) : "";
    var txns = r.transactionCount ? " | " + r.transactionCount + " shipments" : "";
    var ctry = r.country ? " (" + r.country + ")" : "";
    var site = r.apollo_free && r.apollo_free.domain ? " | " + r.apollo_free.domain : "";
    return (i+1) + ". " + r.name + ctry + txns + val + site;
  }).join("\\n");
  var summary = "HS " + prep.hs6 + " ke top buyers (" + total.toLocaleString() + " total):\\n\\n" + lines;
  if (prep.country) summary = "HS " + prep.hs6 + " buyers in " + prep.country + " (" + total.toLocaleString() + " total):\\n\\n" + lines;
  return [{ json: { ok: true, summary, rowCount: rows.length, total } }];
}

// buyer_intelligence format
lines = rows.slice(0, 6).map(function(r, i) {
  var score = r.score || 0;
  var conf  = r.deal_confidence || 0;
  var val   = r.total_value ? " | $" + Number(r.total_value).toLocaleString() : "";
  var sugg  = r.suggested_product ? " | sugg: " + String(r.suggested_product).slice(0, 40) : "";
  var ctry  = r.buyer_country ? " (" + r.buyer_country + ")" : "";
  return (i+1) + ". " + r.buyer_name + ctry + " | score:" + score + " | conf:" + conf + "%" + val + sugg;
}).join("\\n");
var insights = rows[0] && rows[0].insights && rows[0].insights[0]
  ? "\\n\\nTop lead insight: " + String(rows[0].insights[0]).slice(0, 120) : "";
return [{ json: { ok: true, summary: "Top buyers for \\"" + prep.keyword + "\\":\\n\\n" + lines + insights, rowCount: rows.length } }];`;

// ── Local tests ───────────────────────────────────────────────────────────────
function testPrep(inp) {
  var query = String(inp.keyword || inp.product || inp.query || inp.chatInput || '').trim();
  var hsRaw = String(inp.hs_code || inp.hs || '').replace(/\D/g,'').slice(0,6);
  if (!hsRaw) { var m = query.match(/\b([0-9]{4,6})\b/); if (m) hsRaw = m[1]; }
  return { useShortlist: hsRaw.length >= 4, hs: hsRaw, keyword: query };
}

(async () => {
  console.log('=== Fix: find_buyers hybrid (HS → shortlist_buyer_seller, keyword → buyer_intelligence) ===\n');

  const tests = [
    [{query:'610910'},                   {useShortlist:true,  hs:'610910'}],
    [{hs_code:'6109'},                   {useShortlist:true,  hs:'6109'}],
    [{query:'cotton t-shirts'},          {useShortlist:false, hs:''}],
    [{keyword:'solar panels'},           {useShortlist:false, hs:''}],
    [{query:'cotton t-shirts 610910'},   {useShortlist:true,  hs:'610910'}],
    [{query:'HS 6109 buyers'},           {useShortlist:true,  hs:'6109'}],
  ];
  let allPass = true;
  tests.forEach(([inp, expected]) => {
    const got = testPrep(inp);
    const pass = got.useShortlist === expected.useShortlist && got.hs === expected.hs;
    if (!pass) allPass = false;
    console.log((pass?'✅':'❌'), JSON.stringify(inp), '→ useShortlist:', got.useShortlist, '| hs:', got.hs || '(none)', pass?'':'  EXPECTED', pass?'':JSON.stringify(expected));
  });
  if (!allPass) { console.log('\nTests failed — not deploying'); process.exit(1); }
  console.log('\nAll tests pass.\n');

  if (!WRITE) { console.log('(dry run — pass --write to deploy)'); return; }

  const wf = await getWf(FB_ID);
  fs.writeFileSync(path.join(BACKUP_DIR, FB_ID + '_before_hybrid.json'), JSON.stringify(wf, null, 2), 'utf8');
  console.log('Backup saved.\n');

  // ── Update Buyer Prep ───────────────────────────────────────────────────────
  const prepNode = wf.nodes.find(n => n.name === 'Buyer Prep');
  prepNode.parameters.jsCode = NEW_BUYER_PREP;

  // ── Update Format Result ────────────────────────────────────────────────────
  const fmtNode = wf.nodes.find(n => n.name === 'Format Result');
  fmtNode.parameters.jsCode = NEW_FORMAT;

  // ── Add Route: HS Code? (if node) ──────────────────────────────────────────
  const gateNode  = wf.nodes.find(n => n.name === 'Gate: Error?');
  const findNode  = wf.nodes.find(n => n.name === 'Find Buyers');

  // Position new nodes between Gate:Error? false and Find Buyers
  const routeNode = {
    id: 'route-hs-code-001',
    name: 'Route: HS Code?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2,
    position: [findNode.position[0] - 220, findNode.position[1] - 60],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{
          id: 'cond-hs-001',
          leftValue: '={{ $json.useShortlist }}',
          rightValue: true,
          operator: { type: 'boolean', operation: 'true' }
        }],
        combinator: 'and'
      }
    }
  };

  // New shortlist mongo node
  const shortlistNode = {
    id: 'find-buyers-shortlist-001',
    name: 'Find Buyers Shortlist',
    type: 'n8n-nodes-base.mongoDb',
    typeVersion: 1,
    position: [findNode.position[0] + 20, findNode.position[1] - 160],
    credentials: { mongoDb: DHRUVAL_CRED },
    parameters: {
      operation: 'aggregate',
      collection: 'shortlist_buyer_seller',
      databaseName: 'Dhruval',
      query: '={{ $json.pipeline }}'
    }
  };

  // Rename existing Find Buyers → Find Buyers Intelligence
  findNode.name = 'Find Buyers Intelligence';
  findNode.position = [findNode.position[0] + 20, findNode.position[1] + 80];

  wf.nodes.push(routeNode, shortlistNode);

  // ── Rewire connections ──────────────────────────────────────────────────────
  const conn = wf.connections;

  // Gate: Error? false (index 1) was going to 'Find Buyers' — now goes to 'Route: HS Code?'
  if (conn['Gate: Error?'] && conn['Gate: Error?'].main && conn['Gate: Error?'].main[1]) {
    conn['Gate: Error?'].main[1] = [{ node: 'Route: HS Code?', type: 'main', index: 0 }];
  }

  // Route: HS Code? true → Find Buyers Shortlist
  // Route: HS Code? false → Find Buyers Intelligence
  conn['Route: HS Code?'] = {
    main: [
      [{ node: 'Find Buyers Shortlist',    type: 'main', index: 0 }],  // true
      [{ node: 'Find Buyers Intelligence', type: 'main', index: 0 }]   // false
    ]
  };

  // Find Buyers Shortlist → Format Result
  conn['Find Buyers Shortlist'] = {
    main: [[{ node: 'Format Result', type: 'main', index: 0 }]]
  };

  // Find Buyers Intelligence → Format Result (was 'Find Buyers')
  if (conn['Find Buyers']) {
    conn['Find Buyers Intelligence'] = conn['Find Buyers'];
    delete conn['Find Buyers'];
  }

  const settings = Object.assign({}, wf.settings);
  delete settings.binaryMode;

  const r = await putWf(FB_ID, { name: wf.name, nodes: wf.nodes, connections: conn, settings });
  if (r.status !== 200) { console.log('❌ PUT failed:', r.body.slice(0,300)); process.exit(1); }
  await activate(FB_ID);

  // Verify
  const check = await getWf(FB_ID);
  const hasRoute    = check.nodes.some(n => n.name === 'Route: HS Code?');
  const hasShortlist= check.nodes.some(n => n.name === 'Find Buyers Shortlist');
  const hasIntel    = check.nodes.some(n => n.name === 'Find Buyers Intelligence');
  const prepOk      = check.nodes.find(n => n.name === 'Buyer Prep').parameters.jsCode.includes('useShortlist');

  console.log('Route node:', hasRoute ? '✅' : '❌');
  console.log('Shortlist node:', hasShortlist ? '✅' : '❌');
  console.log('Intelligence node:', hasIntel ? '✅' : '❌');
  console.log('Prep code updated:', prepOk ? '✅' : '❌');

  if (hasRoute && hasShortlist && hasIntel && prepOk) {
    console.log('\n✅ Hybrid find_buyers deployed!');
    console.log('  HS code → shortlist_buyer_seller (9.8M)');
    console.log('  keyword → buyer_intelligence (1,933)');
    console.log('\nTest: "HS 610910 ke buyers kaun hain?"');
    console.log('Test: "Cotton t-shirt buyers" (keyword path)');
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
