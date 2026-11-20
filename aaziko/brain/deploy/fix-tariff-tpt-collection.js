'use strict';
/*
 * Fix search_tariff: switch from wits.tariff_trains (MFN only, 623K rows)
 * to aaziko_organized.tp_partner_tariff_organized (bilateral + FTA + IEEPA duties).
 *
 * tp_partner_tariff_organized has:
 *  - 649,781 docs (reporter=106 countries, origin=240+ countries)
 *  - Country codes: cty:IN, cty:US, cty:BD etc.
 *  - Rates dict: MFN, FTA rates, IEEPA additional duties (Trump tariffs Sep 2025)
 *  - Example: USA importing India cotton 520100 → MFN: 0%, IEEPA: 50%
 *
 * Changes:
 *  1. Tariff Prep: country name → ISO-2 → cty: code, build proper match query
 *  2. Find Tariff node: collection=tp_partner_tariff_organized, databaseName=aaziko_organized
 *  3. Format Result: parse structured.rates dict, highlight IEEPA/extra duties
 *
 * node aaziko/brain/deploy/fix-tariff-tpt-collection.js         -- dry run
 * node aaziko/brain/deploy/fix-tariff-tpt-collection.js --write -- apply
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const WRITE        = process.argv.includes('--write');
const TARIFF_WF_ID = 'k71O78yLV0v0TXZl';
const BACKUP_DIR   = path.resolve(__dirname, '../../../backups');

const NEW_PREP = `let inp = {};
try { inp = typeof $input.first().json === "string" ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}
const raw = String(inp.hs_code || inp.hsCode || inp.hs || "").replace(/\\D/g, "").slice(0, 6);
const importerRaw = String(inp.importer_country || inp.reporter || inp.country || "").trim();
const exporterRaw = String(inp.exporter_country || inp.partner || "").trim();

if (!raw || raw.length < 4) {
  return [{ json: { _error: "hs_code required (4-6 digits)", hs_code: raw } }];
}
const hs6 = raw.padEnd(6, "0").slice(0, 6);

const CMAP = {
  'united states':'US','usa':'US','us':'US','america':'US',
  'india':'IN','uk':'GB','united kingdom':'GB','britain':'GB','great britain':'GB',
  'china':'CN','prc':'CN','bangladesh':'BD','germany':'DE','france':'FR',
  'japan':'JP','south korea':'KR','korea':'KR','australia':'AU',
  'canada':'CA','brazil':'BR','indonesia':'ID','vietnam':'VN',
  'thailand':'TH','malaysia':'MY','singapore':'SG','uae':'AE',
  'united arab emirates':'AE','saudi arabia':'SA','turkey':'TR',
  'russia':'RU','south africa':'ZA','kenya':'KE','nigeria':'NG',
  'egypt':'EG','mexico':'MX','italy':'IT','spain':'ES',
  'netherlands':'NL','belgium':'BE','poland':'PL','switzerland':'CH',
  'hong kong':'HK','taiwan':'TW','philippines':'PH','cambodia':'KH',
  'myanmar':'MM','sri lanka':'LK','nepal':'NP','bhutan':'BT',
  'new zealand':'NZ','sweden':'SE','norway':'NO','denmark':'DK',
  'finland':'FI','austria':'AT','portugal':'PT','greece':'GR',
  'czechia':'CZ','czech republic':'CZ','romania':'RO','hungary':'HU',
  'ukraine':'UA','iran':'IR','iraq':'IQ','israel':'IL',
  'jordan':'JO','kuwait':'KW','oman':'OM','qatar':'QA','bahrain':'BH',
  'ethiopia':'ET','ghana':'GH','tanzania':'TZ','mozambique':'MZ',
  'colombia':'CO','argentina':'AR','chile':'CL','peru':'PE',
  'pakistan':'PK','laos':'LA','mongolia':'MN'
};

function toISO2(name) {
  if (!name) return null;
  const lo = name.toLowerCase().trim();
  return CMAP[lo] || (lo.length === 2 ? lo.toUpperCase() : null);
}

const importerISO = toISO2(importerRaw);
const exporterISO = toISO2(exporterRaw);

var matchQuery = { 'applicability.product.hs6': hs6 };
if (importerISO) matchQuery['applicability.reporter'] = 'cty:' + importerISO;
if (exporterISO) matchQuery['applicability.origin']   = 'cty:' + exporterISO;

var label = hs6;
if (exporterRaw && importerRaw) label += " (" + exporterRaw + " \\u2192 " + importerRaw + ")";
else if (importerRaw) label += " (importer: " + importerRaw + ")";
else if (exporterRaw) label += " (exporter: " + exporterRaw + ")";

const unmapped = [];
if (importerRaw && !importerISO) unmapped.push('importer: ' + importerRaw);
if (exporterRaw && !exporterISO) unmapped.push('exporter: ' + exporterRaw);

const pipeline = JSON.stringify([
  {"$match": matchQuery},
  {"$sort": {"applicability.effective_from": -1}},
  {"$facet": {"rows": [{"$limit": 10}]}}
]);

return [{ json: {
  hs6, importerRaw: importerRaw || null, exporterRaw: exporterRaw || null,
  importerISO: importerISO || null, exporterISO: exporterISO || null,
  label, unmapped, matchQuery: JSON.stringify(matchQuery), pipeline
} }];`;

const NEW_FORMAT = `const data = $input.first().json;
const prep = $('Tariff Prep').first().json;
const rows = data.rows || [];

if (prep._error) return [{ json: { ok: false, error: prep._error } }];

if (prep.unmapped && prep.unmapped.length) {
  return [{ json: { ok: false, error: "Country not recognised: " + prep.unmapped.join(", ") + ". Use English name or ISO-2 code (e.g. IN, US, BD)." } }];
}

if (!rows.length) {
  return [{ json: { ok: false, error: "No tariff data found for HS " + prep.hs6
    + (prep.importerRaw ? " imported by " + prep.importerRaw : "")
    + (prep.exporterRaw ? " from " + prep.exporterRaw : "")
    + ". Try without specifying both countries, or check the HS code." } }];
}

const seen = new Set();
const blocks = [];

rows.forEach(function(r) {
  const app = r.applicability || {};
  const str = r.structured || {};
  const rates = str.rates || {};
  const asOf = str.as_of || '';
  const reporter = app.reporter ? app.reporter.replace('cty:', '') : '?';
  const origin = app.origin ? app.origin.replace('cty:', '') : '?';
  const hs = (app.product || {}).code || (app.product || {}).hs6 || '';
  const key = reporter + '|' + origin + '|' + hs;
  if (seen.has(key)) return;
  seen.add(key);

  const rateLines = Object.entries(rates).map(function(entry) {
    const k = entry[0]; const v = entry[1];
    if (k.endsWith('Rules Of Origin')) return null;
    if (!v || v === 'No Preference' || v === 'No preference' || v === 'Not Applicable' || v === 'Not Applicable* ') return null;
    const isExtra = /IEEPA|Section 232|Additional Duty/i.test(k);
    const label2 = k.replace(' Tariff', '').replace(/ \\(As on [^)]+\\)/g, '').trim();
    const val = String(v).endsWith('%') ? v : v + (isNaN(parseFloat(v)) ? '' : '%');
    return (isExtra ? '\\u26a0\\ufe0f ' : '\\u2022 ') + label2 + ': ' + val;
  }).filter(Boolean);

  if (!rateLines.length) return;
  const header = reporter + ' importing from ' + origin + (hs ? ', HS ' + hs : '') + (asOf ? ' (' + asOf + ')' : '');
  blocks.push(header + ':\\n' + rateLines.map(function(l){return '  '+l;}).join('\\n'));
});

if (!blocks.length) {
  return [{ json: { ok: false, error: "Tariff data found but all rates were N/A for HS " + prep.hs6 } }];
}

var summary = 'Tariff rates for ' + prep.label + ':\\n\\n' + blocks.join('\\n\\n');
return [{ json: { ok: true, summary: summary, rowCount: rows.length } }];`;

(async () => {
  console.log('=== Fix: search_tariff → tp_partner_tariff_organized ===');
  console.log('Old: wits.tariff_trains (MFN only)');
  console.log('New: aaziko_organized.tp_partner_tariff_organized (bilateral + FTA + IEEPA)\n');

  const wf = await getWf(TARIFF_WF_ID);
  const prepNode   = wf.nodes.find(n => n.name === 'Tariff Prep');
  const mongoNode  = wf.nodes.find(n => n.name === 'Find Tariff');
  const fmtNode    = wf.nodes.find(n => n.name === 'Format Result');

  if (!prepNode || !mongoNode || !fmtNode) {
    console.log('❌ Nodes not found:', { prep: !!prepNode, mongo: !!mongoNode, fmt: !!fmtNode });
    process.exit(1);
  }

  console.log('Find Tariff — current collection:', mongoNode.parameters.collection, '| db:', mongoNode.parameters.databaseName);
  console.log('Has partner_name filter:', prepNode.parameters.jsCode.includes('partner_name') ? 'YES' : 'NO');

  if (!WRITE) { console.log('\n(dry run — pass --write to apply)'); return; }

  const bk = path.join(BACKUP_DIR, TARIFF_WF_ID + '_before_tpt-collection.json');
  fs.writeFileSync(bk, JSON.stringify(wf, null, 2), 'utf8');
  console.log('Backup:', bk);

  prepNode.parameters.jsCode  = NEW_PREP;
  fmtNode.parameters.jsCode   = NEW_FORMAT;
  mongoNode.parameters.collection  = 'tp_partner_tariff_organized';
  mongoNode.parameters.databaseName = 'aaziko_organized';

  const settings = Object.assign({}, wf.settings);
  delete settings.binaryMode;

  const r = await putWf(TARIFF_WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) {
    console.log('❌ PUT failed (' + r.status + '):', JSON.stringify(r.body).slice(0, 300));
    process.exit(1);
  }
  await activate(TARIFF_WF_ID);

  const check = await getWf(TARIFF_WF_ID);
  const livePrep  = check.nodes.find(n => n.name === 'Tariff Prep');
  const liveMongo = check.nodes.find(n => n.name === 'Find Tariff');
  const liveFmt   = check.nodes.find(n => n.name === 'Format Result');

  const c1 = liveMongo.parameters.collection === 'tp_partner_tariff_organized';
  const c2 = liveMongo.parameters.databaseName === 'aaziko_organized';
  const c3 = livePrep.parameters.jsCode.includes('cty:');
  const c4 = liveFmt.parameters.jsCode.includes('IEEPA');

  console.log(c1 ? '✅ collection: tp_partner_tariff_organized' : '❌ collection wrong: ' + liveMongo.parameters.collection);
  console.log(c2 ? '✅ databaseName: aaziko_organized' : '❌ db wrong: ' + liveMongo.parameters.databaseName);
  console.log(c3 ? '✅ Prep: cty: country codes present' : '❌ Prep: missing cty: mapping');
  console.log(c4 ? '✅ Format: IEEPA highlight present' : '❌ Format: missing IEEPA highlight');

  if (c1 && c2 && c3 && c4) {
    console.log('\n✅ Fix live! search_tariff now returns bilateral + FTA + IEEPA tariff data.');
    console.log('Test: ask "India se USA mein cotton export karne ka tariff kya hai?"');
  } else {
    process.exit(1);
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
