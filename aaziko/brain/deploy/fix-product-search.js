'use strict';
/* Fix product search quality in products sub-workflow (IdQQ66Ugw7eJIqax):
 *   Problem: {$regex: 'spices'} returns "Electronic Spices" (electronics brand) first
 *   Fix: score-based aggregation pipeline
 *     +5 — product_name starts with keyword
 *     +3 — keyword in category/subcategory (confirms right category)
 *     +2 — keyword at word-start in product_name
 *
 * node aaziko/brain/deploy/fix-product-search.js          -- dry run
 * node aaziko/brain/deploy/fix-product-search.js --write  -- patch + activate
 */
const path = require('path'), fs = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const SEC_DIR = path.resolve(__dirname, '..', '..', '.secrets');
const ids = JSON.parse(fs.readFileSync(path.join(SEC_DIR, 'brain-n8n.json'), 'utf8'));
const WRITE = process.argv.includes('--write');
const WF_ID = ids.productWfId;

// Build the new Prep code as array of lines to avoid template-literal/regex escaping traps
function buildPrepCode() {
  const lines = [
    'let inp = {};',
    'try { inp = typeof $input.first().json === "string" ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}',
    'const keyword = String(inp.keyword || inp.product || inp.query || "").trim();',
    'if (!keyword) return [{ json: { _error: "keyword required" } }];',
    '',
    '// Escape regex special chars without using character-class syntax',
    'const esc = s => s.split("").map(function(c) {',
    '  if (".+*?^|".indexOf(c) >= 0) return "\\\\" + c;',
    '  if (c === "\\\\") return "\\\\\\\\";',
    '  return c;',
    '}).join("");',
    'const kw = esc(keyword);',
    '',
    '// Multi-word: ALL words must appear in product_name or category',
    'const words = keyword.split(/\\s+/).filter(function(w) { return w.length > 1; }).map(esc);',
    'var baseMatch;',
    'if (words.length > 1) {',
    '  baseMatch = { $and: words.map(function(w) { return { $or: [',
    '    { product_name: { $regex: w, $options: "i" } },',
    '    { category: { $regex: w, $options: "i" } }',
    '  ]};}) };',
    '} else {',
    '  baseMatch = { $or: [',
    '    { product_name: { $regex: kw, $options: "i" } },',
    '    { category: { $regex: kw, $options: "i" } }',
    '  ]};',
    '}',
    '',
    '// Score: starts-with +5, in-category +3, word-start +2 — sort desc',
    'var pipeline = JSON.stringify([',
    '  { "$match": baseMatch },',
    '  { "$addFields": {',
    '    "_score": {',
    '      "$add": [',
    '        { "$cond": [{ "$regexMatch": { "input": "$product_name", "regex": "^" + kw, "options": "i" } }, 5, 0] },',
    '        { "$cond": [{ "$or": [',
    '          { "$regexMatch": { "input": { "$ifNull": ["$category", ""] }, "regex": kw, "options": "i" } },',
    '          { "$regexMatch": { "input": { "$ifNull": ["$subcategory", ""] }, "regex": kw, "options": "i" } }',
    '        ]}, 3, 0] },',
    '        { "$cond": [{ "$regexMatch": { "input": "$product_name", "regex": "(?:^|[ ,])" + kw, "options": "i" } }, 2, 0] }',
    '      ]',
    '    }',
    '  }},',
    '  { "$sort": { "_score": -1 } },',
    '  { "$facet": { "rows": [{ "$limit": 10 }] } }',
    ']);',
    '',
    'return [{ json: { keyword: keyword, pipeline: pipeline } }];'
  ];
  return lines.join('\n');
}

const NEW_PREP_CODE = buildPrepCode();

// Verify the generated code is valid JS before deploying
try {
  new Function(NEW_PREP_CODE); // will throw if syntax error
  console.log('Generated Prep code: syntax OK');
} catch(e) {
  console.error('Generated Prep code SYNTAX ERROR:', e.message);
  process.exit(1);
}

(async () => {
  const wf = await getWf(WF_ID);

  const prepIdx = wf.nodes.findIndex(n => n.name === 'Product Prep');
  const findIdx = wf.nodes.findIndex(n => n.name === 'Find Products');

  if (prepIdx === -1) { console.error('Product Prep not found'); process.exit(1); }
  if (findIdx === -1) { console.error('Find Products not found'); process.exit(1); }

  const findNode = wf.nodes[findIdx];
  console.log('=== BEFORE ===');
  console.log('Find Products query:', (findNode.parameters.query || '').slice(0, 120));
  console.log('Nodes total:', wf.nodes.length);

  if (!WRITE) {
    console.log('\n=== WOULD FIX ===');
    console.log('Product Prep: score-based pipeline (starts-with +5, category +3, word-start +2)');
    console.log('Find Products query: use pre-built pipeline from Prep node');
    console.log('\n(dry run — pass --write to apply)');
    return;
  }

  const backupDir = path.resolve(__dirname, '..', '..', '..', 'backups');
  fs.writeFileSync(path.join(backupDir, WF_ID + '_before_fix_product_search.json'), JSON.stringify(wf, null, 2));
  console.log('Backup saved');

  // Fix 1: Product Prep — new scored pipeline builder
  wf.nodes[prepIdx].parameters.jsCode = NEW_PREP_CODE;

  // Fix 2: Find Products — use pre-built pipeline from Prep
  wf.nodes[findIdx].parameters.query = "={{ $('Product Prep').first().json.pipeline }}";

  await putWf(WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings });
  await activate(WF_ID);

  const live = await getWf(WF_ID);
  const lFind = live.nodes.find(n => n.name === 'Find Products');

  console.log('\n=== LIVE ===');
  console.log('Find Products query:', (lFind.parameters.query || '').slice(0, 100));
  console.log('Active:', live.active, '| nodes:', live.nodes.length);

  if (lFind.parameters.query.includes("$('Product Prep').first().json.pipeline")) {
    console.log('\n✅ Product search scoring fix applied');
  } else {
    console.error('\n❌ Verification failed — query not updated');
    process.exit(1);
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
