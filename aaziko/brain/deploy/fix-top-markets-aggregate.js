'use strict';
/*
 * Fix get_top_markets sub-wf: change findOne → aggregate (findOne is not valid in n8n mongoDb node)
 * Query: aggregate with $match + $limit:1 on aaziko_organized.india_top_markets
 *
 * node aaziko/brain/deploy/fix-top-markets-aggregate.js --write
 */
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate, RROOT } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(RROOT, 'backups');
const SUB_ID = '7Apiy29NMpFOackK';
const WRITE  = process.argv.includes('--write');

const NEW_PREP_CODE = `
let inp = {};
try { inp = typeof $input.first().json === 'string' ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}

var hs_code = String(inp.hs_code || '').trim().replace(/[^0-9]/g, '');
if (!hs_code) return [{ json: { _error: 'hs_code required (6-digit, e.g. 420310)' } }];
if (hs_code.length > 6) hs_code = hs_code.slice(0, 6);
if (hs_code.length < 4) return [{ json: { _error: 'hs_code must be at least 4 digits' } }];

var pipeline = JSON.stringify([
  { '$match': { 'hs_code': hs_code } },
  { '$limit': 1 }
]);
return [{ json: { hs_code: hs_code, pipeline: pipeline } }];
`.trim();

const NEW_FORMAT_CODE = `
var items = $input.all();
var hs_code = $('Markets Prep').first().json.hs_code || '';

if (!items.length || !items[0].json || !items[0].json.markets || !items[0].json.markets.length) {
  return [{ json: { output: 'Is HS code (' + hs_code + ') ke liye export market data nahi mila.' } }];
}

var doc = items[0].json;
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

try { new Function(NEW_PREP_CODE); console.log('✅ Prep syntax OK'); }
catch(e) { console.log('❌ Prep:', e.message); process.exit(1); }
try { new Function(NEW_FORMAT_CODE); console.log('✅ Format syntax OK'); }
catch(e) { console.log('❌ Format:', e.message); process.exit(1); }

if (!WRITE) { console.log('(--write to deploy)'); process.exit(0); }

(async () => {
  const sub = await getWf(SUB_ID);
  fs.writeFileSync(path.join(BACKUP_DIR, SUB_ID + '_before_aggregate_fix.json'), JSON.stringify(sub, null, 2), 'utf8');
  console.log('Backup saved. nodes:', sub.nodes.length);

  const prep = sub.nodes.find(n => n.name === 'Markets Prep');
  const find = sub.nodes.find(n => n.name === 'Find Top Markets');
  const fmt  = sub.nodes.find(n => n.name === 'Format Markets');

  if (!prep || !find || !fmt) {
    console.log('❌ Expected nodes missing:', sub.nodes.map(n=>n.name).join(', '));
    process.exit(1);
  }

  prep.parameters.jsCode = NEW_PREP_CODE;

  // Change to aggregate (what n8n mongoDb node actually supports)
  find.parameters.operation  = 'aggregate';
  find.parameters.database   = 'aaziko_organized';
  find.parameters.collection = 'india_top_markets';
  find.parameters.query      = '={{ $json.pipeline }}';
  delete find.parameters.aggregate;
  find.credentials = { mongoDb: { id: '9hyaSxc0saIzUgsX', name: 'Aaziko Brain - organized (compliance)' } };
  // continueOnFail so Format can handle empty result gracefully
  if (!find.onError) find.onError = 'continueRegularOutput';

  fmt.parameters.jsCode = NEW_FORMAT_CODE;

  const settings = Object.assign({}, sub.settings); delete settings.binaryMode;
  const r = await putWf(SUB_ID, { name: sub.name, nodes: sub.nodes, connections: sub.connections, settings });
  if (r.status !== 200) { console.log('❌ PUT failed:', r.status, r.body.slice(0, 300)); process.exit(1); }
  await activate(SUB_ID);
  console.log('✅ Sub-wf updated and activated');

  const check = await getWf(SUB_ID);
  const f2 = check.nodes.find(n => n.name === 'Find Top Markets');
  const p2 = check.nodes.find(n => n.name === 'Markets Prep');
  console.log('op:', f2.parameters.operation, '| db:', f2.parameters.database, '| cred:', f2.credentials?.mongoDb?.id);
  console.log('prep has pipeline:', p2.parameters.jsCode.includes('pipeline'));
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
