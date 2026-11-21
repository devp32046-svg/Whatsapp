'use strict';
/*
 * Fix find_buyers (WPAowCu3eKOHz4Yr) — 2 bugs:
 *
 * Bug 1 — Buyer Prep "Invalid or unexpected token (SyntaxError)":
 *   Line: var esc = w.replace(/[-.*+?^()[]|]/g, ...);
 *   The regex has unescaped [ inside a character class. Works in Node 24 locally
 *   but n8n's sandbox throws SyntaxError before execution starts.
 *   Fix: chain of simple single-char .replace() calls.
 *
 * Bug 2 — Format Result "Cannot read properties of undefined (reading 'length')":
 *   .flat() may not exist in n8n sandbox. Defensive rewrite: explicit Array.isArray,
 *   no .flat(), explicit null guards everywhere.
 *
 * node aaziko/brain/deploy/fix-find-buyers.js          -- verify only
 * node aaziko/brain/deploy/fix-find-buyers.js --write  -- deploy
 */
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate, RROOT } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(RROOT, 'backups');
const WF_ID = 'WPAowCu3eKOHz4Yr';
const WRITE = process.argv.includes('--write');

// ─── NEW Buyer Prep code ───────────────────────────────────────────────────
// Only change: replaced single-line regex escape with chained .replace() calls
// Everything else identical to live code.
const NEW_BUYER_PREP = `
let inp = {};
try { inp = typeof $input.first().json === "string" ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}

var query   = String(inp.keyword || inp.product || inp.query || inp.chatInput || "").trim();
const country  = String(inp.country || "").trim();
const minScore = parseInt(inp.min_score || "0", 10) || 0;

var hsRaw = String(inp.hs_code || inp.hs || "").replace(/\\D/g, "").slice(0, 6);
if (!hsRaw) {
  var hsMat = query.match(/\\b([0-9]{4,6})\\b/);
  if (hsMat) { hsRaw = hsMat[1]; query = query.replace(hsMat[0], "").replace(/\\s+/g," ").trim(); }
}

query = query.replace(/\\b\\d{6}\\b/g, "").replace(/\\s+/g, " ").trim() || query;

const useShortlist = hsRaw.length >= 4;

if (useShortlist) {
  const hs6 = hsRaw.padEnd(6, "0").slice(0, 6);
  const rangeMin = parseInt(hs6.padEnd(10, "0"));
  const rangeMax = parseInt(hs6.padEnd(10, "9"));
  const matchQ = { type: "buyer", hsCodes: { "$elemMatch": { "$gte": rangeMin, "$lte": rangeMax } } };
  if (country) matchQ.country = { "$regex": country, "$options": "i" };

  const pipeline = JSON.stringify([
    { "$match": matchQ },
    { "$sort": { "transactionCount": -1, "totalAmount": -1 } },
    { "$facet": {
      "rows": [
        { "$limit": 10 },
        { "$project": { "name": 1, "country": 1, "transactionCount": 1, "totalAmount": 1, "apollo_free.domain": 1, "apollo_free.contacts": 1 } }
      ],
      "total": [{ "$count": "n" }]
    }}
  ]);
  return [{ json: { hs6, hsRaw, country: country || null, useShortlist: true, pipeline } }];
}

if (!query) {
  return [{ json: { _error: "keyword or hs_code required — e.g. cotton t-shirts, solar panels, or HS code 610910" } }];
}

const BUYER_STOP_RE = /\\b(india|indian|china|chinese|usa|us|america|american|germany|german|japan|japanese|vietnam|malaysia|singapore|uae|uk|britain|france|french|australia|canadian|canada|mein|se|ke|liye|aur|ya|par|hai|hain|chahiye|dhundhne|milte|available|reliable|top|best|good|cheap|pure|premium|certified|organic|high.quality|bulk|wholesale|please|export|exports?|import|imports?|suppliers?|vendors?|manufacturers?|exporters?|importers?|buyers?|from|for|in|at|the|a|an|and|or|with|near|around|wala|wali|wale|apne|mujhe|humko|batao|dikhao|ke.liye)\\b/gi;
var cleanQuery = query.replace(BUYER_STOP_RE, ' ').replace(/\\s+/g, ' ').trim() || query;
var words = cleanQuery.split(/\\s+/).filter(function(w){ return w.length > 2; });

// Escape regex special chars — chain of simple replaces (avoids [ inside char-class ambiguity)
var wordConditions = words.map(function(w) {
  var esc = w
    .replace(/\\\\/g, '\\\\\\\\').replace(/\\./g, '\\\\.').replace(/\\*/g, '\\\\*')
    .replace(/\\+/g, '\\\\+').replace(/\\?/g, '\\\\?').replace(/\\^/g, '\\\\^')
    .replace(/\\(/g, '\\\\(').replace(/\\)/g, '\\\\)').replace(/\\[/g, '\\\\[')
    .replace(/\\]/g, '\\\\]').replace(/\\|/g, '\\\\|').replace(/-/g, '\\\\-');
  var or = String.fromCharCode(36) + 'or';
  var re = String.fromCharCode(36) + 'regex';
  var op = String.fromCharCode(36) + 'options';
  var cond = {};
  cond[or] = [
    { buyer_name:        {} },
    { category:          {} },
    { suggested_product: {} }
  ];
  cond[or][0].buyer_name[re]        = esc; cond[or][0].buyer_name[op]        = 'i';
  cond[or][1].category[re]          = esc; cond[or][1].category[op]          = 'i';
  cond[or][2].suggested_product[re] = esc; cond[or][2].suggested_product[op] = 'i';
  return cond;
});

var _mqAnd = {};
var and = String.fromCharCode(36) + 'and';
_mqAnd[and] = wordConditions;
var matchQ2 = wordConditions.length === 1 ? wordConditions[0] : _mqAnd;
if (minScore > 0) matchQ2.score = { "$gte": minScore };

const pipeline2 = JSON.stringify([
  { "$match": matchQ2 },
  { "$sort": { "score": -1 } },
  { "$facet": { "rows": [{ "$limit": 8 }] } }
]);
return [{ json: { keyword: query, country: country || null, useShortlist: false, pipeline: pipeline2 } }];
`.trim();

// ─── NEW Format Result code ────────────────────────────────────────────────
// Defensive rewrite: explicit Array.isArray, no .flat(), null-guards everywhere
const NEW_FORMAT_RESULT = `
var prep = {};
try { prep = $('Buyer Prep').first().json || {}; } catch(e) {}

var rawData = {};
try { rawData = $input.first().json || {}; } catch(e) {}

// Explicit flatten — avoids .flat() which may be absent in n8n sandbox
var rows = [];
var rawRows = rawData.rows;
if (Array.isArray(rawRows)) {
  for (var _i = 0; _i < rawRows.length; _i++) {
    var _rr = rawRows[_i];
    if (Array.isArray(_rr)) {
      for (var _j = 0; _j < _rr.length; _j++) { if (_rr[_j]) rows.push(_rr[_j]); }
    } else if (_rr) {
      rows.push(_rr);
    }
  }
}

if (prep._error) return [{ json: { ok: false, error: String(prep._error) } }];

if (rows.length === 0) {
  var noMsg = prep.useShortlist
    ? "HS " + (prep.hs6 || prep.hsRaw || '') + " ke liye koi buyer nahi mila" + (prep.country ? " in " + prep.country : "") + ". Try broader HS code (4-digit)."
    : "No buyers found for: " + (prep.keyword || "") + (prep.country ? " in " + prep.country : "") + ". Try with HS code (e.g. HS 610910 ke buyers dhundho).";
  return [{ json: { ok: false, summary: noMsg } }];
}

var totalArr = rawData.total;
var total = (Array.isArray(totalArr) && totalArr[0] && totalArr[0].n != null)
  ? Number(totalArr[0].n) : rows.length;

if (prep.useShortlist) {
  var lines = rows.slice(0, 8).map(function(r, i) {
    var val  = r.totalAmount      ? " | $" + Number(r.totalAmount).toLocaleString() : "";
    var txns = r.transactionCount ? " | " + r.transactionCount + " shipments" : "";
    var ctry = r.country          ? " (" + r.country + ")" : "";
    var site = (r.apollo_free && r.apollo_free.domain) ? " | " + r.apollo_free.domain : "";
    return (i+1) + ". " + (r.name || r.buyer_name || "(unnamed)") + ctry + txns + val + site;
  }).join("\\n");
  var totalStr = Number.isFinite(total) ? total.toLocaleString() : String(total);
  var summary = prep.country
    ? "HS " + prep.hs6 + " buyers in " + prep.country + " (" + totalStr + " total):\\n\\n" + lines
    : "HS " + prep.hs6 + " ke top buyers (" + totalStr + " total):\\n\\n" + lines;
  return [{ json: { ok: true, summary: summary, rowCount: rows.length, total: total } }];
}

var MIN_CONF = 25;
var goodRows = rows.filter(function(r){ return Number(r.deal_confidence || 0) >= MIN_CONF; });
var displayRows = goodRows.length >= 2 ? goodRows : rows;
var lines2 = displayRows.slice(0, 6).map(function(r, i) {
  var score = r.score || 0;
  var conf  = r.deal_confidence || 0;
  var val   = r.total_value ? " | $" + Number(r.total_value).toLocaleString() : "";
  var sugg  = r.suggested_product ? " | sugg: " + String(r.suggested_product).slice(0, 40) : "";
  var ctry  = r.buyer_country ? " (" + r.buyer_country + ")" : "";
  return (i+1) + ". " + (r.buyer_name || "(unnamed)") + ctry + " | score:" + score + " | conf:" + conf + "%" + val + sugg;
}).join("\\n");
var insight0 = (displayRows[0] && Array.isArray(displayRows[0].insights) && displayRows[0].insights[0])
  ? "\\n\\nTop lead insight: " + String(displayRows[0].insights[0]).slice(0, 120) : "";
return [{ json: { ok: true, summary: "Top buyers for \\"" + (prep.keyword || "") + "\\":\\n\\n" + lines2 + insight0, rowCount: rows.length } }];
`.trim();

// ─── Syntax check ──────────────────────────────────────────────────────────
try { new Function(NEW_BUYER_PREP);   console.log('✅ Buyer Prep syntax OK'); }
catch(e) { console.log('❌ Buyer Prep:', e.message); process.exit(1); }
try { new Function(NEW_FORMAT_RESULT); console.log('✅ Format Result syntax OK'); }
catch(e) { console.log('❌ Format Result:', e.message); process.exit(1); }

// ─── Check for $& trap ────────────────────────────────────────────────────
if (/\$&/.test(NEW_BUYER_PREP) || /\$&/.test(NEW_FORMAT_RESULT)) {
  console.log('❌ $& found in code — will break n8n replacement layer'); process.exit(1);
}
console.log('✅ No $& trap');

// ─── Check no 0x08 backspace ──────────────────────────────────────────────
const bp08 = NEW_BUYER_PREP.split('').some(c => c.charCodeAt(0) === 8);
const fr08 = NEW_FORMAT_RESULT.split('').some(c => c.charCodeAt(0) === 8);
if (bp08 || fr08) { console.log('❌ 0x08 backspace found'); process.exit(1); }
console.log('✅ No 0x08 backspace');

if (!WRITE) { console.log('\n(--write to deploy)'); process.exit(0); }

(async () => {
  const wf = await getWf(WF_ID);
  fs.writeFileSync(path.join(BACKUP_DIR, WF_ID + '_before_fix_find_buyers.json'), JSON.stringify(wf, null, 2), 'utf8');
  console.log('\nBackup saved. Nodes:', wf.nodes.length);

  const bp = wf.nodes.find(n => n.name === 'Buyer Prep');
  const fr = wf.nodes.find(n => n.name === 'Format Result');
  if (!bp || !fr) {
    console.log('❌ Expected nodes missing:', wf.nodes.map(n=>n.name).join(', '));
    process.exit(1);
  }

  bp.parameters.jsCode = NEW_BUYER_PREP;
  fr.parameters.jsCode = NEW_FORMAT_RESULT;

  const settings = Object.assign({}, wf.settings); delete settings.binaryMode;
  const r = await putWf(WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) { console.log('❌ PUT failed:', r.status, r.body.slice(0, 300)); process.exit(1); }
  console.log('✅ PUT 200');

  await activate(WF_ID);
  console.log('✅ Deactivated + activated');

  const check = await getWf(WF_ID);
  const bp2 = check.nodes.find(n => n.name === 'Buyer Prep');
  const fr2 = check.nodes.find(n => n.name === 'Format Result');
  const bpOK = bp2 && bp2.parameters.jsCode.includes('chain of simple');
  const frOK = fr2 && fr2.parameters.jsCode.includes('Array.isArray');
  console.log((bpOK ? '✅' : '❌') + ' Buyer Prep updated (chain-replace comment present)');
  console.log((frOK ? '✅' : '❌') + ' Format Result updated (Array.isArray present)');
  if (!bpOK || !frOK) { console.log('❌ Read-back failed'); process.exit(1); }
  console.log('\n✅ find_buyers fixed. Test: brain pe "cotton t-shirt buyers chahiye HS 610910"');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
