'use strict';
/*
 * Bug 1 fix: lookup_hs_code reverse lookup (product → HS code) fails for common names.
 *
 * Root cause: HS Prep builds regex from full phrase "raw cotton" but DB stores
 * official trade names like "Cotton, not carded or combed." — phrase never matches.
 *
 * Fix: for multi-word product names, split into significant words (>3 chars) and
 * use OR pattern. "raw cotton" → words=["cotton"] → matches "Cotton, not carded..."
 * Also add text field as secondary search since it has readable plain-language descriptions.
 *
 * node aaziko/brain/deploy/fix-hs-reverse-lookup.js          -- dry run
 * node aaziko/brain/deploy/fix-hs-reverse-lookup.js --write  -- apply
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const WRITE  = process.argv.includes('--write');
const WF_ID  = 'OqZH3AoC6yy8UIbz';

const NEW_HS_PREP = `let inp = {};
try { inp = typeof $input.first().json === "string" ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}

// Accept hs_code (6-digit) or product_name for reverse lookup
const hsRaw = String(inp.hs_code || inp.hs || "").replace(/\\D/g, "").slice(0, 6);
const productName = String(inp.product_name || inp.product || inp.keyword || "").trim();

if (!hsRaw && !productName) {
  return [{ json: { _error: "Provide hs_code (6-digit, e.g. 520100) or product_name" } }];
}

var filter = { kind: "market_stat" };
if (hsRaw) {
  // Exact hs6 lookup — indexed, fast
  filter["applicability.product.hs6"] = hsRaw;
} else {
  // Reverse lookup: split into significant words (>3 chars) so common names match
  // e.g. "raw cotton" → words=["cotton"] → matches "Cotton, not carded or combed."
  //      "spice powder" → words=["spice","powder"] → pattern "spice|powder"
  var words = productName.split(/\\s+/).filter(function(w) { return w.length > 3; });
  var escapedWords = (words.length > 0 ? words : [productName]).map(function(w) {
    return w.replace(/[.*+?^$()|[{}\\\\]/g, "\\\\$&");
  });
  var regexPat = escapedWords.join("|");
  // Search structured.product_name (official trade name) OR text (plain description)
  filter["$or"] = [
    { "structured.product_name": { "$regex": regexPat, "$options": "i" } },
    { "text": { "$regex": regexPat, "$options": "i" } }
  ];
}

const _pipeline = JSON.stringify([{"$match":filter},{"$facet":{"rows":[{"$limit":10}]}}]);
return [{ json: { hs: hsRaw, product_name: productName, matchQuery: JSON.stringify(filter), pipeline: _pipeline } }];`;

(async () => {
  const wf = await getWf(WF_ID);
  const hsPrep = wf.nodes.find(n => n.name === 'HS Prep');
  if (!hsPrep) { console.log('HS Prep node not found!'); process.exit(1); }

  console.log('Current (reverse lookup part):');
  const curLines = hsPrep.parameters.jsCode.split('\n');
  const relevantLines = curLines.filter(l => l.includes('kw') || l.includes('product_name') || l.includes('filter'));
  relevantLines.forEach(l => console.log(' ', l));

  console.log('\nNew (significant-word OR pattern):');
  const newLines = NEW_HS_PREP.split('\n').filter(l => l.includes('words') || l.includes('regexPat') || l.includes('filter['));
  newLines.forEach(l => console.log(' ', l));

  if (!WRITE) { console.log('\n(dry run — pass --write to apply)'); return; }

  // Backup
  const bk = path.join(path.resolve(__dirname, '../../../backups'), WF_ID + '_before_hs-reverse-fix.json');
  fs.writeFileSync(bk, JSON.stringify(wf, null, 2), 'utf8');
  console.log('\nBackup:', bk);

  hsPrep.parameters.jsCode = NEW_HS_PREP;

  const settings = Object.assign({}, wf.settings);
  delete settings.binaryMode;

  const r = await putWf(WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status === 200) {
    await activate(WF_ID);
    const check = await getWf(WF_ID);
    const live = check.nodes.find(n => n.name === 'HS Prep');
    const ok = live.parameters.jsCode.includes('escapedWords') && live.parameters.jsCode.includes('regexPat');
    console.log(ok ? '✅ HS Prep updated — word-level matching live' : '❌ VERIFY FAILED');
  } else {
    console.log('❌ PUT failed (' + r.status + '):', JSON.stringify(r.body).slice(0, 200));
    process.exit(1);
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
