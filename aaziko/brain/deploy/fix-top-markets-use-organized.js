'use strict';
/*
 * Update get_top_markets sub-workflow to query aaziko_organized.india_top_markets
 * instead of trademapsheet.india_share.
 *
 * Why: trademapsheet has no working n8n credential. We pre-aggregated the data
 * into aaziko_organized.india_top_markets (run materialize-top-markets.js first).
 * Credential "Aaziko Brain - organized (compliance)" (9hyaSxc0saIzUgsX) works.
 *
 * Also simplifies the query: findOne by hs_code instead of aggregate pipeline.
 *
 * node aaziko/brain/deploy/fix-top-markets-use-organized.js         -- verify
 * node aaziko/brain/deploy/fix-top-markets-use-organized.js --write -- deploy
 */
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { MongoClient } = require('mongodb');
const { req, getWf, putWf, activate, RROOT } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(RROOT, 'backups');
const SUB_ID = '7Apiy29NMpFOackK';
const WRITE  = process.argv.includes('--write');
const ORGANIZED_CRED = { id: '9hyaSxc0saIzUgsX', name: 'Aaziko Brain - organized (compliance)' };

const NEW_PREP_CODE = `
let inp = {};
try { inp = typeof $input.first().json === 'string' ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}

var hs_code = String(inp.hs_code || '').trim().replace(/[^0-9]/g, '');
if (!hs_code) return [{ json: { _error: 'hs_code required (6-digit, e.g. 420310)' } }];
if (hs_code.length > 6) hs_code = hs_code.slice(0, 6);
if (hs_code.length < 4) return [{ json: { _error: 'hs_code must be at least 4 digits' } }];

return [{ json: { hs_code: hs_code } }];
`.trim();

const NEW_FORMAT_CODE = `
var doc = $input.first().json;
var hs_code = doc.hs_code || $('Markets Prep').first().json.hs_code || '';

if (!doc || !doc.markets || !doc.markets.length) {
  return [{ json: { output: 'Is HS code (' + hs_code + ') ke liye export market data nahi mila.' } }];
}

var top5 = doc.markets.slice(0, 5);
var lines = top5.map(function(m, i) {
  var growthStr = '';
  if (m.growth_pct_pa !== null && m.growth_pct_pa !== undefined) {
    growthStr = ' (' + (m.growth_pct_pa > 0 ? '+' : '') + m.growth_pct_pa + '% p.a.)';
  }
  return (i + 1) + '. ' + m.country + ': $' + m.value_usd_mn + 'M' + growthStr;
});

var output = 'Top export markets for HS ' + hs_code + ' (India → world, 2025):\\n'
  + lines.join('\\n')
  + '\\n\\nIn mein se kisi ke liye tariff, compliance ya port chahiye?';

return [{ json: { hs_code: hs_code, top_markets: top5, output: output } }];
`.trim();

// Syntax check
try { new Function(NEW_PREP_CODE); console.log('✅ Markets Prep syntax OK'); }
catch(e) { console.log('❌ Markets Prep syntax error:', e.message); process.exit(1); }
try { new Function(NEW_FORMAT_CODE); console.log('✅ Format Markets syntax OK'); }
catch(e) { console.log('❌ Format Markets syntax error:', e.message); process.exit(1); }

(async () => {
  // 1. Verify aaziko_organized.india_top_markets exists and has data
  console.log('\nVerifying materialized collection...');
  const mongoClient = new MongoClient(process.env.AAZIKO_TRADE_DB_URI);
  await mongoClient.connect();
  const col = mongoClient.db('aaziko_organized').collection('india_top_markets');
  const count = await col.countDocuments();
  const sample = await col.findOne({ hs_code: '420310' });
  await mongoClient.close();

  if (count < 100) {
    console.log('❌ india_top_markets has only', count, 'docs — run materialize-top-markets.js --write first');
    process.exit(1);
  }
  console.log('✅ india_top_markets count:', count);
  if (sample) {
    console.log('  420310 markets:', sample.markets.map(m => m.country + ' $' + m.value_usd_mn + 'M').join(', '));
  }

  if (!WRITE) { console.log('\n(--write to deploy sub-wf update)'); return; }

  // 2. Backup + get sub-wf
  const sub = await getWf(SUB_ID);
  fs.writeFileSync(path.join(BACKUP_DIR, SUB_ID + '_before_organized_switch.json'), JSON.stringify(sub, null, 2), 'utf8');
  console.log('\nBackup saved. Node count:', sub.nodes.length);

  // 3. Update nodes
  const prep = sub.nodes.find(n => n.name === 'Markets Prep');
  const find = sub.nodes.find(n => n.name === 'Find Top Markets');
  const fmt  = sub.nodes.find(n => n.name === 'Format Markets');

  if (!prep || !find || !fmt) {
    console.log('❌ Expected nodes not found. Nodes:', sub.nodes.map(n=>n.name).join(', '));
    process.exit(1);
  }

  // Update prep: simpler (no pipeline needed)
  prep.parameters.jsCode = NEW_PREP_CODE;

  // Update Find Top Markets: change to findOne on aaziko_organized.india_top_markets
  find.parameters.operation  = 'findOne';
  find.parameters.database   = 'aaziko_organized';
  find.parameters.collection = 'india_top_markets';
  find.parameters.query      = '={{ JSON.stringify({ "hs_code": $json.hs_code }) }}';
  delete find.parameters.aggregate; // remove old aggregate query if present
  find.credentials = { mongoDb: ORGANIZED_CRED };

  // Update format code
  fmt.parameters.jsCode = NEW_FORMAT_CODE;

  // 4. PUT
  const settings = Object.assign({}, sub.settings); delete settings.binaryMode;
  const r = await putWf(SUB_ID, { name: sub.name, nodes: sub.nodes, connections: sub.connections, settings });
  if (r.status !== 200) {
    console.log('❌ PUT failed:', r.status, r.body.slice(0, 400));
    process.exit(1);
  }
  await activate(SUB_ID);
  console.log('✅ Sub-workflow updated and activated');

  // 5. Read-back
  const check = await getWf(SUB_ID);
  const f2 = check.nodes.find(n => n.name === 'Find Top Markets');
  const credOK = f2?.credentials?.mongoDb?.id === ORGANIZED_CRED.id;
  const dbOK   = f2?.parameters?.database === 'aaziko_organized';
  const colOK  = f2?.parameters?.collection === 'india_top_markets';
  const opOK   = f2?.parameters?.operation === 'findOne';
  console.log((credOK?'✅':'❌') + ' credential = organized');
  console.log((dbOK?'✅':'❌')   + ' database = aaziko_organized');
  console.log((colOK?'✅':'❌')  + ' collection = india_top_markets');
  console.log((opOK?'✅':'❌')   + ' operation = findOne');
  console.log('\nTest: brain pe "leather jackets export karna hai" → HS 420310 + top markets in one reply');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
