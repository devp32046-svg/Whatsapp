'use strict';
/*
 * Fix get_trade_stats + get_trade_agreements Prep nodes to handle LangChain single-input format.
 *
 * Problem: brain passes {"input":"hs_code: 610910"} instead of {"hs_code":"610910"}.
 * This happens because n8n toolWorkflow nodes don't have a typed schema, so LangChain
 * sometimes wraps everything as {"input": "..."}.
 *
 * Fix: add fallback parsing of inp.input string in both Prep nodes.
 *
 * node aaziko/brain/deploy/fix-subwf-input-parsing.js         -- dry run
 * node aaziko/brain/deploy/fix-subwf-input-parsing.js --write -- apply
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const WRITE      = process.argv.includes('--write');
const STATS_ID   = 'VSjS7OSBfpoQDsor';    // get_trade_stats
const AGREE_ID   = 'VD5U9B9GCVb3ymo0';    // get_trade_agreements
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');

// ── Helper to prepend input-string parsing to a Prep code ────────────────────
// Adds parsing of inp.input free-text BEFORE the main logic.
// Called at the top of each Prep node after `let inp = ...`
const INPUT_PARSER_STATS = `
// Handle LangChain single-input format: {"input":"hs_code:610910 reporter:USA"}
if (!inp.hs_code && !inp.hs && inp.input) {
  var rawIn = String(inp.input).trim();
  // Extract 4-6 digit HS code
  var hsMat = rawIn.match(/(?:hs[_\\s-]?code[:\\s]+)?([0-9]{4,6})(?:\\b|$)/i);
  if (hsMat) inp.hs_code = hsMat[1];
  // Extract reporter/importer country
  var repMat = rawIn.match(/(?:reporter|importer)[:\\s]+([a-zA-Z ]+?)(?:,|$)/i);
  if (repMat) inp.reporter = repMat[1].trim();
  // Extract origin/exporter country
  var oriMat = rawIn.match(/(?:origin|exporter)[:\\s]+([a-zA-Z ]+?)(?:,|$)/i);
  if (oriMat) inp.origin = oriMat[1].trim();
}`;

const INPUT_PARSER_AGREE = `
// Handle LangChain single-input format: {"input":"country1:India country2:Vietnam"}
if (!inp.country1 && !inp.country && inp.input) {
  var rawIn = String(inp.input).trim();
  // Try "country1:X country2:Y" format
  var c1Mat = rawIn.match(/(?:country1|country)[:\\s]+([a-zA-Z ]+?)(?:,|country2|and|\\s*$)/i);
  if (c1Mat) inp.country1 = c1Mat[1].trim();
  var c2Mat = rawIn.match(/(?:country2|and|partner)[:\\s]+([a-zA-Z ]+?)(?:,|$)/i);
  if (c2Mat) inp.country2 = c2Mat[1].trim();
  // If no labeled format, extract bare country names separated by "and" or "&"
  if (!inp.country1) {
    var bare = rawIn.replace(/country\\d?[:\\s]*/gi,'').split(/\\s+(?:and|&)\\s+/i);
    if (bare.length >= 1) inp.country1 = bare[0].trim();
    if (bare.length >= 2) inp.country2 = bare[1].trim();
  }
}`;

function insertAfterInpDecl(code, insertion) {
  // Insert after the first `try { inp = ...` block (the input normalization)
  const marker = 'try { inp = typeof $input.first().json === "string" ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}';
  if (!code.includes(marker)) {
    throw new Error('Cannot find inp declaration marker in code');
  }
  return code.replace(marker, marker + '\n' + insertion);
}

(async () => {
  console.log('=== Fix: Sub-workflow input parsing (LangChain single-input fallback) ===\n');

  const [statsWf, agreeWf] = await Promise.all([getWf(STATS_ID), getWf(AGREE_ID)]);

  const statsPrepNode = statsWf.nodes.find(n => n.name === 'Stats Prep');
  const agreePrepNode = agreeWf.nodes.find(n => n.name === 'Agreement Prep');

  console.log('Stats Prep found:', !!statsPrepNode);
  console.log('Agreement Prep found:', !!agreePrepNode);

  const statsHasFix = statsPrepNode.parameters.jsCode.includes('LangChain single-input');
  const agreeHasFix = agreePrepNode.parameters.jsCode.includes('LangChain single-input');
  console.log('Stats Prep already has fix:', statsHasFix);
  console.log('Agreement Prep already has fix:', agreeHasFix);

  if (!WRITE) { console.log('\n(dry run — pass --write to apply)'); return; }

  // ── get_trade_stats ─────────────────────────────────────────────────────────
  if (!statsHasFix) {
    const bk = path.join(BACKUP_DIR, STATS_ID + '_before_input-fix.json');
    fs.writeFileSync(bk, JSON.stringify(statsWf, null, 2), 'utf8');

    statsPrepNode.parameters.jsCode = insertAfterInpDecl(statsPrepNode.parameters.jsCode, INPUT_PARSER_STATS);

    const statsSettings = Object.assign({}, statsWf.settings);
    delete statsSettings.binaryMode;

    const r1 = await putWf(STATS_ID, { name: statsWf.name, nodes: statsWf.nodes, connections: statsWf.connections, settings: statsSettings });
    if (r1.status !== 200) { console.log('❌ Stats PUT failed:', r1.body.slice(0, 200)); process.exit(1); }
    await activate(STATS_ID);

    const c1 = await getWf(STATS_ID);
    const liveStats = c1.nodes.find(n => n.name === 'Stats Prep');
    console.log(liveStats.parameters.jsCode.includes('LangChain single-input')
      ? '✅ get_trade_stats: input fallback parser added'
      : '❌ get_trade_stats: fix not found in live code');
  } else {
    console.log('get_trade_stats: already fixed');
  }

  // ── get_trade_agreements ───────────────────────────────────────────────────
  if (!agreeHasFix) {
    const bk = path.join(BACKUP_DIR, AGREE_ID + '_before_input-fix.json');
    fs.writeFileSync(bk, JSON.stringify(agreeWf, null, 2), 'utf8');

    agreePrepNode.parameters.jsCode = insertAfterInpDecl(agreePrepNode.parameters.jsCode, INPUT_PARSER_AGREE);

    const agreeSettings = Object.assign({}, agreeWf.settings);
    delete agreeSettings.binaryMode;

    const r2 = await putWf(AGREE_ID, { name: agreeWf.name, nodes: agreeWf.nodes, connections: agreeWf.connections, settings: agreeSettings });
    if (r2.status !== 200) { console.log('❌ Agreements PUT failed:', r2.body.slice(0, 200)); process.exit(1); }
    await activate(AGREE_ID);

    const c2 = await getWf(AGREE_ID);
    const liveAgree = c2.nodes.find(n => n.name === 'Agreement Prep');
    console.log(liveAgree.parameters.jsCode.includes('LangChain single-input')
      ? '✅ get_trade_agreements: input fallback parser added'
      : '❌ get_trade_agreements: fix not found in live code');
  } else {
    console.log('get_trade_agreements: already fixed');
  }

  console.log('\n✅ Done! Test again: "HS 610910 ke liye trade statistics dikhao" and "India aur Vietnam ka FTA"');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
