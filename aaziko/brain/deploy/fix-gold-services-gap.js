'use strict';
/*
 * Fix two data gaps:
 * 1. Gold/silver/precious metals missing from DIRECT_HS map in lookup_hs_code
 *    -> add gold=710812, silver=710610, diamond=710239, platinum=711011 etc.
 * 2. Services (IT, software, consulting) cause brain timeout (no HS code exists)
 *    -> add rule to brain: detect service queries and respond immediately without tools
 *
 * node aaziko/brain/deploy/fix-gold-services-gap.js         -- dry run
 * node aaziko/brain/deploy/fix-gold-services-gap.js --write -- deploy
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');
const WRITE = process.argv.includes('--write');

const HS_WF_ID    = 'OqZH3AoC6yy8UIbz'; // lookup_hs_code
const BRAIN_WF_ID = 'w7no6uCJkz7lfaah'; // Aaziko AI Brain

// ── 1. DIRECT_HS additions ─────────────────────────────────────────────────────
const OLD_DIRECT_HS_END = `  'cotton yarn':'520521','cotton fabric':'520811','jute yarn':'530610'\n};`;
const NEW_DIRECT_HS_END = `  'cotton yarn':'520521','cotton fabric':'520811','jute yarn':'530610',\n` +
  `  'gold':'710812','gold bar':'710812','gold bars':'710812','sona':'710812','gold bullion':'710812',\n` +
  `  'silver':'710610','chandi':'710610','silver bar':'710610','silver bullion':'710610',\n` +
  `  'platinum':'711011','palladium':'711021',\n` +
  `  'diamond':'710239','rough diamond':'710210','cut diamond':'710239','heera':'710239',\n` +
  `  'copper':'740311','tamba':'740311','aluminium':'760110','zinc':'790111','lead':'780110'\n` +
`};`;

// ── 2. Brain services rule ─────────────────────────────────────────────────────
// Anchor: the animal-name rule we added earlier
const SERVICES_RULE_ANCHOR = '- Animal names in trade queries ALWAYS mean products derived from them';
const SERVICES_RULE = `- Services (IT, software, consulting, tourism, education, finance) have NO HS code and cannot be traded as goods. If the user asks about exporting services, reply immediately: "Services ka HS code nahi hota — Aaziko physical goods ke liye hai. Aap kisi hardware ya product ke baare mein pooch sakte hain." Do NOT call any tool for a services export query.`;

// ── Local tests ────────────────────────────────────────────────────────────────
function testDirectHs(input, map) {
  var q = input.toLowerCase().trim();
  for (var k in map) { if (q.indexOf(k) >= 0) return map[k]; }
  return null;
}

const NEW_MAP = {
  'gold':'710812','gold bar':'710812','gold bars':'710812','sona':'710812',
  'silver':'710610','chandi':'710610',
  'platinum':'711011','diamond':'710239','heera':'710239',
  'copper':'740311','tamba':'740311','aluminium':'760110',
  // keep existing
  'aloo chips':'190590','namkeen':'190590','basmati':'100630','dal':'071340',
  'cotton yarn':'520521'
};

console.log('=== DIRECT_HS addition tests ===');
const tests = [
  ['gold bars export karna hai', '710812'],
  ['sona export karna hai', '710812'],
  ['silver bullion', '710610'],
  ['diamond export', '710239'],
  ['heera export', '710239'],
  ['copper export', '740311'],
  ['aloo chips', '190590'],  // existing — must still work
  ['solar panels', null],    // should NOT match
];
let allPass = true;
tests.forEach(([input, expected]) => {
  const got = testDirectHs(input, NEW_MAP);
  const pass = got === expected;
  if (!pass) allPass = false;
  console.log((pass ? '✅' : '❌'), `"${input}" -> ${got} (expected ${expected})`);
});

console.log('\nAll tests:', allPass ? '✅ PASS' : '❌ FAIL');
if (!allPass) { process.exit(1); }
if (!WRITE) { console.log('\n(dry run — pass --write to deploy)'); process.exit(0); }

// ── Deploy ─────────────────────────────────────────────────────────────────────
(async () => {
  // --- Part 1: lookup_hs_code DIRECT_HS ---
  const hsWf = await getWf(HS_WF_ID);
  const hsNode = hsWf.nodes.find(n => n.name === 'HS Prep');
  if (!hsNode) { console.log('❌ HS Prep not found'); process.exit(1); }

  const hsCode = hsNode.parameters.jsCode;
  if (!hsCode.includes(OLD_DIRECT_HS_END.trim().slice(0, 30))) {
    console.log('❌ DIRECT_HS end anchor not found in HS Prep');
    console.log('Looking for:', OLD_DIRECT_HS_END.slice(0, 50));
    process.exit(1);
  }
  if (hsCode.includes("'gold':'710812'")) {
    console.log('Gold already in DIRECT_HS — skipping HS Prep update');
  } else {
    fs.writeFileSync(path.join(BACKUP_DIR, HS_WF_ID + '_before_gold_fix.json'), JSON.stringify(hsWf, null, 2), 'utf8');
    console.log('Backup saved (lookup_hs_code).');

    hsNode.parameters.jsCode = hsCode.replace(OLD_DIRECT_HS_END, NEW_DIRECT_HS_END);

    const hsSettings = Object.assign({}, hsWf.settings); delete hsSettings.binaryMode;
    const r1 = await putWf(HS_WF_ID, { name: hsWf.name, nodes: hsWf.nodes, connections: hsWf.connections, settings: hsSettings });
    if (r1.status !== 200) { console.log('❌ PUT lookup_hs_code failed:', r1.body.slice(0, 300)); process.exit(1); }
    await activate(HS_WF_ID);

    const check1 = await getWf(HS_WF_ID);
    const hn2 = check1.nodes.find(n => n.name === 'HS Prep');
    const ok1 = hn2.parameters.jsCode.includes("'gold':'710812'");
    console.log((ok1 ? '✅' : '❌') + ' Gold added to DIRECT_HS');
    if (!ok1) process.exit(1);
  }

  // --- Part 2: Brain services rule ---
  const brainWf = await getWf(BRAIN_WF_ID);
  const bc = brainWf.nodes.find(n => n.name === 'Build Context');
  if (!bc) { console.log('❌ Build Context not found in brain'); process.exit(1); }

  const brainCode = bc.parameters.jsCode;
  if (brainCode.includes('Services ka HS code nahi hota')) {
    console.log('Services rule already present in brain — skipping');
  } else if (!brainCode.includes(SERVICES_RULE_ANCHOR)) {
    console.log('❌ Services anchor (animal-names rule) not found in brain');
    process.exit(1);
  } else {
    fs.writeFileSync(path.join(BACKUP_DIR, BRAIN_WF_ID + '_before_services_rule.json'), JSON.stringify(brainWf, null, 2), 'utf8');
    console.log('Backup saved (brain).');

    bc.parameters.jsCode = brainCode.replace(
      SERVICES_RULE_ANCHOR,
      SERVICES_RULE_ANCHOR + '\n' + SERVICES_RULE
    );

    const brainSettings = Object.assign({}, brainWf.settings); delete brainSettings.binaryMode;
    const r2 = await putWf(BRAIN_WF_ID, { name: brainWf.name, nodes: brainWf.nodes, connections: brainWf.connections, settings: brainSettings });
    if (r2.status !== 200) { console.log('❌ PUT brain failed:', r2.body.slice(0, 300)); process.exit(1); }
    await activate(BRAIN_WF_ID);

    const check2 = await getWf(BRAIN_WF_ID);
    const bc2 = check2.nodes.find(n => n.name === 'Build Context');
    const ok2 = bc2.parameters.jsCode.includes('Services ka HS code nahi hota');
    console.log((ok2 ? '✅' : '❌') + ' Services rule added to brain');
    if (!ok2) process.exit(1);
  }

  console.log('\n✅ All deployed. Test:');
  console.log('  "gold bars export karna hai" → should find HS 710812 + tariff data');
  console.log('  "software export karna hai, HS code kya hoga?" → should reply instantly (no timeout)');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
