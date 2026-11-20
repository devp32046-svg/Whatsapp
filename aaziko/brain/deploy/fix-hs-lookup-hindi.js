'use strict';
/*
 * Fix lookup_hs_code: add direct HS shortcuts for Indian food/product terms
 * + fix broken \s+ split (backslash was lost) + use productNormalized in search
 *
 * node aaziko/brain/deploy/fix-hs-lookup-hindi.js         -- dry run
 * node aaziko/brain/deploy/fix-hs-lookup-hindi.js --write -- deploy
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');
const WF_ID = 'OqZH3AoC6yy8UIbz';
const WRITE = process.argv.includes('--write');

// The new clean HS Prep code (written as a plain string, no template literal tricks)
const NEW_HS_PREP_CODE = [
  "let inp = {};",
  "try { inp = typeof $input.first().json === 'string' ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}",
  "",
  "const hsRaw = String(inp.hs_code || inp.hs || '').replace(/\\D/g, '').slice(0, 6);",
  "const productName = String(inp.product_name || inp.product || inp.keyword || '').trim();",
  "",
  "if (!hsRaw && !productName) {",
  "  return [{ json: { _error: 'Provide hs_code (6-digit, e.g. 520100) or product_name (e.g. cotton t-shirt)' } }];",
  "}",
  "",
  "// Direct HS shortcuts: Indian compound food/product phrases bypass text search",
  "var DIRECT_HS = {",
  "  'aloo chips':'190590','aloo wafer':'190590','potato chips':'190590','potato wafer':'190590',",
  "  'namkeen':'190590','farsan':'190590','bhujia':'190590','chakli':'190590',",
  "  'papad':'190508','pappad':'190508','papadum':'190508',",
  "  'basmati rice':'100630','basmati':'100630',",
  "  'masoor dal':'071340','toor dal':'071340','chana dal':'071320','dal':'071340','daal':'071340',",
  "  'atta':'110100','wheat flour':'110100','maida':'110100','besan':'110630',",
  "  'haldi powder':'091030','jeera':'090920','cumin':'090920','adrak':'091011','sarson':'120510',",
  "  'cotton yarn':'520521','cotton fabric':'520811','jute yarn':'530610'",
  "};",
  "var _qLower = productName.toLowerCase().trim();",
  "var _directHs = null;",
  "for (var _dKey in DIRECT_HS) {",
  "  if (_qLower.indexOf(_dKey) >= 0) { _directHs = DIRECT_HS[_dKey]; break; }",
  "}",
  "",
  "// Hindi word->English single-word normalization (for non-shortcut terms)",
  "var HINDI_EN = {",
  "  aloo:'potato',aalu:'potato',alu:'potato',",
  "  chips:'crisp',wafer:'crisp',",
  "  chawal:'rice',chaawal:'rice',",
  "  gehun:'wheat',gehu:'wheat',",
  "  sarso:'mustard',sarson:'mustard',",
  "  jeera:'cumin',zeera:'cumin',",
  "  mirchi:'pepper',mirch:'pepper',",
  "  haldi:'turmeric',adrak:'ginger',",
  "  chai:'tea',chay:'tea',",
  "  kapas:'cotton',kapda:'textile',",
  "  loha:'iron',tamba:'copper',",
  "  gadi:'vehicle',dawai:'pharmaceutical',dawa:'pharmaceutical',",
  "  dal:'lentil',daal:'lentil'",
  "};",
  "var _normWords = productName.toLowerCase().split(/\\s+/).map(function(w){ return HINDI_EN[w] || w; });",
  "var productNormalized = _normWords.join(' ');",
  "",
  "var pipeline;",
  "",
  "if (hsRaw) {",
  "  pipeline = JSON.stringify([",
  "    {'$match': {'applicability.product.hs6': hsRaw}},",
  "    {'$facet': {'rows': [{'$limit': 10}]}}",
  "  ]);",
  "} else if (_directHs) {",
  "  // Direct shortcut: query by HS code using same field as the hsRaw path",
  "  pipeline = JSON.stringify([",
  "    {'$match': {'applicability.product.hs6': _directHs}},",
  "    {'$facet': {'rows': [{'$limit': 5}]}}",
  "  ]);",
  "  return [{ json: { hs: _directHs, product_name: productName, pipeline: pipeline } }];",
  "} else {",
  "  var words = productNormalized.split(/\\s+/).filter(function(w){ return w.length > 3; });",
  "  if (!words.length) words = [productNormalized];",
  "",
  "  function escRe(w) { return w.replace(/[.*+?^$()|[{\\\\]/g, '\\\\$&'); }",
  "",
  "  var andClauses = words.map(function(w) {",
  "    var pat = escRe(w);",
  "    return {'$or': [",
  "      {'structured.product_name': {'$regex': pat, '$options': 'i'}},",
  "      {'text': {'$regex': pat, '$options': 'i'}}",
  "    ]};",
  "  });",
  "",
  "  var matchQ = andClauses.length === 1 ? andClauses[0] : {'$and': andClauses};",
  "  pipeline = JSON.stringify([",
  "    {'$match': matchQ},",
  "    {'$facet': {'rows': [{'$limit': 10}]}}",
  "  ]);",
  "}",
  "",
  "return [{ json: { hs: hsRaw || null, product_name: productName || null, pipeline: pipeline } }];"
].join('\n');

// ── Local tests ───────────────────────────────────────────────────────────────
function testDirectHs(input) {
  var DIRECT = {
    'aloo chips':'190590','aloo wafer':'190590','potato chips':'190590',
    'namkeen':'190590','farsan':'190590','bhujia':'190590',
    'papad':'190508','basmati':'100630','dal':'071340','daal':'071340',
    'atta':'110100','wheat flour':'110100','maida':'110100','besan':'110630',
    'jeera':'090920','cumin':'090920','cotton yarn':'520521'
  };
  var q = input.toLowerCase().trim();
  for (var k in DIRECT) { if (q.indexOf(k) >= 0) return DIRECT[k]; }
  return null;
}

function testNorm(word) {
  var MAP = {aloo:'potato',aalu:'potato',chips:'crisp',chawal:'rice',gehun:'wheat',dal:'lentil',daal:'lentil'};
  return MAP[word] || word;
}

console.log('=== Tests ===');
const tests = [
  ['aloo chips aur namkeen', '190590'],
  ['namkeen export karna hai', '190590'],
  ['basmati rice ka HS code', '100630'],
  ['dal supplier dhundho', '071340'],
  ['cotton yarn buyer', '520521'],
  ['cotton t-shirt', null],     // should NOT match (not in direct map)
  ['solar panels India', null], // should NOT match
];
let allPass = true;
tests.forEach(([input, expected]) => {
  const got = testDirectHs(input);
  const pass = got === expected;
  if (!pass) allPass = false;
  console.log((pass ? '✅' : '❌'), `"${input}" -> ${got} (expected ${expected})`);
});

// Also test word normalization
console.log('\nNorm tests:');
[['aloo','potato'],['chips','crisp'],['chawal','rice'],['cotton','cotton']].forEach(([w,exp]) => {
  const got = testNorm(w);
  const pass = got === exp;
  if (!pass) allPass = false;
  console.log((pass ? '✅' : '❌'), `${w} -> ${got}`);
});

// Syntax check
try { new Function(NEW_HS_PREP_CODE); console.log('\n✅ Code syntax OK'); }
catch(e) { console.log('\n❌ Code syntax error:', e.message); allPass = false; }

console.log('\nAll tests:', allPass ? '✅ PASS' : '❌ FAIL');
if (!allPass) { process.exit(1); }

if (!WRITE) { console.log('\n(dry run — pass --write to deploy)'); process.exit(0); }

// ── Deploy ────────────────────────────────────────────────────────────────────
(async () => {
  const wf = await getWf(WF_ID);
  const node = wf.nodes.find(n => n.name === 'HS Prep');
  if (!node) { console.log('❌ HS Prep node not found'); process.exit(1); }

  fs.writeFileSync(path.join(BACKUP_DIR, WF_ID + '_before_hs_rewrite.json'), JSON.stringify(wf, null, 2), 'utf8');
  console.log('\nBackup saved.');

  node.parameters.jsCode = NEW_HS_PREP_CODE;

  const settings = Object.assign({}, wf.settings); delete settings.binaryMode;
  const r = await putWf(WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) { console.log('❌ PUT failed:', r.body.slice(0, 300)); process.exit(1); }
  await activate(WF_ID);

  const check = await getWf(WF_ID);
  const n2 = check.nodes.find(n => n.name === 'HS Prep');
  const ok = n2.parameters.jsCode.includes('DIRECT_HS') &&
             n2.parameters.jsCode.includes('productNormalized') &&
             !n2.parameters.jsCode.includes('/s+/'); // must NOT have broken /s+/ regex
  console.log((ok ? '✅' : '❌') + ' HS Prep rewrite deployed');
  if (ok) {
    console.log('\nTest: "aloo chips aur namkeen ka HS code?" should return HS 190590');
    console.log('Test: "chawal export karna hai, HS code?" should return HS 1006xx via word norm');
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
