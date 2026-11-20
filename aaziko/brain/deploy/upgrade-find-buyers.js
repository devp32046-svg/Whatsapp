'use strict';
/*
 * Upgrade find_buyers: switch from Dhruval.buyer_intelligence (1,933 docs, keyword search)
 * to common-service.buyer_summaries (5.6M docs, HS code indexed).
 *
 * Key improvement: now accepts hs_code (6-digit) for precise HS-based buyer discovery,
 * with 5.6M records and compound index hs_codes+value for fast queries.
 * Falls back to keyword/product text search if no hs_code given.
 *
 * Also updates brain tool description to explain hs_code parameter.
 *
 * node aaziko/brain/deploy/upgrade-find-buyers.js         -- dry run
 * node aaziko/brain/deploy/upgrade-find-buyers.js --write -- apply
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate, req } = require('../../../scripts/lib/n8n-req');

const WRITE      = process.argv.includes('--write');
const FB_WF_ID   = 'WPAowCu3eKOHz4Yr';   // find_buyers sub-workflow
const BRAIN_ID   = 'w7no6uCJkz7lfaah';   // Aaziko AI Brain
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');
const CRED       = { id: '9hyaSxc0saIzUgsX', name: 'Aaziko Brain - organized (compliance)' }; // admin user, works for all DBs including common-service

const NEW_PREP = `let inp = {};
try { inp = typeof $input.first().json === "string" ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}

const hs6Raw = String(inp.hs_code || inp.hs || "").replace(/\\D/g, "").slice(0, 6);
const keyword = String(inp.keyword || inp.product || inp.query || "").trim();
const country  = String(inp.country || "").trim();
const activeOnly = inp.active_only === true || inp.active_only === "true";

if (!hs6Raw && !keyword) {
  return [{ json: { _error: "Provide hs_code (6-digit HS code, e.g. 610910) or keyword (product name)" } }];
}

const hs6 = hs6Raw ? hs6Raw.padEnd(6, "0").slice(0, 6) : null;

const matchQ = {};
if (hs6) {
  matchQ.hs_codes = hs6;
} else {
  matchQ["$text"] = { "$search": keyword };
}
if (country) matchQ.buyer_country = { "$regex": country, "$options": "i" };
if (activeOnly) matchQ.has_recent_activity = true;

// Use total_value_usd sort — covered by hs_value_sort compound index {hs_codes,total_value_usd,-1,_id}
// recommendation.priority_score has no compound index with hs_codes → forces in-memory sort on 5.6M docs = timeout
const sortQ = { "total_value_usd": -1 };

const pipeline = JSON.stringify([
  { "$match": matchQ },
  { "$sort": sortQ },
  { "$facet": { "rows": [{ "$limit": 10 }] } }
]);

return [{ json: { hs6: hs6 || null, keyword: keyword || null, country: country || null, pipeline } }];`;

const NEW_FORMAT = `const data = $input.first().json;
const prep = $("Buyer Prep").first().json;
const rows = data.rows || [];

if (prep._error) return [{ json: { ok: false, summary: prep._error } }];
if (!rows.length) {
  const what = prep.hs6 ? "HS " + prep.hs6 : prep.keyword;
  return [{ json: { ok: false, summary: "No buyers found for " + what + (prep.country ? " in " + prep.country : "") + ". Try a different HS code or keyword." } }];
}

const label = prep.hs6
  ? "HS " + prep.hs6 + (prep.country ? " buyers in " + prep.country : " buyers (global)")
  : prep.keyword + " buyers";

const lines = rows.map(function(r, i) {
  var name   = r.buyer_name || "Unknown";
  var cntry  = r.buyer_country || "?";
  var tier   = r.buyer_tier || r.recommendation && r.recommendation.priority_tier || "?";
  var score  = r.recommendation && r.recommendation.priority_score != null ? r.recommendation.priority_score.toFixed(0) : null;
  var val    = r.total_value_usd ? " | $" + (r.total_value_usd / 1e6).toFixed(1) + "M" : "";
  var active = r.has_recent_activity ? " | active" : "";
  var ship   = r.total_shipments ? " | " + r.total_shipments + " shipments" : "";
  var sc     = score != null ? " [score:" + score + "]" : "";
  return (i+1) + ". " + name + " (" + cntry + ")" + sc + val + ship + active;
}).join("\\n");

const note = "\\n\\nNote: Based on import shipment records. Verify before outreach.";
var summary = "Top buyers for " + label + ":\\n\\n" + lines + note;
return [{ json: { ok: true, summary: summary, rowCount: rows.length } }];`;

const NEW_REPLY_OK = `const r = $input.first().json;
return [{ json: { response: r.summary || r.error || "No result" } }];`;

(async () => {
  console.log('=== Upgrade: find_buyers → common-service.buyer_summaries ===');
  console.log('Old: Dhruval.buyer_intelligence (1,933 docs, keyword only)');
  console.log('New: common-service.buyer_summaries (5.6M docs, HS code indexed)\n');

  const [fbWf, brainWf] = await Promise.all([getWf(FB_WF_ID), getWf(BRAIN_ID)]);

  const prepNode   = fbWf.nodes.find(n => n.name === 'Buyer Prep');
  const mongoNode  = fbWf.nodes.find(n => n.name === 'Find Buyers');
  const fmtNode    = fbWf.nodes.find(n => n.name === 'Format Result');
  const replyNode  = fbWf.nodes.find(n => n.name === 'Reply OK');
  const brainTool  = brainWf.nodes.find(n => n.name === 'find_buyers');

  if (!prepNode || !mongoNode || !fmtNode || !replyNode) {
    console.log('❌ Nodes not found');
    process.exit(1);
  }

  console.log('Current collection:', mongoNode.parameters.collection, '| db:', mongoNode.parameters.databaseName);
  console.log('Brain tool desc:', String(brainTool && brainTool.parameters && brainTool.parameters.description || '').slice(0, 100));

  if (!WRITE) { console.log('\n(dry run — pass --write to apply)'); return; }

  const bk1 = path.join(BACKUP_DIR, FB_WF_ID + '_before_buyers-upgrade.json');
  const bk2 = path.join(BACKUP_DIR, BRAIN_ID + '_before_buyers-upgrade.json');
  fs.writeFileSync(bk1, JSON.stringify(fbWf, null, 2), 'utf8');
  fs.writeFileSync(bk2, JSON.stringify(brainWf, null, 2), 'utf8');
  console.log('Backups:', bk1, '/', bk2);

  // Upgrade find_buyers sub-workflow
  prepNode.parameters.jsCode  = NEW_PREP;
  mongoNode.parameters.collection   = 'buyer_summaries';
  mongoNode.parameters.databaseName = 'common-service';
  mongoNode.credentials = { mongoDb: CRED };
  fmtNode.parameters.jsCode   = NEW_FORMAT;
  if (replyNode.type === 'n8n-nodes-base.code') {
    replyNode.parameters.jsCode = NEW_REPLY_OK;
  } else {
    replyNode.parameters.assignments = { assignments: [{ id: '1', name: 'output', value: '={{ $json.summary || $json.error }}', type: 'string' }] };
  }

  const fbSettings = Object.assign({}, fbWf.settings);
  delete fbSettings.binaryMode;

  const r1 = await putWf(FB_WF_ID, { name: fbWf.name, nodes: fbWf.nodes, connections: fbWf.connections, settings: fbSettings });
  if (r1.status !== 200) {
    console.log('❌ PUT find_buyers failed (' + r1.status + '):', r1.body.slice(0, 300));
    process.exit(1);
  }
  await activate(FB_WF_ID);
  console.log('✅ find_buyers sub-workflow updated');

  // Update brain tool description
  if (brainTool) {
    brainTool.parameters.description =
      'Find potential buyers for a product by HS code or keyword. ' +
      'Use hs_code (6-digit, e.g. 610910 for cotton t-shirts) for best results — searches 5.6M import records. ' +
      'Optional: country to filter by buyer country. ' +
      'Returns buyer name, country, priority tier, shipment value, and activity status.';
  }

  const brainSettings = Object.assign({}, brainWf.settings);
  delete brainSettings.binaryMode;

  const r2 = await putWf(BRAIN_ID, { name: brainWf.name, nodes: brainWf.nodes, connections: brainWf.connections, settings: brainSettings });
  if (r2.status !== 200) {
    console.log('❌ PUT brain failed (' + r2.status + '):', r2.body.slice(0, 300));
    process.exit(1);
  }
  await activate(BRAIN_ID);
  console.log('✅ Brain tool description updated');

  // Verify
  const checkFb = await getWf(FB_WF_ID);
  const liveMongo = checkFb.nodes.find(n => n.name === 'Find Buyers');
  const c1 = liveMongo.parameters.collection === 'buyer_summaries';
  const c2 = liveMongo.parameters.databaseName === 'common-service';

  console.log(c1 ? '✅ collection: buyer_summaries' : '❌ collection wrong: ' + liveMongo.parameters.collection);
  console.log(c2 ? '✅ databaseName: common-service' : '❌ db wrong: ' + liveMongo.parameters.databaseName);

  if (c1 && c2) {
    console.log('\n✅ Upgrade live! Test: "Cotton t-shirt ke liye top buyers kaun hain? HS 610910"');
  } else {
    process.exit(1);
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
