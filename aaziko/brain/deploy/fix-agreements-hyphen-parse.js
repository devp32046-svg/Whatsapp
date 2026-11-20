'use strict';
/*
 * Fix Agreement Prep: handle hyphen-separated country pairs.
 * Brain passes {input:"India-Vietnam"} (hyphen, no space) for "India-Vietnam FTA".
 * Current TWO_WORD_FIX splits on spaces only → "India-Vietnam" = 1 token → null iso → 0 results.
 *
 * Fix: also replace hyphens with spaces + strip FTA/trade keywords before split.
 *
 * node aaziko/brain/deploy/fix-agreements-hyphen-parse.js         -- dry run
 * node aaziko/brain/deploy/fix-agreements-hyphen-parse.js --write -- deploy
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');
const AGREE_ID   = 'VD5U9B9GCVb3ymo0';
const WRITE = process.argv.includes('--write');

// OLD block (deployed by fix-agreements-two-country-parse.js)
const OLD_FIX = `var spW = String(inp.country1).trim().split(/\\s+/);`;

// NEW block — also handles hyphens + strips FTA/trade keywords
const NEW_SPLIT_LINE = `var c1norm = String(inp.country1).trim()
    .replace(/\\b(fta|rta|agreement|trade|free)\\b/gi, '')
    .replace(/-/g, ' ')
    .replace(/\\s+/g, ' ').trim();
  var spW = c1norm.split(/\\s+/);`;

(async () => {
  console.log('=== Fix: Agreement Prep — hyphen + FTA keyword strip ===\n');

  // Local tests
  function testParse(rawIn) {
    var inp = {};
    // Simulate inp.input path (bare parse → country1 set, country2 not)
    if (!inp.country1 && !inp.country && rawIn) {
      var bare = rawIn.replace(/country\d?[:\s]*/gi,'').split(/\s+(?:and|&)\s+/i);
      if (bare.length >= 1 && bare[0].trim()) inp.country1 = bare[0].trim();
      if (bare.length >= 2 && bare[1].trim()) inp.country2 = bare[1].trim();
    }
    // Apply updated fix (what will be live)
    if (inp.country1 && !inp.country2) {
      var c1norm = String(inp.country1).trim()
        .replace(/\b(fta|rta|agreement|trade|free)\b/gi, '')
        .replace(/-/g, ' ')
        .replace(/\s+/g, ' ').trim();
      var spW = c1norm.split(/\s+/);
      if (spW.length === 2) { inp.country1 = spW[0]; inp.country2 = spW[1]; }
      else if (spW.length === 3) { inp.country1 = spW.slice(0,2).join(' '); inp.country2 = spW[2]; }
    }
    return [inp.country1||'', inp.country2||''];
  }

  const tests = [
    ['India-Vietnam',       ['India', 'Vietnam']],
    ['India-China',         ['India', 'China']],
    ['USA-China',           ['USA', 'China']],
    ['India-Vietnam FTA',   ['India', 'Vietnam']],  // FTA stripped
    ['India Vietnam',       ['India', 'Vietnam']],  // space (original fix still works)
    ['India China',         ['India', 'China']],
    ['India and China',     ['India', 'China']],    // 'and' split already handled before
    ['India',               ['India', '']],          // single country unchanged
    ['South Korea Vietnam', ['South Korea', 'Vietnam']],
  ];
  let allPass = true;
  tests.forEach(([raw, [ec1, ec2]]) => {
    const [gc1, gc2] = testParse(raw);
    const pass = gc1 === ec1 && gc2 === ec2;
    if (!pass) allPass = false;
    console.log((pass?'✅':'❌'), `"${raw}" → ["${gc1}", "${gc2}"]`, pass?'':` expected ["${ec1}","${ec2}"]`);
  });
  if (!allPass) { console.log('\nTests failed — not deploying'); process.exit(1); }
  console.log('\nAll tests pass.\n');

  if (!WRITE) { console.log('(dry run — pass --write to deploy)'); return; }

  const wf = await getWf(AGREE_ID);
  const prep = wf.nodes.find(n => n.name === 'Agreement Prep');
  const code = prep.parameters.jsCode;

  if (!code.includes(OLD_FIX)) {
    console.log('❌ Cannot find old split line in Agreement Prep (already updated or different version)');
    console.log('Checking if fix is already present...');
    if (code.includes('replace(/-/g')) {
      console.log('✅ Hyphen fix already present — nothing to do');
    } else {
      console.log('Live code differs from expected. Manual inspection needed.');
    }
    return;
  }

  if (code.includes('replace(/-/g')) {
    console.log('Hyphen fix already present — skipping deploy');
    return;
  }

  fs.writeFileSync(path.join(BACKUP_DIR, AGREE_ID + '_before_hyphen-fix.json'), JSON.stringify(wf, null, 2), 'utf8');
  console.log('Backup saved.\n');

  const newCode = code.replace(OLD_FIX, NEW_SPLIT_LINE);
  prep.parameters.jsCode = newCode;

  const settings = Object.assign({}, wf.settings);
  delete settings.binaryMode;

  const r = await putWf(AGREE_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) { console.log('❌ PUT failed:', r.body.slice(0,300)); process.exit(1); }
  await activate(AGREE_ID);

  const check = await getWf(AGREE_ID);
  const live = check.nodes.find(n => n.name === 'Agreement Prep');
  const ok = live.parameters.jsCode.includes('replace(/-/g');
  const noOld = !live.parameters.jsCode.includes('split(/\\\\s+/)') || live.parameters.jsCode.includes('c1norm');
  console.log((ok?'✅':'❌') + ' Hyphen replace deployed');
  console.log((noOld?'✅':'❌') + ' Old space-only split replaced');

  if (ok) {
    console.log('\n✅ Agreement Prep: hyphen + FTA keyword strip deployed');
    console.log('Now test in UI: "India-Vietnam FTA" → should return ASEAN-India + RCEP');
    console.log('               "India-China" → RCEP + APTA');
    console.log('               "USA-China FTA" → (no agreement expected)');
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
