'use strict';
/*
 * Fix Agreement Prep to handle all brain tool-call input formats robustly.
 * Brain can pass: {query:"India"}, {query:'{"country1":"India"}'}, {country1:"India"}, etc.
 *
 * node aaziko/brain/deploy/fix-agreements-robust-input.js
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');
const AGREE_ID   = 'VD5U9B9GCVb3ymo0';

const NEW_PREP = [
  "let inp = {};",
  "try { inp = typeof $input.first().json === \"string\" ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}",
  "",
  "// Normalize all brain tool-call formats into structured fields",
  "// {query: '{\"country1\":\"India\"}'} — JSON object in query string",
  "if (!inp.country1 && !inp.country && inp.query) {",
  "  var qStr = String(inp.query).trim();",
  "  try {",
  "    var qObj = JSON.parse(qStr);",
  "    if (qObj && typeof qObj === 'object' && !Array.isArray(qObj)) {",
  "      inp = Object.assign({}, inp, qObj);",
  "    }",
  "  } catch(e) {}",
  "}",
  "// {query: \"India\"} — bare country name in query",
  "if (!inp.country1 && !inp.country && inp.query) {",
  "  var rawQ = String(inp.query).trim();",
  "  // Check if it looks like a country name (letters/spaces, no JSON)",
  "  if (rawQ && !rawQ.startsWith('{')) {",
  "    // Try to split by 'and' or '&' or comma for two countries",
  "    var parts = rawQ.split(/\\s+(?:and|&|,)\\s+/i);",
  "    if (parts.length >= 1 && parts[0].trim()) inp.country1 = parts[0].trim();",
  "    if (parts.length >= 2 && parts[1].trim()) inp.country2 = parts[1].trim();",
  "  }",
  "}",
  "// {input: \"country1: India country2: Vietnam\"} — LangChain single-input string",
  "if (!inp.country1 && !inp.country && inp.input) {",
  "  var rawIn = String(inp.input).trim();",
  "  // Try labeled format first",
  "  var c1Mat = rawIn.match(/(?:country1|country)[:\\s]+([a-zA-Z ]+?)(?:,|country2|and|\\s*$)/i);",
  "  if (c1Mat) inp.country1 = c1Mat[1].trim();",
  "  var c2Mat = rawIn.match(/(?:country2|and|partner)[:\\s]+([a-zA-Z ]+?)(?:,|$)/i);",
  "  if (c2Mat) inp.country2 = c2Mat[1].trim();",
  "  // If no labeled format, extract bare country names",
  "  if (!inp.country1) {",
  "    var bare = rawIn.replace(/country\\d?[:\\s]*/gi,'').split(/\\s+(?:and|&)\\s+/i);",
  "    if (bare.length >= 1 && bare[0].trim()) inp.country1 = bare[0].trim();",
  "    if (bare.length >= 2 && bare[1].trim()) inp.country2 = bare[1].trim();",
  "  }",
  "}",
  "",
  "const country1 = String(inp.country1 || inp.country || \"\").trim();",
  "const country2 = String(inp.country2 || \"\").trim();",
  "",
  "if (!country1) {",
  "  return [{ json: { _error: \"country1 required (e.g. India, USA, China)\" } }];",
  "}",
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
  "  'hong kong':'HK','taiwan':'TW','philippines':'PH','cambodia':'KH',",
  "  'myanmar':'MM','kenya':'KE','nigeria':'NG','egypt':'EG','morocco':'MA',",
  "  'ethiopia':'ET','ghana':'GH','peru':'PE','chile':'CL','colombia':'CO',",
  "  'ukraine':'UA','poland':'PL','czech republic':'CZ','romania':'RO',",
  "  'new zealand':'NZ','south africa':'ZA','israel':'IL','iran':'IR',",
  "  'iraq':'IQ','qatar':'QA','kuwait':'KW','oman':'OM','bahrain':'BH'",
  "};",
  "",
  "function toISO2(name) {",
  "  if (!name) return null;",
  "  const lo = name.toLowerCase().trim();",
  "  return CMAP[lo] || (lo.length === 2 ? lo.toUpperCase() : null);",
  "}",
  "",
  "const iso1 = toISO2(country1);",
  "const iso2 = toISO2(country2);",
  "",
  "const matchQ = {};",
  "if (iso1) {",
  "  if (iso2) {",
  "    // Look for agreements between both countries",
  "    matchQ['$or'] = [",
  "      { 'applicability.reporter': 'cty:' + iso1, 'applicability.partner_keys': 'cty:' + iso2 },",
  "      { 'applicability.reporter': 'cty:' + iso2, 'applicability.partner_keys': 'cty:' + iso1 }",
  "    ];",
  "  } else {",
  "    // All agreements involving country1",
  "    matchQ['$or'] = [",
  "      { 'applicability.reporter': 'cty:' + iso1 },",
  "      { 'applicability.partner_keys': 'cty:' + iso1 }",
  "    ];",
  "  }",
  "} else {",
  "  // Try text search fallback",
  "  matchQ.text = { '$regex': country1, '$options': 'i' };",
  "  if (country2) matchQ.text['$regex'] = country1 + '|' + country2;",
  "}",
  "",
  "const pipeline = JSON.stringify([",
  "  { \"$match\": Object.assign({kind: 'trade_agreement'}, matchQ) },",
  "  { \"$sort\": { \"structured.entry_into_force\": -1 } },",
  "  { \"$facet\": {",
  "    \"rows\": [{ \"$limit\": 10 }],",
  "    \"total\": [{ \"$count\": \"n\" }]",
  "  }}",
  "]);",
  "",
  "return [{ json: {",
  "  country1, country2: country2 || null,",
  "  iso1: iso1 || null, iso2: iso2 || null,",
  "  unmapped: [",
  "    ...(!iso1 && country1 ? ['country1: ' + country1] : []),",
  "    ...(!iso2 && country2 ? ['country2: ' + country2] : [])",
  "  ],",
  "  pipeline",
  "} }];"
].join('\n');

(async () => {
  console.log('=== Fix: Agreement Prep robust input normalization ===\n');

  function testParseCountry(inp) {
    var c1 = inp.country1 || inp.country;
    if (!c1 && inp.query) {
      var qStr = String(inp.query).trim();
      try { var q = JSON.parse(qStr); if (q && typeof q === 'object' && !Array.isArray(q)) { c1 = q.country1 || q.country; } } catch(e) {}
      if (!c1 && !qStr.startsWith('{')) { c1 = qStr.split(/\s+(?:and|&|,)\s+/i)[0].trim(); }
    }
    if (!c1 && inp.input) {
      var m = String(inp.input).match(/(?:country1|country)[:\s]+([a-zA-Z ]+?)(?:,|country2|and|\s*$)/i);
      if (m) c1 = m[1].trim();
    }
    return c1 || '';
  }

  const tests = [
    [{query:'India'}, 'India'],
    [{query:'{"country1":"India"}'}, 'India'],
    [{country1:'India'}, 'India'],
    [{input:'country1: India country2: Vietnam'}, 'India'],
    [{query:'India and Vietnam'}, 'India'],
  ];
  let allPass = true;
  tests.forEach(([inp, expected]) => {
    const got = testParseCountry(inp);
    const pass = got === expected;
    if (!pass) allPass = false;
    console.log((pass ? '✅' : '❌'), JSON.stringify(inp), '->', got, pass ? '' : '(expected '+expected+')');
  });
  if (!allPass) { console.log('\nSome tests failed — not deploying'); process.exit(1); }

  const wf = await getWf(AGREE_ID);
  const prep = wf.nodes.find(n => n.name === 'Agreement Prep');

  fs.writeFileSync(path.join(BACKUP_DIR, AGREE_ID + '_before_robust-input.json'), JSON.stringify(wf, null, 2), 'utf8');

  prep.parameters.jsCode = NEW_PREP;
  const settings = Object.assign({}, wf.settings);
  delete settings.binaryMode;

  const r = await putWf(AGREE_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) { console.log('❌ PUT failed:', r.body.slice(0,200)); process.exit(1); }
  await activate(AGREE_ID);

  const check = await getWf(AGREE_ID);
  const live = check.nodes.find(n => n.name === 'Agreement Prep');
  const ok = live.parameters.jsCode.includes('qObj') && live.parameters.jsCode.includes('rawQ');
  console.log('\n' + (ok ? '✅' : '❌') + ' Agreement Prep deployed with robust input normalization');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
