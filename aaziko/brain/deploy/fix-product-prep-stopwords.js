'use strict';
/*
 * Fix search_products Product Prep: strip location/stop words before AND match.
 * Brain passes full user query as keyword, including words like "India", "mein",
 * "suppliers", "chahiye" that never appear in product_name or category.
 * AND logic requires ALL words to match → one missing word → 0 results.
 *
 * Fix: strip common non-product words from keyword before split.
 *
 * node aaziko/brain/deploy/fix-product-prep-stopwords.js         -- dry run
 * node aaziko/brain/deploy/fix-product-prep-stopwords.js --write -- deploy
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');
const PROD_ID    = 'IdQQ66Ugw7eJIqax';
const WRITE = process.argv.includes('--write');

// Stop words: country names, Hindi filler, procurement words — NOT product descriptors
const STOP_WORD_FIX = `
// Strip country/location/filler words that are not product descriptors
// (brain passes full user query; "India", "mein", "suppliers" break AND logic)
const STOP_WORDS_RE = /\\b(india|indian|china|chinese|usa|us|america|american|germany|german|japan|japanese|vietnam|malaysia|singapore|uae|uk|britain|france|french|mein|se|ke|liye|aur|ya|par|hai|hain|chahiye|dhundhne|milte|available|reliable|top|best|good|cheap|quality|please|suppliers?|vendors?|manufacturers?|exporters?|importers?|from|for|in|at|the|a|an|and|or|with|near|around|hain|wala|wali|wale|apne|mujhe|humko|batao|dikhao)\\b/gi;
var keyword = String(inp.keyword || inp.product || inp.query || "")
  .replace(STOP_WORDS_RE, ' ')
  .replace(/\\s+/g, ' ').trim();
if (!keyword) keyword = String(inp.keyword || inp.product || inp.query || "").trim();
`;

// OLD anchor: const keyword = String(inp.keyword || inp.product || inp.query || "").trim();
const OLD_KEYWORD = 'const keyword = String(inp.keyword || inp.product || inp.query || "").trim();';

(async () => {
  console.log('=== Fix: Product Prep — stop word strip ===\n');

  // Local tests
  function cleanKeyword(raw) {
    const STOP = /\b(india|indian|china|chinese|usa|us|america|american|germany|german|japan|japanese|vietnam|malaysia|singapore|uae|uk|britain|france|french|mein|se|ke|liye|aur|ya|par|hai|hain|chahiye|dhundhne|milte|available|reliable|top|best|good|cheap|quality|please|suppliers?|vendors?|manufacturers?|exporters?|importers?|from|for|in|at|the|a|an|and|or|with|near|around|hain|wala|wali|wale|apne|mujhe|humko|batao|dikhao)\b/gi;
    return raw.replace(STOP, ' ').replace(/\s+/g,' ').trim() || raw;
  }

  const tests = [
    ['stainless steel industrial valves India',       'stainless steel industrial valves'],
    ['cotton t-shirts India mein suppliers chahiye',  'cotton t-shirts'],
    ['solar panels exporters India',                  'solar panels'],
    ['industrial pumps',                              'industrial pumps'],  // no stop words, unchanged
    ['leather bags India se export',                  'leather bags export'],
    ['stainless steel valves',                        'stainless steel valves'],
  ];
  let allPass = true;
  tests.forEach(([raw, expected]) => {
    const got = cleanKeyword(raw);
    const pass = got === expected;
    if (!pass) allPass = false;
    console.log((pass?'✅':'❌'), `"${raw}" → "${got}"`, pass?'':` expected "${expected}"`);
  });
  if (!allPass) { console.log('\nTests failed — not deploying'); process.exit(1); }
  console.log('\nAll tests pass.\n');

  if (!WRITE) { console.log('(dry run — pass --write to deploy)'); return; }

  const wf = await getWf(PROD_ID);
  const prep = wf.nodes.find(n => n.name === 'Product Prep');
  const code = prep.parameters.jsCode;

  if (!code.includes(OLD_KEYWORD)) {
    console.log('❌ Cannot find anchor "const keyword = ..." in Product Prep');
    process.exit(1);
  }
  if (code.includes('STOP_WORDS_RE')) {
    console.log('Fix already present — skipping');
    return;
  }

  fs.writeFileSync(path.join(BACKUP_DIR, PROD_ID + '_before_stopwords.json'), JSON.stringify(wf, null, 2), 'utf8');
  console.log('Backup saved.\n');

  // Replace the old keyword line with STOP_WORD_FIX block (which sets `keyword` itself)
  const newCode = code.replace(OLD_KEYWORD, STOP_WORD_FIX.trim());
  prep.parameters.jsCode = newCode;

  const settings = Object.assign({}, wf.settings);
  delete settings.binaryMode;

  const r = await putWf(PROD_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) { console.log('❌ PUT failed:', r.body.slice(0,300)); process.exit(1); }
  await activate(PROD_ID);

  const check = await getWf(PROD_ID);
  const live = check.nodes.find(n => n.name === 'Product Prep');
  const ok = live.parameters.jsCode.includes('STOP_WORDS_RE');
  console.log((ok?'✅':'❌') + ' Product Prep stop word fix deployed');
  if (ok) console.log('\nTest: "stainless steel industrial valves India mein suppliers chahiye" → should return results');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
