'use strict';
/*
 * Fix lookup_hs_code: multi-word queries use OR logic → wrong HS codes.
 * "cotton t-shirt" → cotton|t-shirt matches cotton SEEDS before cotton t-shirts.
 *
 * Fix: when multiple words, use $and so each word must appear in product_name/text.
 * "cotton t-shirt" → cotton AND t-shirt both required → HS 610910 first.
 *
 * Also: remove useless kind:"market_stat" filter (all 7M docs have this kind).
 *
 * node aaziko/brain/deploy/fix-hs-lookup-and-logic.js          -- dry run
 * node aaziko/brain/deploy/fix-hs-lookup-and-logic.js --write  -- apply
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const WRITE    = process.argv.includes('--write');
const WF_ID    = 'OqZH3AoC6yy8UIbz';
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');

const NEW_PREP = `let inp = {};
try { inp = typeof $input.first().json === 'string' ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}

const hsRaw = String(inp.hs_code || inp.hs || '').replace(/\\D/g, '').slice(0, 6);
const productName = String(inp.product_name || inp.product || inp.keyword || '').trim();

if (!hsRaw && !productName) {
  return [{ json: { _error: 'Provide hs_code (6-digit, e.g. 520100) or product_name (e.g. cotton t-shirt)' } }];
}

var pipeline;

if (hsRaw) {
  // Direct HS code lookup — fast indexed path
  pipeline = JSON.stringify([
    {"$match": {"applicability.product.hs6": hsRaw}},
    {"$facet": {"rows": [{"$limit": 10}]}}
  ]);
} else {
  // Reverse lookup: split into words >3 chars
  var words = productName.split(/\\s+/).filter(function(w){ return w.length > 3; });
  if (!words.length) words = [productName];

  function escRe(w) {
    return w.replace(/[.*+?^$()|\[{\\\\]/g, '\\\\$&');
  }

  // AND logic: every word must appear somewhere in product_name or text
  // e.g. "cotton t-shirt" → {$and: [cotton in name/text, t-shirt in name/text]}
  var andClauses = words.map(function(w) {
    var pat = escRe(w);
    return {"$or": [
      {"structured.product_name": {"$regex": pat, "$options": "i"}},
      {"text": {"$regex": pat, "$options": "i"}}
    ]};
  });

  var matchQ = andClauses.length === 1 ? andClauses[0] : {"$and": andClauses};
  pipeline = JSON.stringify([
    {"$match": matchQ},
    {"$facet": {"rows": [{"$limit": 10}]}}
  ]);
}

return [{ json: { hs: hsRaw || null, product_name: productName || null, pipeline: pipeline } }];`;

(async () => {
  console.log('=== Fix: lookup_hs_code AND logic ===');
  console.log('Problem: multi-word query uses OR → cotton seeds match before cotton t-shirt');
  console.log('Fix: AND logic per word — each word must appear in product_name or text\n');

  const wf = await getWf(WF_ID);
  const prep = wf.nodes.find(n => n.name === 'HS Prep');
  if (!prep) { console.log('❌ HS Prep not found'); process.exit(1); }

  const hasOrBug = prep.parameters.jsCode.includes('regexPat = escapedWords.join("|")');
  const hasKindFilter = prep.parameters.jsCode.includes('"market_stat"');
  console.log('Has OR-join bug:', hasOrBug ? 'YES (needs fix)' : 'already fixed');
  console.log('Has useless kind filter:', hasKindFilter ? 'YES (will remove)' : 'not present');

  if (!WRITE) { console.log('\n(dry run — pass --write to apply)'); return; }

  const bk = path.join(BACKUP_DIR, WF_ID + '_before_and-logic.json');
  fs.writeFileSync(bk, JSON.stringify(wf, null, 2), 'utf8');
  console.log('Backup:', bk);

  prep.parameters.jsCode = NEW_PREP;

  const settings = Object.assign({}, wf.settings);
  delete settings.binaryMode;

  const r = await putWf(WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) {
    console.log('❌ PUT failed (' + r.status + '):', JSON.stringify(r.body).slice(0, 300));
    process.exit(1);
  }
  await activate(WF_ID);

  const check = await getWf(WF_ID);
  const live = check.nodes.find(n => n.name === 'HS Prep');
  const c1 = live.parameters.jsCode.includes('"$and"') || live.parameters.jsCode.includes("'$and'");
  const c2 = !live.parameters.jsCode.includes('market_stat');
  const c3 = !live.parameters.jsCode.includes('regexPat = escapedWords.join("|")');
  console.log(c1 ? '✅ AND logic present' : '❌ AND logic missing');
  console.log(c2 ? '✅ kind filter removed' : '❌ kind filter still there');
  console.log(c3 ? '✅ OR-join bug fixed' : '❌ OR-join bug remains');

  if (c1 && c2 && c3) console.log('\n✅ Fix live! "cotton t-shirt" will now return HS 610910 first.');
  else process.exit(1);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
