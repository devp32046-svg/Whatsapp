'use strict';
/*
 * Fix Aaziko brain: handle max-iterations crash gracefully
 * 1. Agent: continueOnFail = true (error passes to next node instead of empty HTTP response)
 * 2. Agent: maxIterations 10 → 15 (less likely to hit the limit)
 * 3. Parse Reply: add error-check at top → graceful fallback message
 *
 * node aaziko/brain/deploy/fix-brain-max-iterations.js         -- dry run
 * node aaziko/brain/deploy/fix-brain-max-iterations.js --write -- deploy
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');
const WF_ID = 'w7no6uCJkz7lfaah';
const WRITE = process.argv.includes('--write');

// What to prepend to Parse Reply code
const ERROR_GUARD = [
  "// Fallback: agent node errored (e.g. max iterations reached) → continueOnFail passes error here",
  "if ($input.first().json.error) {",
  "  const _ch = ($('Normalize Message').first() || { json: {} }).json.channel || 'ui';",
  "  return [{ json: { replyText: 'Yeh query thodi complex thi — please ise thoda differently puchho, ya ek kaam ek baar mein batao.', channel: _ch } }];",
  "}"
].join('\n') + '\n\n';

// The first line of Parse Reply (anchor to prepend before)
const PARSE_REPLY_FIRST_LINE = 'const out = $input.first().json;';

console.log('=== Brain: max-iterations graceful fallback ===\n');
console.log('Changes:');
console.log(' 1. Aaziko AI Brain: continueOnFail = true');
console.log(' 2. Aaziko AI Brain: maxIterations 10 → 15');
console.log(' 3. Parse Reply: error guard prepended\n');

// Syntax check the guard
try { new Function(ERROR_GUARD + 'const out = {};'); console.log('✅ Error guard syntax OK'); }
catch(e) { console.log('❌ Syntax error:', e.message); process.exit(1); }

if (!WRITE) { console.log('\n(dry run — pass --write to deploy)'); process.exit(0); }

// ── Deploy ────────────────────────────────────────────────────────────────────
(async () => {
  const wf = await getWf(WF_ID);

  const agent = wf.nodes.find(n => n.name === 'Aaziko AI Brain');
  const parseReply = wf.nodes.find(n => n.name === 'Parse Reply');
  if (!agent)     { console.log('❌ Aaziko AI Brain node not found'); process.exit(1); }
  if (!parseReply){ console.log('❌ Parse Reply node not found');     process.exit(1); }

  fs.writeFileSync(path.join(BACKUP_DIR, WF_ID + '_before_maxiter_fix.json'), JSON.stringify(wf, null, 2), 'utf8');
  console.log('Backup saved.\n');

  // 1+2: Agent node changes
  agent.continueOnFail = true;
  if (!agent.parameters.options) agent.parameters.options = {};
  agent.parameters.options.maxIterations = 15;

  // 3: Parse Reply error guard — prepend only if not already present
  const prCode = parseReply.parameters.jsCode;
  if (prCode.includes('continueOnFail') || prCode.includes('$input.first().json.error')) {
    console.log('Parse Reply guard already present — skipping');
  } else {
    if (!prCode.startsWith(PARSE_REPLY_FIRST_LINE)) {
      console.log('❌ Parse Reply anchor mismatch');
      console.log('First line:', prCode.split('\n')[0]);
      process.exit(1);
    }
    parseReply.parameters.jsCode = ERROR_GUARD + prCode;
  }

  const settings = Object.assign({}, wf.settings); delete settings.binaryMode;
  const r = await putWf(WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) { console.log('❌ PUT failed:', r.body.slice(0, 400)); process.exit(1); }
  await activate(WF_ID);

  // Read-back verify
  const check = await getWf(WF_ID);
  const a2 = check.nodes.find(n => n.name === 'Aaziko AI Brain');
  const p2 = check.nodes.find(n => n.name === 'Parse Reply');
  const ok = a2.continueOnFail === true &&
             a2.parameters.options.maxIterations === 15 &&
             p2.parameters.jsCode.includes('$input.first().json.error');
  console.log((ok ? '✅' : '❌') + ' Brain max-iterations fix deployed');
  if (ok) {
    console.log('  - continueOnFail: true ✅');
    console.log('  - maxIterations: 15 ✅');
    console.log('  - Parse Reply error guard: ✅');
    console.log('\nTest: "HS 610910 ke buyers dhundho France mein" should now return graceful message');
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
