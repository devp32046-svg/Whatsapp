'use strict';
/*
 * Fix 3 issues:
 * 1. find_buyers: revert to Dhruval.buyer_intelligence with REGEX search (no text index needed)
 * 2. get_trade_stats: not being called — add explicit routing instructions to Build Context
 * 3. get_trade_agreements: not being called — same fix
 *
 * node aaziko/brain/deploy/fix-all-tools.js         -- dry run
 * node aaziko/brain/deploy/fix-all-tools.js --write -- apply
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const WRITE      = process.argv.includes('--write');
const FB_WF_ID   = 'WPAowCu3eKOHz4Yr';   // find_buyers sub-workflow
const BRAIN_ID   = 'w7no6uCJkz7lfaah';   // Aaziko AI Brain
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');
const DHRUVAL_CRED = { id: '3lzVlfXxWT73tkXl', name: 'Aaziko - Dhruval (buyers)' };

// ── Fix 1: Buyer Prep using REGEX (no text index needed) ─────────────────────
const NEW_BUYER_PREP = `let inp = {};
try { inp = typeof $input.first().json === "string" ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}

var query = String(inp.keyword || inp.product || inp.query || inp.chatInput || "").trim();
const country = String(inp.country || "").trim();
const minScore = parseInt(inp.min_score || "0", 10) || 0;

// Strip bare 6-digit HS codes — they won't match text in buyer_intelligence
query = query.replace(/\\b\\d{6}\\b/g, "").replace(/\\s+/g, " ").trim() || query;

if (!query) {
  return [{ json: { _error: "keyword required — describe the product or buyer type (e.g. cotton t-shirts, solar panels, medical equipment)" } }];
}

// Build regex from query words (no text index needed)
var words = query.split(/\\s+/).filter(function(w){ return w.length > 2; });
// Escape only characters safe to escape inside a regex alternation
var regexPat = words.map(function(w){ return w.replace(/[.*+?^()|\\[\\]]/g, '\\\\$&'); }).join('|');

const matchQ = {
  "$or": [
    { "buyer_name":       { "$regex": regexPat, "$options": "i" } },
    { "category":         { "$regex": regexPat, "$options": "i" } },
    { "suggested_product":{ "$regex": regexPat, "$options": "i" } }
  ]
};
if (country) matchQ.buyer_country = { "$regex": country, "$options": "i" };
if (minScore > 0) matchQ.score = { "$gte": minScore };

const pipeline = JSON.stringify([
  { "$match": matchQ },
  { "$sort": { "score": -1 } },
  { "$facet": { "rows": [{ "$limit": 8 }] } }
]);

return [{ json: { keyword: query, country: country || null, pipeline } }];`;

// ── Fix 1: Format Result ──────────────────────────────────────────────────────
const NEW_BUYER_FORMAT = `const data = $input.first().json;
const prep = $("Buyer Prep").first().json;
const rows = data.rows || [];

if (prep._error) return [{ json: { ok: false, error: prep._error } }];
if (!rows.length) {
  return [{ json: { ok: false, summary: "No buyers found for: " + prep.keyword + (prep.country ? " in " + prep.country : "") + ". Try broader keywords (e.g. textile instead of cotton t-shirt)." } }];
}

const lines = rows.slice(0, 6).map(function(r, i) {
  var score = r.score || 0;
  var conf  = r.deal_confidence || 0;
  var val   = r.total_value ? " | \\$" + Number(r.total_value).toLocaleString() : "";
  var sugg  = r.suggested_product ? " | sugg: " + String(r.suggested_product).slice(0, 40) : "";
  var ctry  = r.buyer_country ? " (" + r.buyer_country + ")" : "";
  return (i+1) + ". " + r.buyer_name + ctry + " | score:" + score + " | conf:" + conf + "%" + val + sugg;
}).join("\\n");

var insights = rows[0] && rows[0].insights && rows[0].insights[0]
  ? "\\n\\nTop lead insight: " + String(rows[0].insights[0]).slice(0, 120) : "";
var summary = "Top buyers for \\"" + prep.keyword + "\\":\\n\\n" + lines + insights;
return [{ json: { ok: true, summary: summary, rowCount: rows.length } }];`;

// ── Fix 2+3: Build Context — add explicit tool routing instructions ───────────
// Lines to add after WHAT YOU DO section (before the closing of that block)
const ROUTING_ADDITIONS = `
## TOOL ROUTING
- For trade volume/statistics ("how much is imported", "which country imports most", "trade flow data"): use get_trade_stats with hs_code
- For trade agreements/FTA ("what FTA does X have", "agreement between X and Y", "free trade agreement"): use get_trade_agreements with country1
- For buyer discovery ("who buys this", "find buyers", "importers of"): use find_buyers with keyword or hs_code
- For tariff/duty rates ("what is the duty", "import tax", "customs rate"): use search_tariff
- For port information ("port details", "facilities at port"): use find_port
- For trade compliance/documents ("what documents needed", "import requirements"): use get_compliance`;

(async () => {
  console.log('=== Fix: All Tools ===');
  console.log('1. find_buyers → Dhruval.buyer_intelligence with regex search');
  console.log('2+3. get_trade_stats + get_trade_agreements → explicit routing in Build Context\n');

  const [fbWf, brainWf] = await Promise.all([getWf(FB_WF_ID), getWf(BRAIN_ID)]);

  const prepNode  = fbWf.nodes.find(n => n.name === 'Buyer Prep');
  const mongoNode = fbWf.nodes.find(n => n.name === 'Find Buyers');
  const fmtNode   = fbWf.nodes.find(n => n.name === 'Format Result');

  console.log('find_buyers current:', mongoNode.parameters.collection, '/', mongoNode.parameters.databaseName);

  const bcNode = brainWf.nodes.find(n => n.name === 'Build Context');
  const code = bcNode.parameters.jsCode;
  const hasRouting = code.includes('TOOL ROUTING');
  const hasStats = code.includes('get_trade_stats');
  const hasAgreements = code.includes('get_trade_agreements');
  console.log('Build Context - has TOOL ROUTING:', hasRouting);
  console.log('Build Context - has get_trade_stats:', hasStats);
  console.log('Build Context - has get_trade_agreements:', hasAgreements);

  if (!WRITE) { console.log('\n(dry run — pass --write to apply)'); return; }

  // ── Backup ──────────────────────────────────────────────────────────────────
  const bk1 = path.join(BACKUP_DIR, FB_WF_ID + '_before_fix-all-tools.json');
  const bk2 = path.join(BACKUP_DIR, BRAIN_ID + '_before_fix-all-tools.json');
  fs.writeFileSync(bk1, JSON.stringify(fbWf, null, 2), 'utf8');
  fs.writeFileSync(bk2, JSON.stringify(brainWf, null, 2), 'utf8');
  console.log('Backups written');

  // ── Fix 1: find_buyers sub-workflow ─────────────────────────────────────────
  prepNode.parameters.jsCode  = NEW_BUYER_PREP;
  mongoNode.parameters.collection   = 'buyer_intelligence';
  mongoNode.parameters.databaseName = 'Dhruval';
  mongoNode.credentials = { mongoDb: DHRUVAL_CRED };
  fmtNode.parameters.jsCode = NEW_BUYER_FORMAT;

  const fbSettings = Object.assign({}, fbWf.settings);
  delete fbSettings.binaryMode;

  const r1 = await putWf(FB_WF_ID, { name: fbWf.name, nodes: fbWf.nodes, connections: fbWf.connections, settings: fbSettings });
  if (r1.status !== 200) { console.log('❌ find_buyers PUT failed:', r1.body.slice(0, 200)); process.exit(1); }
  await activate(FB_WF_ID);
  const c1 = await getWf(FB_WF_ID);
  const liveM = c1.nodes.find(n => n.name === 'Find Buyers');
  console.log(liveM.parameters.collection === 'buyer_intelligence' && liveM.parameters.databaseName === 'Dhruval'
    ? '✅ find_buyers → Dhruval.buyer_intelligence (regex)'
    : '❌ find_buyers wrong: ' + liveM.parameters.collection + '/' + liveM.parameters.databaseName);

  // ── Fix 2+3: Build Context — insert TOOL ROUTING before systemPrompt close ──
  if (!hasRouting) {
    // Insert before the last return statement
    const retIdx = code.lastIndexOf('return [{');
    const newCode = code.slice(0, retIdx) + '\n' +
      "// Explicit tool routing instructions\n" +
      "const toolRouting = `" + ROUTING_ADDITIONS.trim() + "`;\n" +
      "systemPrompt += '\\n\\n' + toolRouting;\n\n" +
      code.slice(retIdx);
    bcNode.parameters.jsCode = newCode;
    console.log('Build Context: TOOL ROUTING section added');
  } else {
    console.log('Build Context: TOOL ROUTING already present, skipping');
  }

  const brainSettings = Object.assign({}, brainWf.settings);
  delete brainSettings.binaryMode;

  const r2 = await putWf(BRAIN_ID, { name: brainWf.name, nodes: brainWf.nodes, connections: brainWf.connections, settings: brainSettings });
  if (r2.status !== 200) { console.log('❌ Brain PUT failed:', r2.body.slice(0, 200)); process.exit(1); }
  await activate(BRAIN_ID);
  const c2 = await getWf(BRAIN_ID);
  const liveBc = c2.nodes.find(n => n.name === 'Build Context');
  console.log(liveBc.parameters.jsCode.includes('TOOL ROUTING')
    ? '✅ Build Context: TOOL ROUTING present'
    : '❌ Build Context: TOOL ROUTING missing');

  console.log('\n✅ All fixes applied. Test:');
  console.log('  1. "Cotton t-shirt buyers kaun hain?"');
  console.log('  2. "HS 610910 import statistics"');
  console.log('  3. "India-Vietnam FTA hai kya?"');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
