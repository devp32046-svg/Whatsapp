'use strict';
/*
 * Fix Stats Prep to handle all brain tool-call input formats robustly.
 * Brain can pass: {query:"610910"}, {query:'{"hs_code":"610910"}'}, {input:"hs_code: 610910"}, {hs_code:"610910"}
 *
 * node aaziko/brain/deploy/fix-stats-robust-input.js
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');
const STATS_ID   = 'VSjS7OSBfpoQDsor';

const NEW_PREP = [
  "let inp = {};",
  "try { inp = typeof $input.first().json === \"string\" ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}",
  "",
  "// Normalize all brain tool-call formats into structured fields",
  "// {query: '{\"hs_code\":\"610910\"}'} — JSON object in query string",
  "if (!inp.hs_code && !inp.hs && inp.query) {",
  "  var qStr = String(inp.query).trim();",
  "  try {",
  "    var qObj = JSON.parse(qStr);",
  "    if (qObj && typeof qObj === 'object' && !Array.isArray(qObj)) {",
  "      inp = Object.assign({}, inp, qObj);",
  "    }",
  "  } catch(e) {}",
  "}",
  "// {query: \"610910\"} — bare HS code value directly in query",
  "if (!inp.hs_code && !inp.hs && inp.query) {",
  "  var rawQ = String(inp.query).trim();",
  "  var qHsMat = rawQ.match(/^([0-9]{4,6})$/);",
  "  if (qHsMat) {",
  "    inp.hs_code = qHsMat[1];",
  "  } else {",
  "    // free text with HS code embedded",
  "    var qAnyMat = rawQ.match(/([0-9]{4,6})/);",
  "    if (qAnyMat) inp.hs_code = qAnyMat[1];",
  "    var repQ = rawQ.match(/(?:reporter|importer|country)[:\\s]+([a-zA-Z ]+?)(?:,|$)/i);",
  "    if (repQ) inp.reporter = repQ[1].trim();",
  "  }",
  "}",
  "// {input: \"hs_code: 610910\"} — LangChain single-input string",
  "if (!inp.hs_code && !inp.hs && inp.input) {",
  "  var rawIn = String(inp.input).trim();",
  "  var hsMat = rawIn.match(/(?:hs[_\\s-]?code[:\\s]+)?([0-9]{4,6})(?:\\b|$)/i);",
  "  if (hsMat) inp.hs_code = hsMat[1];",
  "  var repMat = rawIn.match(/(?:reporter|importer)[:\\s]+([a-zA-Z ]+?)(?:,|$)/i);",
  "  if (repMat) inp.reporter = repMat[1].trim();",
  "  var oriMat = rawIn.match(/(?:origin|exporter)[:\\s]+([a-zA-Z ]+?)(?:,|$)/i);",
  "  if (oriMat) inp.origin = oriMat[1].trim();",
  "}",
  "",
  "const hs6Raw = String(inp.hs_code || inp.hs || \"\").replace(/\\D/g, \"\").slice(0, 6);",
  "const reporterRaw = String(inp.reporter || inp.importer || inp.country || \"\").trim();",
  "const originRaw   = String(inp.origin || inp.exporter || \"\").trim();",
  "",
  "if (!hs6Raw || hs6Raw.length < 4) {",
  "  return [{ json: { _error: \"hs_code required (4-6 digits, e.g. 610910 for cotton t-shirts)\" } }];",
  "}",
  "const hs6 = hs6Raw.padEnd(6, \"0\").slice(0, 6);",
  "",
  "const CMAP = {",
  "  'india':'IN','united states':'US','usa':'US','us':'US','america':'US',",
  "  'china':'CN','uk':'GB','united kingdom':'GB','germany':'DE','france':'FR',",
  "  'japan':'JP','south korea':'KR','korea':'KR','australia':'AU',",
  "  'canada':'CA','brazil':'BR','indonesia':'ID','vietnam':'VN',",
  "  'thailand':'TH','malaysia':'MY','singapore':'SG','uae':'AE',",
  "  'united arab emirates':'AE','saudi arabia':'SA','turkey':'TR',",
  "  'russia':'RU','bangladesh':'BD','pakistan':'PK','sri lanka':'LK',",
  "  'mexico':'MX','italy':'IT','spain':'ES','netherlands':'NL',",
  "  'belgium':'BE','switzerland':'CH','sweden':'SE','poland':'PL',",
  "  'hong kong':'HK','taiwan':'TW','philippines':'PH','cambodia':'KH'",
  "};",
  "",
  "function toISO2(name) {",
  "  if (!name) return null;",
  "  const lo = name.toLowerCase().trim();",
  "  return CMAP[lo] || (lo.length === 2 ? lo.toUpperCase() : null);",
  "}",
  "",
  "const reporterISO = toISO2(reporterRaw);",
  "const originISO   = toISO2(originRaw);",
  "",
  "const unmapped = [];",
  "if (reporterRaw && !reporterISO) unmapped.push('reporter: ' + reporterRaw);",
  "if (originRaw   && !originISO)   unmapped.push('origin: ' + originRaw);",
  "",
  "const matchQ = { 'applicability.product.hs6': hs6 };",
  "if (reporterISO) matchQ['applicability.reporter'] = 'cty:' + reporterISO;",
  "if (originISO)   matchQ['applicability.origin']   = 'cty:' + originISO;",
  "",
  "const pipeline = JSON.stringify([",
  "  { \"$match\": matchQ },",
  "  { \"$sort\": { \"structured.latest_year\": -1, \"structured.latest_value\": -1 } },",
  "  { \"$facet\": {",
  "    \"rows\": [{ \"$limit\": 10 }],",
  "    \"total\": [{ \"$count\": \"n\" }]",
  "  }}",
  "]);",
  "",
  "var label = hs6;",
  "if (reporterRaw && originRaw) label += \" (\" + originRaw + \" -> \" + reporterRaw + \")\";",
  "else if (reporterRaw) label += \" (importer: \" + reporterRaw + \")\";",
  "else if (originRaw)   label += \" (exporter: \" + originRaw + \")\";",
  "",
  "return [{ json: {",
  "  hs6, reporterRaw: reporterRaw || null, originRaw: originRaw || null,",
  "  reporterISO: reporterISO || null, originISO: originISO || null,",
  "  label, unmapped, matchQuery: JSON.stringify(matchQ), pipeline",
  "} }];"
].join('\n');

(async () => {
  console.log('=== Fix: Stats Prep robust input normalization ===\n');

  // Local test
  function testParse(inp) {
    if (!inp.hs_code && !inp.hs && inp.query) {
      var qStr = String(inp.query).trim();
      try { var q = JSON.parse(qStr); if (q && typeof q === 'object' && !Array.isArray(q)) inp = Object.assign({}, inp, q); } catch(e) {}
    }
    if (!inp.hs_code && !inp.hs && inp.query) {
      var rawQ = String(inp.query).trim();
      var m = rawQ.match(/^([0-9]{4,6})$/);
      if (m) inp.hs_code = m[1];
      else { var m2 = rawQ.match(/([0-9]{4,6})/); if (m2) inp.hs_code = m2[1]; }
    }
    if (!inp.hs_code && !inp.hs && inp.input) {
      var rawIn = String(inp.input).trim();
      var hsMat = rawIn.match(/(?:hs[\s_-]?code[:\s]+)?([0-9]{4,6})(?:\b|$)/i);
      if (hsMat) inp.hs_code = hsMat[1];
    }
    return String(inp.hs_code || inp.hs || '').replace(/\D/g,'').slice(0,6);
  }

  const tests = [
    [{query:'610910'}, '610910'],
    [{query:'{"hs_code":"610910"}'}, '610910'],
    [{hs_code:'610910'}, '610910'],
    [{input:'hs_code: 610910'}, '610910'],
    [{query:'cotton t-shirts 610910 imports'}, '610910'],
  ];
  let allPass = true;
  tests.forEach(([inp, expected]) => {
    const got = testParse(inp);
    const pass = got === expected;
    if (!pass) allPass = false;
    console.log((pass ? '✅' : '❌'), JSON.stringify(inp), '->', got, pass ? '' : '(expected '+expected+')');
  });
  if (!allPass) { console.log('\nSome tests failed — not deploying'); process.exit(1); }

  const wf = await getWf(STATS_ID);
  const prep = wf.nodes.find(n => n.name === 'Stats Prep');

  fs.writeFileSync(path.join(BACKUP_DIR, STATS_ID + '_before_robust-input.json'), JSON.stringify(wf, null, 2), 'utf8');

  prep.parameters.jsCode = NEW_PREP;
  const settings = Object.assign({}, wf.settings);
  delete settings.binaryMode;

  const r = await putWf(STATS_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) { console.log('❌ PUT failed:', r.body.slice(0,200)); process.exit(1); }
  await activate(STATS_ID);

  const check = await getWf(STATS_ID);
  const live = check.nodes.find(n => n.name === 'Stats Prep');
  const ok = live.parameters.jsCode.includes('qHsMat') && live.parameters.jsCode.includes('qObj');
  console.log('\n' + (ok ? '✅' : '❌') + ' Stats Prep deployed with robust input normalization');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
