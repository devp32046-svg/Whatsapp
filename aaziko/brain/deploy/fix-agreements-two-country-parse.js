'use strict';
/*
 * Fix Agreement Prep: handle brain passing {input:"India China"} (2 countries space-separated, no "and").
 *
 * Bug: brain calls get_trade_agreements with {input:"India China"}.
 * Prep parses inp.input but splits only on "and|&|," — "India China" stays as one token.
 * toISO2("India China") = null → text-regex fallback → 0 results.
 *
 * Fix: after bare parsing, if country1 is exactly 2 words and country2 is empty,
 * split country1 into two single-word countries.
 *
 * node aaziko/brain/deploy/fix-agreements-two-country-parse.js
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');
const AGREE_ID   = 'VD5U9B9GCVb3ymo0';

// The two-word split to insert BEFORE "const country1 = ..." line
// Triggered only when country1 has 2 words and country2 is not set
const TWO_WORD_FIX = `
// Handle brain passing "Country1 Country2" space-separated without "and"
// e.g. {input:"India China"} → parsed country1="India China", country2=""
if (inp.country1 && !inp.country2) {
  var spW = String(inp.country1).trim().split(/\\s+/);
  if (spW.length === 2) {
    inp.country1 = spW[0];
    inp.country2 = spW[1];
  } else if (spW.length === 3) {
    // Could be "South Korea Vietnam" — try first 2 words as country1, last as country2
    inp.country1 = spW.slice(0,2).join(' ');
    inp.country2 = spW[2];
  }
}
`;

(async () => {
  console.log('=== Fix: Agreement Prep — two-country space-separated parse ===\n');

  // Local test to verify fix logic
  function testParse(rawIn) {
    var inp = {};
    // Simulate the inp.input path
    if (!inp.country1 && !inp.country && rawIn) {
      var c1Mat = rawIn.match(/(?:country1|country)[:\s]+([a-zA-Z ]+?)(?:,|country2|and|\s*$)/i);
      if (c1Mat) inp.country1 = c1Mat[1].trim();
      var c2Mat = rawIn.match(/(?:country2|and|partner)[:\s]+([a-zA-Z ]+?)(?:,|$)/i);
      if (c2Mat) inp.country2 = c2Mat[1].trim();
      if (!inp.country1) {
        var bare = rawIn.replace(/country\d?[:\s]*/gi,'').split(/\s+(?:and|&)\s+/i);
        if (bare.length >= 1 && bare[0].trim()) inp.country1 = bare[0].trim();
        if (bare.length >= 2 && bare[1].trim()) inp.country2 = bare[1].trim();
      }
    }
    // Apply two-word fix
    if (inp.country1 && !inp.country2) {
      var spW = String(inp.country1).trim().split(/\s+/);
      if (spW.length === 2) { inp.country1 = spW[0]; inp.country2 = spW[1]; }
      else if (spW.length === 3) { inp.country1 = spW.slice(0,2).join(' '); inp.country2 = spW[2]; }
    }
    return [inp.country1||'', inp.country2||''];
  }

  const tests = [
    ['India China',         ['India', 'China']],
    ['India Vietnam',       ['India', 'Vietnam']],
    ['India and China',     ['India', 'China']],
    ['India',               ['India', '']],
    ['South Korea Vietnam', ['South Korea', 'Vietnam']],
    ['country1: India country2: China', ['India', 'China']],
  ];
  let allPass = true;
  tests.forEach(([inp, [ec1, ec2]]) => {
    const [gc1, gc2] = testParse(inp);
    const pass = gc1 === ec1 && gc2 === ec2;
    if (!pass) allPass = false;
    console.log((pass ? '✅' : '❌'), `"${inp}" → ["${gc1}", "${gc2}"]`, pass ? '' : `  expected ["${ec1}", "${ec2}"]`);
  });
  if (!allPass) { console.log('\nSome tests failed — not deploying'); process.exit(1); }
  console.log('\nAll tests pass. Deploying...\n');

  const wf = await getWf(AGREE_ID);
  const prep = wf.nodes.find(n => n.name === 'Agreement Prep');
  const code = prep.parameters.jsCode;

  // Find the anchor: "const country1 = " line — insert TWO_WORD_FIX before it
  const ANCHOR = '\nconst country1 = String(';
  if (!code.includes(ANCHOR)) {
    console.log('❌ Cannot find anchor "const country1 = " in Agreement Prep');
    process.exit(1);
  }

  const newCode = code.replace(ANCHOR, TWO_WORD_FIX + ANCHOR);

  // Verify it's not already there
  if (code.includes('spW.length === 2')) {
    console.log('Fix already present in code — skipping deploy');
    return;
  }

  fs.writeFileSync(path.join(BACKUP_DIR, AGREE_ID + '_before_two-country.json'), JSON.stringify(wf, null, 2), 'utf8');

  prep.parameters.jsCode = newCode;
  const settings = Object.assign({}, wf.settings);
  delete settings.binaryMode;

  const r = await putWf(AGREE_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) { console.log('❌ PUT failed:', r.body.slice(0,200)); process.exit(1); }
  await activate(AGREE_ID);

  const check = await getWf(AGREE_ID);
  const live = check.nodes.find(n => n.name === 'Agreement Prep');
  const ok = live.parameters.jsCode.includes('spW.length === 2');
  console.log((ok ? '✅' : '❌') + ' Agreement Prep: two-country space-split deployed');
  console.log('\nTest: "India China ke beech FTA hai kya?" → RCEP + APTA expected');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
