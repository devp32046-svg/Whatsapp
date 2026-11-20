'use strict';
/*
 * Fix find_buyers keyword path quality:
 * 1. Buyer Prep: OR→AND match per word (each word must appear in at least one field)
 * 2. Format Result: filter deal_confidence < MIN_CONF (default 25%), fallback to top-3 with warning
 *
 * node aaziko/brain/deploy/fix-buyer-keyword-quality.js         -- dry run
 * node aaziko/brain/deploy/fix-buyer-keyword-quality.js --write -- deploy
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');
const WF_ID = 'WPAowCu3eKOHz4Yr';
const WRITE = process.argv.includes('--write');

// ── Anchors (exact strings from live code) ───────────────────────────────────
const OLD_PREP_ANCHOR = `var words = query.split(/\\s+/).filter(function(w){ return w.length > 2; });
var regexPat = words.map(function(w){ return w.replace(/[.*+?^()|\\[\\]]/g, "\\\\$&"); }).join("|");

const matchQ2 = {
  "$or": [
    { "buyer_name":        { "$regex": regexPat, "$options": "i" } },
    { "category":          { "$regex": regexPat, "$options": "i" } },
    { "suggested_product": { "$regex": regexPat, "$options": "i" } }
  ]
};`;

const NEW_PREP_BLOCK = `var words = query.split(/\\s+/).filter(function(w){ return w.length > 2; });
// AND match: every word must appear in at least one of (buyer_name, category, suggested_product)
// Prevents "plastic|toys" OR matching unrelated companies like rice/coffee firms
var wordConditions = words.map(function(w) {
  var esc = w.replace(/[.*+?^()|\\[\\]]/g, "\\\\$&");
  return { "$or": [
    { "buyer_name":        { "$regex": esc, "$options": "i" } },
    { "category":          { "$regex": esc, "$options": "i" } },
    { "suggested_product": { "$regex": esc, "$options": "i" } }
  ]};
});
const matchQ2 = wordConditions.length === 1 ? wordConditions[0] : { "$and": wordConditions };`;

const OLD_FMT_ANCHOR = `// buyer_intelligence format
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

const NEW_FMT_BLOCK = `// buyer_intelligence format — filter low-confidence results
var MIN_CONF = 25; // below 25% deal_confidence = not relevant enough to show
var goodRows = rows.filter(function(r){ return (r.deal_confidence || 0) >= MIN_CONF; });
var displayRows = goodRows.length >= 2 ? goodRows : rows; // fallback if too few pass threshold
var lowConfWarning = (goodRows.length === 0 && rows.length > 0)
  ? "\\n\\n⚠️ Note: Exact matches low-confidence — results may not be specific to this product."
  : "";
lines = displayRows.slice(0, 6).map(function(r, i) {
  var score = r.score || 0;
  var conf  = r.deal_confidence || 0;
  var val   = r.total_value ? " | $" + Number(r.total_value).toLocaleString() : "";
  var sugg  = r.suggested_product ? " | sugg: " + String(r.suggested_product).slice(0, 40) : "";
  var ctry  = r.buyer_country ? " (" + r.buyer_country + ")" : "";
  return (i+1) + ". " + r.buyer_name + ctry + " | score:" + score + " | conf:" + conf + "%" + val + sugg;
}).join("\\n");
var insights = displayRows[0] && displayRows[0].insights && displayRows[0].insights[0]
  ? "\\n\\nTop lead insight: " + String(displayRows[0].insights[0]).slice(0, 120) : "";
return [{ json: { ok: true, summary: "Top buyers for \\"" + prep.keyword + "\\":\\n\\n" + lines + insights + lowConfWarning, rowCount: displayRows.length } }];`;

// ── Local simulation tests ────────────────────────────────────────────────────
function testAndMatch(query, buyers) {
  const words = query.split(/\s+/).filter(w => w.length > 2);
  return buyers.filter(b => words.every(w => {
    const re = new RegExp(w.replace(/[.*+?^()|[\]]/g, '\\$&'), 'i');
    return re.test(b.buyer_name) || re.test(b.category || '') || re.test(b.suggested_product || '');
  }));
}

function testConfFilter(rows, minConf) {
  const good = rows.filter(r => (r.deal_confidence || 0) >= minConf);
  return good.length >= 2 ? good : rows;
}

console.log('=== Fix: find_buyers keyword quality ===\n');
console.log('--- Test 1: AND match vs OR match ---');

const mockBuyers = [
  { buyer_name: 'RISO SCOTTI SPA',      category: 'rice food',              suggested_product: 'plastic packaging', deal_confidence: 9  },
  { buyer_name: 'SLINGCO AMERICA INC',  category: 'plastic toys',           suggested_product: 'plastic toys',      deal_confidence: 100 },
  { buyer_name: 'LT FOODS AMERICAS',    category: 'food',                   suggested_product: 'plastic containers', deal_confidence: 10 },
  { buyer_name: 'HASBRO INC',           category: 'plastic toys games',     suggested_product: 'plastic toys',      deal_confidence: 85 },
];

const matched = testAndMatch('plastic toys', mockBuyers);
console.log('After AND match for "plastic toys":', matched.map(b => b.buyer_name));

const tests = [
  ['RISO SCOTTI should NOT match (plastic but no toys in name/cat/sugg)', !matched.find(b => b.buyer_name === 'RISO SCOTTI SPA')],
  ['SLINGCO should match (has plastic toys in category+suggested)',         !!matched.find(b => b.buyer_name === 'SLINGCO AMERICA INC')],
  ['HASBRO should match (has plastic toys in category+suggested)',           !!matched.find(b => b.buyer_name === 'HASBRO INC')],
];

console.log('\n--- Test 2: Confidence threshold ---');
const mockRows = [
  { buyer_name: 'TCHIBO GMBH',           deal_confidence: 21 },
  { buyer_name: 'ZEEMAN TEXTIELSUPERS',  deal_confidence: 35 },
  { buyer_name: 'TRUST BANK PLC',        deal_confidence: 11 },
  { buyer_name: 'MONOPRIX EXPLOITATION', deal_confidence: 64 },
];
const filtered = testConfFilter(mockRows, 25);
tests.push(['Conf filter: ZEEMAN(35)+MONOPRIX(64) kept', filtered.length === 2 && filtered.every(r => r.deal_confidence >= 25)]);
tests.push(['Conf filter: TCHIBO(21)+TRUSTBANK(11) dropped', !filtered.find(r => r.deal_confidence < 25)]);

let allPass = true;
tests.forEach(([label, pass]) => {
  console.log((pass ? '✅' : '❌'), label);
  if (!pass) allPass = false;
});

console.log('\nAll tests:', allPass ? '✅ PASS' : '❌ FAIL');
if (!allPass) { process.exit(1); }

if (!WRITE) { console.log('\n(dry run — pass --write to deploy)'); process.exit(0); }

// ── Deploy ────────────────────────────────────────────────────────────────────
(async () => {
  const wf   = await getWf(WF_ID);
  const prep = wf.nodes.find(n => n.name === 'Buyer Prep');
  const fmt  = wf.nodes.find(n => n.name === 'Format Result');
  if (!prep || !fmt) { console.log('❌ Nodes not found'); process.exit(1); }

  const prepCode = prep.parameters.jsCode;
  const fmtCode  = fmt.parameters.jsCode;

  if (!prepCode.includes('var regexPat')) { console.log('❌ Cannot find anchor in Buyer Prep'); process.exit(1); }
  if (!fmtCode.includes('buyer_intelligence format')) { console.log('❌ Cannot find anchor in Format Result'); process.exit(1); }

  if (prepCode.includes('wordConditions') && fmtCode.includes('MIN_CONF')) {
    console.log('Both fixes already deployed.'); process.exit(0);
  }

  fs.writeFileSync(path.join(BACKUP_DIR, WF_ID + '_before_buyer_quality.json'), JSON.stringify(wf, null, 2), 'utf8');
  console.log('\nBackup saved.');

  if (!prepCode.includes('wordConditions')) prep.parameters.jsCode = prepCode.replace(OLD_PREP_ANCHOR, NEW_PREP_BLOCK);
  if (!fmtCode.includes('MIN_CONF'))        fmt.parameters.jsCode  = fmtCode.replace(OLD_FMT_ANCHOR, NEW_FMT_BLOCK);

  // Verify anchors were found and replaced
  if (!prep.parameters.jsCode.includes('wordConditions')) { console.log('❌ Prep anchor replace failed — text mismatch'); process.exit(1); }
  if (!fmt.parameters.jsCode.includes('MIN_CONF'))        { console.log('❌ Fmt anchor replace failed — text mismatch'); process.exit(1); }

  const settings = Object.assign({}, wf.settings); delete settings.binaryMode;
  const r = await putWf(WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) { console.log('❌ PUT failed:', r.body.slice(0, 300)); process.exit(1); }
  await activate(WF_ID);

  const check = await getWf(WF_ID);
  const p2 = check.nodes.find(n => n.name === 'Buyer Prep');
  const f2 = check.nodes.find(n => n.name === 'Format Result');
  const ok = p2.parameters.jsCode.includes('wordConditions') && f2.parameters.jsCode.includes('MIN_CONF');
  console.log((ok ? '✅' : '❌') + ' find_buyers quality fix deployed (AND match + conf threshold)');
  if (ok) {
    console.log('\nVerify: "plastic toys USA" should NOT return RISO SCOTTI or LT FOODS');
    console.log('Verify: "organic spices" should NOT return TCHIBO GMBH (21%) or TRUST BANK (11%)');
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
