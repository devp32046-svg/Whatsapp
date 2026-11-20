'use strict';
/*
 * Expand DIRECT_HS map: add leather/apparel/common goods so brain doesn't
 * need slow text search for these categories (prevents max-iterations on
 * compound queries like "leather jackets Germany export HS code?")
 *
 * node aaziko/brain/deploy/fix-direct-hs-expand.js         -- dry run
 * node aaziko/brain/deploy/fix-direct-hs-expand.js --write -- deploy
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');
const WF_ID = 'OqZH3AoC6yy8UIbz';
const WRITE = process.argv.includes('--write');

const ANCHOR = `  'cotton yarn':'520521','cotton fabric':'520811','jute yarn':'530610',`;

const NEW_LINES = [
  `  'leather jacket':'420310','leather jackets':'420310','leather coat':'420310',`,
  `  'leather bag':'420221','leather bags':'420221','leather wallet':'420232',`,
  `  'leather shoes':'640319','leather belt':'420600','leather gloves':'420161',`,
  `  'garment':'610910','t-shirt':'610910','tshirt':'610910','shirt':'620520',`,
  `  'trouser':'620342','jeans':'620342','denim':'620342','saree':'621420',`,
  `  'rice':'100630','wheat':'100190','sugar':'170111','tea':'090210','coffee':'090111',`,
  `  'plastic toys':'950300','toys':'950300','bicycle':'871200','furniture':'940360',`,
  `  'solar panel':'854140','solar panels':'854140','led bulb':'853931',`,
  `  'mobile phone':'851712','smartphone':'851712','laptop':'847130','tablet':'847130',`,
  `  'tyre':'401110','tire':'401110','tires':'401110','tyres':'401110',`,
  `  'marble':'251511','granite':'251512','ceramic tiles':'690721',`,
].join('\n');

const OLD_ANCHOR_LINE = ANCHOR;
const NEW_ANCHOR_BLOCK = ANCHOR + '\n' + NEW_LINES;

// Local tests
function testMap(input, map) {
  var q = input.toLowerCase().trim();
  for (var k in map) { if (q.indexOf(k) >= 0) return map[k]; }
  return null;
}
const TEST_MAP = {
  'leather jacket':'420310','leather jackets':'420310',
  'leather bag':'420221','leather bags':'420221',
  't-shirt':'610910','tshirt':'610910','jeans':'620342',
  'solar panel':'854140','solar panels':'854140',
  'mobile phone':'851712','smartphone':'851712',
  'tyre':'401110','tyres':'401110',
  'marble':'251511','granite':'251512',
  // existing entries must still work
  'aloo chips':'190590','gold':'710812','basmati':'100630',
};

console.log('=== Tests ===');
const tests = [
  ['leather jackets Germany export', '420310'],
  ['leather bags ke buyers', '420221'],
  ['t-shirt export karna hai', '610910'],
  ['jeans buyers USA mein', '620342'],
  ['solar panel HS code', '854140'],
  ['smartphone export', '851712'],
  ['aloo chips', '190590'],  // existing
  ['gold', '710812'],         // existing
  ['solar energy', null],     // should NOT match
];
let allPass = true;
tests.forEach(([input, expected]) => {
  const got = testMap(input, TEST_MAP);
  const pass = got === expected;
  if (!pass) allPass = false;
  console.log((pass?'✅':'❌'), `"${input}" → ${got} (expected ${expected})`);
});
console.log('\nAll tests:', allPass ? '✅ PASS' : '❌ FAIL');
if (!allPass) process.exit(1);
if (!WRITE) { console.log('\n(dry run — pass --write to deploy)'); process.exit(0); }

(async () => {
  const wf = await getWf(WF_ID);
  const node = wf.nodes.find(n => n.name === 'HS Prep');
  if (!node) { console.log('❌ HS Prep not found'); process.exit(1); }

  const code = node.parameters.jsCode;
  if (code.includes("'leather jacket'")) { console.log('Leather already present — done.'); process.exit(0); }
  if (!code.includes(OLD_ANCHOR_LINE)) { console.log('❌ Anchor not found'); process.exit(1); }

  fs.writeFileSync(path.join(BACKUP_DIR, WF_ID + '_before_hs_expand.json'), JSON.stringify(wf, null, 2), 'utf8');
  console.log('Backup saved.');

  node.parameters.jsCode = code.replace(OLD_ANCHOR_LINE, NEW_ANCHOR_BLOCK);

  try { new Function(node.parameters.jsCode); console.log('✅ Syntax OK'); }
  catch(e) { console.log('❌ Syntax error:', e.message); process.exit(1); }

  const settings = Object.assign({}, wf.settings); delete settings.binaryMode;
  const r = await putWf(WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) { console.log('❌ PUT failed:', r.body.slice(0, 300)); process.exit(1); }
  await activate(WF_ID);

  const check = await getWf(WF_ID);
  const n2 = check.nodes.find(n => n.name === 'HS Prep');
  const ok = n2.parameters.jsCode.includes("'leather jacket'") &&
             n2.parameters.jsCode.includes("'solar panel'") &&
             n2.parameters.jsCode.includes("'mobile phone'");
  console.log((ok?'✅':'❌') + ' DIRECT_HS expanded with leather/apparel/common goods');
  if (ok) console.log('\nTest: "leather jackets Germany export HS code" should now resolve quickly');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
