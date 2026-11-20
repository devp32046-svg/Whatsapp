'use strict';
/*
 * Fix Build Context: replace `systemPrompt +=` (fails on const) with inline append in return.
 * Also adds explicit tool routing section to system prompt.
 *
 * node aaziko/brain/deploy/fix-build-context-routing.js         -- dry run
 * node aaziko/brain/deploy/fix-build-context-routing.js --write -- apply
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const WRITE      = process.argv.includes('--write');
const BRAIN_ID   = 'w7no6uCJkz7lfaah';
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');

const TOOL_ROUTING = `\n\n## TOOL ROUTING (use the right tool for each query type)
- Trade volume/statistics ("how much is imported", "which country imports most", "trade flow data", "export volume"): use get_trade_stats with hs_code
- Trade agreements/FTA ("what FTA does X have", "agreement between X and Y", "free trade agreement", "RTA"): use get_trade_agreements with country1 (and optional country2)
- Buyer discovery ("who buys this", "find buyers", "importers of", "potential customers"): use find_buyers with keyword
- Tariff/duty rates ("what is the duty", "import tax", "customs rate", "MFN rate"): use search_tariff
- Port information ("port details", "facilities at port", "which port"): use find_port
- Trade compliance/documents ("what documents needed", "import requirements", "certificates"): use get_compliance`;

(async () => {
  console.log('=== Fix: Build Context — TOOL ROUTING const assignment bug ===\n');

  const brainWf = await getWf(BRAIN_ID);
  const bcNode = brainWf.nodes.find(n => n.name === 'Build Context');
  const code = bcNode.parameters.jsCode;

  // Check current state
  const hasRoutingBlock = code.includes('TOOL ROUTING');
  const hasConstBug = code.includes("systemPrompt += '\\n\\n'");
  const hasLetBug = code.includes('systemPrompt +=');
  console.log('Has TOOL ROUTING section:', hasRoutingBlock);
  console.log('Has const += bug:', hasConstBug || hasLetBug);

  // Show lines around the return
  const returnIdx = code.lastIndexOf('return [{');
  console.log('\nAround return statement:\n' + code.slice(returnIdx - 50, returnIdx + 200));

  if (!WRITE) { console.log('\n(dry run — pass --write to apply)'); return; }

  // Strategy:
  // 1. Remove the broken "toolRouting" block (lines 96-104) if present
  // 2. Append TOOL_ROUTING directly in the return statement's systemPrompt field
  let newCode = code;

  // Remove the broken block if it exists
  const brokenBlockStart = '\n\n// Explicit tool routing instructions\nconst toolRouting';
  if (newCode.includes(brokenBlockStart)) {
    // Find the start and end of the broken block
    const bStart = newCode.indexOf(brokenBlockStart);
    // Find next return statement after it
    const bEnd = newCode.indexOf('\nreturn [{', bStart);
    newCode = newCode.slice(0, bStart) + newCode.slice(bEnd);
    console.log('Removed broken toolRouting block');
  }

  // Also remove old += line if still present
  if (newCode.includes("systemPrompt += '\\n\\n' + toolRouting;")) {
    newCode = newCode.replace("systemPrompt += '\\n\\n' + toolRouting;\n", '');
    console.log('Removed systemPrompt += line');
  }

  // Now modify the return statement to include TOOL_ROUTING inline
  // Find: systemPrompt: systemPrompt,
  const OLD_RETURN_LINE = '  systemPrompt: systemPrompt,';
  const TOOL_ROUTING_ESCAPED = TOOL_ROUTING.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
  const NEW_RETURN_LINE = '  systemPrompt: systemPrompt + `' + TOOL_ROUTING_ESCAPED + '`,';

  if (!newCode.includes(OLD_RETURN_LINE)) {
    console.log('❌ Could not find return line "systemPrompt: systemPrompt,"');
    console.log('Current return area:', newCode.slice(newCode.lastIndexOf('return'), newCode.lastIndexOf('return') + 200));
    process.exit(1);
  }

  newCode = newCode.replace(OLD_RETURN_LINE, NEW_RETURN_LINE);
  console.log('Updated return statement to include TOOL_ROUTING inline');

  // Verify syntax by checking for obvious errors
  if (newCode.includes("systemPrompt +=")) {
    console.log('❌ Still has += bug');
    process.exit(1);
  }

  // Backup
  const bk = path.join(BACKUP_DIR, BRAIN_ID + '_before_fix-bc-routing.json');
  fs.writeFileSync(bk, JSON.stringify(brainWf, null, 2), 'utf8');
  console.log('Backup:', bk);

  bcNode.parameters.jsCode = newCode;

  const brainSettings = Object.assign({}, brainWf.settings);
  delete brainSettings.binaryMode;

  const r = await putWf(BRAIN_ID, { name: brainWf.name, nodes: brainWf.nodes, connections: brainWf.connections, settings: brainSettings });
  if (r.status !== 200) { console.log('❌ PUT failed:', r.body.slice(0, 300)); process.exit(1); }
  await activate(BRAIN_ID);

  const check = await getWf(BRAIN_ID);
  const liveBc = check.nodes.find(n => n.name === 'Build Context');
  const liveCode = liveBc.parameters.jsCode;
  console.log('\nVerify:');
  console.log('  Has TOOL ROUTING:', liveCode.includes('TOOL ROUTING') ? '✅' : '❌');
  console.log('  No += bug:', !liveCode.includes('systemPrompt +=') ? '✅' : '❌');

  console.log('\n✅ Build Context fixed. Test: "India ke trade agreements kaun kaun se hain?"');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
