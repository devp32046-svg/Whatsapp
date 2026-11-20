'use strict';
/*
 * Fix search_tariff: partner_name filter returns 0 rows because wits.tariff_trains
 * has ONLY MFN rates (partner_name="World" for ALL 623K rows). No bilateral data.
 *
 * Fix: remove partner_name from matchQuery. Add note in format output when
 * exporter was specified: "MFN rate (bilateral data not available)".
 *
 * node aaziko/brain/deploy/fix-tariff-mfn-fallback.js          -- dry run
 * node aaziko/brain/deploy/fix-tariff-mfn-fallback.js --write  -- apply
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const WRITE        = process.argv.includes('--write');
const TARIFF_WF_ID = 'k71O78yLV0v0TXZl';
const BACKUP_DIR   = path.resolve(__dirname, '../../../backups');

// Fixed Prep: remove partner_name from match (all rows have partner="World")
const NEW_PREP = `let inp = {};
try { inp = typeof $input.first().json === "string" ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}
const raw = String(inp.hs_code || inp.hsCode || inp.hs || "").replace(/\\D/g, "").slice(0, 6);
const importer = String(inp.importer_country || inp.reporter || inp.country || "").trim();
const exporter = String(inp.exporter_country || inp.partner || "").trim();

if (!raw || raw.length < 4) {
  return [{ json: { _error: "hs_code required (4-6 digits)", hs_code: raw } }];
}
const hs6 = raw.padEnd(6, "0").slice(0, 6);

// NOTE: wits.tariff_trains has ONLY MFN rates (partner_name = "World" for all rows).
// No bilateral data. Filter by reporter (importer country) only.
var matchQuery = { hs6: hs6 };
if (importer) matchQuery.reporter_name = { "$regex": importer, "$options": "i" };
// exporter is kept for label/note but NOT used in DB query

var label = hs6;
if (importer && exporter) label += " (" + exporter + " → " + importer + ")";
else if (importer) label += " (importer: " + importer + ")";
else if (exporter) label += " (exporter: " + exporter + ")";

const _pipeline = JSON.stringify([{"$match":matchQuery},{"$sort":{"year":-1}},{"$facet":{"rows":[{"$limit":10}]}}]);
return [{ json: { hs6: hs6, importer: importer || null, exporter: exporter || null, label: label, matchQuery: JSON.stringify(matchQuery), pipeline: _pipeline } }];`;

// Fixed Format: add MFN note when exporter was specified
const NEW_FORMAT = `const data = $input.first().json;
const prep = $('Tariff Prep').first().json;
const rows = data.rows || [];
if (prep._error) return [{ json: { ok: false, error: prep._error } }];
if (!rows.length) return [{ json: { ok: false, error: "No tariff data found for HS " + prep.hs6 + (prep.importer ? " in " + prep.importer : "") } }];

const lines = rows.slice(0, 8).map(function(r) {
  var rate = (r.simple_avg_rate !== null && r.simple_avg_rate !== undefined) ? r.simple_avg_rate + "%" : "-";
  var range = (r.min_rate !== r.max_rate) ? " (min " + r.min_rate + "% / max " + r.max_rate + "%)" : "";
  var yr = r.year ? " [" + r.year + "]" : "";
  return "\\u2022 " + r.reporter_name + " | " + (r.tariff_type || "MFN") + ": " + rate + range + yr;
});

var summary = "Tariff rates for HS " + prep.label + ":\\n" + lines.join("\\n");

// Add note: this dataset has only MFN rates, not bilateral
if (prep.exporter) {
  summary += "\\n\\n_Note: Ye MFN (Most Favored Nation) rate hai — " + prep.exporter + "-specific bilateral rate is data mein available nahi. MFN rate sabhi WTO trading partners par apply hota hai._";
}

return [{ json: { ok: true, summary: summary, rowCount: rows.length } }];`;

(async () => {
  console.log('=== Fix: search_tariff MFN fallback ===');
  console.log('Problem: partner_name filter → 0 rows (all 623K rows have partner=World)');
  console.log('Fix: remove partner filter, add MFN note when exporter specified\n');

  const wf = await getWf(TARIFF_WF_ID);
  const prep = wf.nodes.find(n => n.name && n.name.toLowerCase().includes('prep'));
  const fmt  = wf.nodes.find(n => n.name && n.name.toLowerCase().includes('format'));

  console.log('Prep node:', prep && prep.name);
  console.log('Format node:', fmt && fmt.name);

  const hasPartnerFilter = prep && prep.parameters.jsCode.includes('partner_name');
  console.log('Current has partner_name filter:', hasPartnerFilter ? 'YES (needs fix)' : 'already fixed');

  if (!WRITE) { console.log('\n(dry run — pass --write to apply)'); return; }

  const bk = path.join(BACKUP_DIR, TARIFF_WF_ID + '_before_mfn-fallback.json');
  fs.writeFileSync(bk, JSON.stringify(wf, null, 2), 'utf8');
  console.log('Backup:', bk);

  prep.parameters.jsCode = NEW_PREP;
  fmt.parameters.jsCode  = NEW_FORMAT;

  const settings = Object.assign({}, wf.settings);
  delete settings.binaryMode;

  const r = await putWf(TARIFF_WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) {
    console.log('❌ PUT failed (' + r.status + '):', JSON.stringify(r.body).slice(0, 200));
    process.exit(1);
  }
  await activate(TARIFF_WF_ID);

  const check = await getWf(TARIFF_WF_ID);
  const livePrep = check.nodes.find(n => n.name && n.name.toLowerCase().includes('prep'));
  const liveFmt  = check.nodes.find(n => n.name && n.name.toLowerCase().includes('format'));

  const c1 = !livePrep.parameters.jsCode.includes('partner_name');
  const c2 = liveFmt.parameters.jsCode.includes('MFN');
  console.log(c1 ? '✅ Prep: partner_name filter removed' : '❌ Prep verify FAILED');
  console.log(c2 ? '✅ Format: MFN note added' : '❌ Format verify FAILED');

  if (c1 && c2) console.log('\n✅ Fix live — search_tariff will now return MFN rates with note.');
  else process.exit(1);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
