'use strict';
/*
 * Fix find_buyers Buyer Prep:
 * 1. split(/s+/) → split(/\s+/)  (backslash was lost in earlier deploy)
 * 2. Add stopwords: country names, Hindi filler, quality modifiers, procurement words
 *    so "cotton t-shirt buyers USA mein" → keyword "cotton t-shirt"
 *
 * node aaziko/brain/deploy/fix-buyer-stopwords.js         -- dry run
 * node aaziko/brain/deploy/fix-buyer-stopwords.js --write -- deploy
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');
const WF_ID = 'WPAowCu3eKOHz4Yr';
const WRITE = process.argv.includes('--write');

// ── Anchors ───────────────────────────────────────────────────────────────────
// The broken split line (note: /s+/ not /\s+/)
const OLD_SPLIT = `var words = query.split(/s+/).filter(function(w){ return w.length > 2; });`;

// What to put in its place: add stopwords, fix split
const NEW_BLOCK = [
  "// Strip country/location/filler/quality words that break AND match",
  "// (brain sometimes passes full user query; words like 'USA','mein','organic' have no match in buyer_intelligence)",
  "const BUYER_STOP_RE = /\\b(india|indian|china|chinese|usa|us|america|american|germany|german|japan|japanese|vietnam|malaysia|singapore|uae|uk|britain|france|french|australia|canadian|canada|mein|se|ke|liye|aur|ya|par|hai|hain|chahiye|dhundhne|milte|available|reliable|top|best|good|cheap|pure|premium|certified|organic|high.quality|bulk|wholesale|please|export|exports?|import|imports?|suppliers?|vendors?|manufacturers?|exporters?|importers?|buyers?|from|for|in|at|the|a|an|and|or|with|near|around|wala|wali|wale|apne|mujhe|humko|batao|dikhao|ke.liye)\\b/gi;",
  "var cleanQuery = query.replace(BUYER_STOP_RE, ' ').replace(/\\s+/g, ' ').trim() || query;",
  "var words = cleanQuery.split(/\\s+/).filter(function(w){ return w.length > 2; });"
].join('\n');

// ── Local tests ───────────────────────────────────────────────────────────────
function simulate(raw) {
  const STOP = /\b(india|indian|china|chinese|usa|us|america|american|germany|german|japan|japanese|vietnam|malaysia|singapore|uae|uk|britain|france|french|australia|canadian|canada|mein|se|ke|liye|aur|ya|par|hai|hain|chahiye|dhundhne|milte|available|reliable|top|best|good|cheap|pure|premium|certified|organic|high.quality|bulk|wholesale|please|export|exports?|import|imports?|suppliers?|vendors?|manufacturers?|exporters?|importers?|buyers?|from|for|in|at|the|a|an|and|or|with|near|around|wala|wali|wale|apne|mujhe|humko|batao|dikhao|ke.liye)\b/gi;
  const clean = raw.replace(STOP, ' ').replace(/\s+/g, ' ').trim() || raw;
  return clean.split(/\s+/).filter(w => w.length > 2);
}

console.log('=== Tests ===');
const tests = [
  // [input, expected words array]
  ['cotton t-shirt buyers chahiye USA mein',    ['cotton', 't-shirt']],
  ['leather bags Germany mein buyers chahiye',   ['leather', 'bags']],
  ['organic cotton yarn',                        ['cotton', 'yarn']],
  ['premium spices India se export',             ['spices']],
  ['solar panels',                               ['solar', 'panels']],  // no stopwords — unchanged
  ['plastic toys',                               ['plastic', 'toys']],
  ['cotton',                                     ['cotton']],
];

let allPass = true;
tests.forEach(([input, expected]) => {
  const got = simulate(input);
  const pass = JSON.stringify(got.sort()) === JSON.stringify(expected.sort());
  if (!pass) allPass = false;
  console.log((pass ? '✅' : '❌'), `"${input}" → [${got.join(',')}]`, pass ? '' : ` expected [${expected.join(',')}]`);
});

// Verify the fix string itself will compile
try { new Function(NEW_BLOCK + '\nreturn words;'); console.log('✅ Code syntax OK'); }
catch(e) { console.log('❌ Syntax error:', e.message); allPass = false; }

console.log('\nAll tests:', allPass ? '✅ PASS' : '❌ FAIL');
if (!allPass) { process.exit(1); }
if (!WRITE) { console.log('\n(dry run — pass --write to deploy)'); process.exit(0); }

// ── Deploy ────────────────────────────────────────────────────────────────────
(async () => {
  const wf   = await getWf(WF_ID);
  const prep = wf.nodes.find(n => n.name === 'Buyer Prep');
  if (!prep) { console.log('❌ Buyer Prep node not found'); process.exit(1); }

  const code = prep.parameters.jsCode;
  if (!code.includes(OLD_SPLIT)) {
    // Check if already fixed
    if (code.includes('BUYER_STOP_RE')) { console.log('Fix already deployed.'); process.exit(0); }
    console.log('❌ Cannot find anchor "var words = query.split(/s+/)" in Buyer Prep');
    console.log('Actual split line:', code.match(/var words = query\.split\([^)]+\)/)?.[0]);
    process.exit(1);
  }

  fs.writeFileSync(path.join(BACKUP_DIR, WF_ID + '_before_stopwords.json'), JSON.stringify(wf, null, 2), 'utf8');
  console.log('\nBackup saved.');

  prep.parameters.jsCode = code.replace(OLD_SPLIT, NEW_BLOCK);

  if (!prep.parameters.jsCode.includes('BUYER_STOP_RE')) {
    console.log('❌ Replace failed — text mismatch'); process.exit(1);
  }

  const settings = Object.assign({}, wf.settings); delete settings.binaryMode;
  const r = await putWf(WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) { console.log('❌ PUT failed:', r.body.slice(0, 300)); process.exit(1); }
  await activate(WF_ID);

  const check = await getWf(WF_ID);
  const p2 = check.nodes.find(n => n.name === 'Buyer Prep');
  const ok = p2.parameters.jsCode.includes('BUYER_STOP_RE') &&
             !p2.parameters.jsCode.includes('split(/s+/)');  // must NOT have broken split
  console.log((ok ? '✅' : '❌') + ' Buyer Prep stopwords fix deployed');
  if (ok) {
    console.log('\nTest: "cotton t-shirt buyers chahiye USA mein" should now return buyers');
    console.log('Test: "organic cotton yarn" should now return buyers for "cotton yarn"');
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
