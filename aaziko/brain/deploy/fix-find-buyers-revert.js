'use strict';
/*
 * Fix find_buyers: revert to Dhruval.buyer_intelligence (working credential).
 *
 * Root cause: "Aaziko Brain - All DBs (shared)" credential has broken URI
 * (MongoParseError: URI contained empty userinfo section).
 *
 * Also improves Buyer Prep to strip HS codes from query text before text search.
 *
 * node aaziko/brain/deploy/fix-find-buyers-revert.js         -- dry run
 * node aaziko/brain/deploy/fix-find-buyers-revert.js --write -- apply
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const WRITE      = process.argv.includes('--write');
const FB_WF_ID   = 'WPAowCu3eKOHz4Yr';
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');
const ORIG_CRED  = { id: '3lzVlfXxWT73tkXl', name: 'Aaziko - Dhruval (buyers)' };

const NEW_PREP = `let inp = {};
try { inp = typeof $input.first().json === "string" ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}

var query = String(inp.keyword || inp.product || inp.query || inp.chatInput || "").trim();
const country = String(inp.country || "").trim();
const minScore = parseInt(inp.min_score || "0", 10) || 0;

// Strip bare 6-digit HS codes — they won't match text in buyer_intelligence
query = query.replace(/\\b\\d{6}\\b/g, "").replace(/\\s+/g, " ").trim() || query;

if (!query) {
  return [{ json: { _error: "keyword required — describe the product or buyer type (e.g. cotton t-shirts, solar panels, medical equipment)" } }];
}

const matchQ = { "$text": { "$search": query } };
if (country) matchQ.buyer_country = { "$regex": country, "$options": "i" };
if (minScore > 0) matchQ.score = { "$gte": minScore };

const pipeline = JSON.stringify([
  { "$match": matchQ },
  { "$sort": { "score": -1 } },
  { "$facet": { "rows": [{ "$limit": 8 }] } }
]);

return [{ json: { keyword: query, country: country || null, pipeline } }];`;

const NEW_FORMAT = `const data = $input.first().json;
const prep = $("Buyer Prep").first().json;
const rows = data.rows || [];

if (prep._error) return [{ json: { ok: false, error: prep._error } }];
if (!rows.length) {
  return [{ json: { ok: false, summary: "No buyers found for: " + prep.keyword + (prep.country ? " in " + prep.country : "") + ". Try broader keywords (e.g. textile instead of cotton t-shirt)." } }];
}

const lines = rows.slice(0, 6).map(function(r, i) {
  var score = r.score || 0;
  var conf = r.deal_confidence || 0;
  var val = r.total_value ? " | \\$" + Number(r.total_value).toLocaleString() : "";
  var sugg = r.suggested_product ? " | sugg: " + String(r.suggested_product).slice(0, 40) : "";
  var country = r.buyer_country ? " (" + r.buyer_country + ")" : "";
  return (i+1) + ". " + r.buyer_name + country + " | score:" + score + " | conf:" + conf + "%" + val + sugg;
}).join("\\n");

var insights = rows[0] && rows[0].insights ? "\\n\\nTop lead insight: " + String(rows[0].insights).slice(0, 120) : "";
var summary = "Top buyers for \\"" + prep.keyword + "\\":\\n\\n" + lines + insights;
return [{ json: { ok: true, summary: summary, rowCount: rows.length } }];`;

(async () => {
  console.log('=== Fix: find_buyers revert to Dhruval.buyer_intelligence ===');
  console.log('Problem: All-DBs credential has broken URI, common-service unreachable from n8n');
  console.log('Fix: revert to working Dhruval credential + improve keyword prep\n');

  const wf = await getWf(FB_WF_ID);
  const prepNode  = wf.nodes.find(n => n.name === 'Buyer Prep');
  const mongoNode = wf.nodes.find(n => n.name === 'Find Buyers');
  const fmtNode   = wf.nodes.find(n => n.name === 'Format Result');

  console.log('Current collection:', mongoNode.parameters.collection, '| cred:', mongoNode.credentials && mongoNode.credentials.mongoDb && mongoNode.credentials.mongoDb.id);

  if (!WRITE) { console.log('\n(dry run — pass --write to apply)'); return; }

  const bk = path.join(BACKUP_DIR, FB_WF_ID + '_before_revert.json');
  fs.writeFileSync(bk, JSON.stringify(wf, null, 2), 'utf8');
  console.log('Backup:', bk);

  prepNode.parameters.jsCode  = NEW_PREP;
  mongoNode.parameters.collection   = 'buyer_intelligence';
  mongoNode.parameters.databaseName = 'Dhruval';
  mongoNode.credentials = { mongoDb: ORIG_CRED };
  fmtNode.parameters.jsCode   = NEW_FORMAT;
  wf.settings.saveDataSuccessExecution = 'none'; // disable debug logging

  const r = await putWf(FB_WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings });
  if (r.status !== 200) {
    console.log('❌ PUT failed (' + r.status + '):', r.body.slice(0, 300));
    process.exit(1);
  }
  await activate(FB_WF_ID);

  const check = await getWf(FB_WF_ID);
  const liveMongo = check.nodes.find(n => n.name === 'Find Buyers');
  const c1 = liveMongo.parameters.collection === 'buyer_intelligence';
  const c2 = liveMongo.parameters.databaseName === 'Dhruval';
  const c3 = liveMongo.credentials && liveMongo.credentials.mongoDb && liveMongo.credentials.mongoDb.id === ORIG_CRED.id;

  console.log(c1 ? '✅ collection: buyer_intelligence' : '❌ ' + liveMongo.parameters.collection);
  console.log(c2 ? '✅ databaseName: Dhruval' : '❌ db: ' + liveMongo.parameters.databaseName);
  console.log(c3 ? '✅ credential: Aaziko - Dhruval (buyers)' : '❌ credential wrong');

  if (c1 && c2 && c3) console.log('\n✅ find_buyers reverted to working Dhruval source');
  else process.exit(1);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
