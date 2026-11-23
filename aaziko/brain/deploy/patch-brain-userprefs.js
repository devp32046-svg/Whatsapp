'use strict';
/*
 * Patch Aaziko brain to support userPrefs from UI personalization panel.
 *   1. Normalize Message — pass through userPrefs field
 *   2. Build Context — inject userPrefs into system prompt
 *
 * node aaziko/brain/deploy/patch-brain-userprefs.js          -- verify
 * node aaziko/brain/deploy/patch-brain-userprefs.js --write  -- deploy
 */
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate, RROOT } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(RROOT, 'backups');
const WF_ID = 'w7no6uCJkz7lfaah';
const WRITE = process.argv.includes('--write');

(async () => {
  const wf = await getWf(WF_ID);
  fs.writeFileSync(
    path.join(BACKUP_DIR, WF_ID + '_before_userprefs.json'),
    JSON.stringify(wf, null, 2), 'utf8'
  );
  console.log('Backup saved. Nodes:', wf.nodes.length);

  // ── 1. Normalize Message — add userPrefs passthrough ─────────────────
  const nm = wf.nodes.find(n => n.name === 'Normalize Message');
  if (!nm) { console.log('ERR: Normalize Message not found'); process.exit(1); }

  const OLD_NM_RETURN = `return [{ json: {
  channel,
  text,
  sessionId,
  chatInput: text,
  sessionKey: 'az-' + sessionId,
  secret,
  ts: String(Date.now())
} }];`;

  const NEW_NM_RETURN = `const userPrefs = String(body.userPrefs || '').trim().slice(0, 2000);
return [{ json: {
  channel,
  text,
  sessionId,
  chatInput: text,
  sessionKey: 'az-' + sessionId,
  secret,
  userPrefs,
  ts: String(Date.now())
} }];`;

  if (!nm.parameters.jsCode.includes(OLD_NM_RETURN)) {
    // Try to detect if already patched
    if (nm.parameters.jsCode.includes('userPrefs')) {
      console.log('OK: Normalize Message already has userPrefs');
    } else {
      console.log('ERR: Normalize Message return block not found — check manually');
      console.log('Tail:', nm.parameters.jsCode.slice(-300));
      process.exit(1);
    }
  } else {
    nm.parameters.jsCode = nm.parameters.jsCode.replace(OLD_NM_RETURN, NEW_NM_RETURN);
    console.log('OK: Normalize Message patched');
  }

  // ── 2. Build Context — inject userPrefs into systemPrompt ─────────────
  const bc = wf.nodes.find(n => n.name === 'Build Context');
  if (!bc) { console.log('ERR: Build Context not found'); process.exit(1); }

  // Find the final return object to inject userPrefs
  const OLD_BC_RETURN = `return [{ json: {
  chatInput: g.chatInput,
  sessionKey: g.sessionKey,
  systemPrompt: systemPrompt +`;

  if (!bc.parameters.jsCode.includes(OLD_BC_RETURN)) {
    if (bc.parameters.jsCode.includes('userPrefs')) {
      console.log('OK: Build Context already has userPrefs');
    } else {
      console.log('ERR: Build Context return block not found');
      process.exit(1);
    }
  } else {
    // Inject userPrefs block just before the final systemPrompt assembly
    const PREFS_INJECT = `// User personalisation rules (from UI Prefs panel)
const userPrefs = (g.userPrefs || '').trim();
const prefsBlock = userPrefs
  ? '\\n\\n## USER PERSONALISATION (follow strictly in EVERY reply)\\n' + userPrefs
  : '';

`;
    // Insert PREFS_INJECT just before the final return
    bc.parameters.jsCode = bc.parameters.jsCode.replace(
      OLD_BC_RETURN,
      PREFS_INJECT + OLD_BC_RETURN
    );

    // Now append prefsBlock to systemPrompt in the return
    // The return has: systemPrompt: systemPrompt + `...long string...`
    // We need to append prefsBlock at the end of that string
    // The systemPrompt value ends with the TOOL ROUTING block closing backtick
    bc.parameters.jsCode = bc.parameters.jsCode.replace(
      `- Trade compliance/documents ("what documents needed", "import requirements", "certificates"): use get_compliance\`,`,
      `- Trade compliance/documents ("what documents needed", "import requirements", "certificates"): use get_compliance\` + prefsBlock,`
    );
    console.log('OK: Build Context patched');
  }

  // ── Verify ────────────────────────────────────────────────────────────
  const nmOK = nm.parameters.jsCode.includes('userPrefs');
  const bcOK = bc.parameters.jsCode.includes('prefsBlock') || bc.parameters.jsCode.includes('USER PERSONALISATION');
  console.log((nmOK ? 'OK' : 'ERR') + ': Normalize Message userPrefs present');
  console.log((bcOK ? 'OK' : 'ERR') + ': Build Context prefsBlock present');
  if (!nmOK || !bcOK) process.exit(1);

  if (!WRITE) { console.log('\n✅ Verify OK — run --write to deploy'); process.exit(0); }

  const settings = Object.assign({}, wf.settings); delete settings.binaryMode;
  const r = await putWf(WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) {
    console.log('PUT failed:', r.status, r.body.slice(0, 300));
    process.exit(1);
  }
  console.log('✅ PUT 200');

  await activate(WF_ID);
  console.log('✅ Activated');

  const check = await getWf(WF_ID);
  const nmC = check.nodes.find(n => n.name === 'Normalize Message');
  const bcC = check.nodes.find(n => n.name === 'Build Context');
  console.log((nmC.parameters.jsCode.includes('userPrefs') ? '✅' : '❌') + ' Read-back: Normalize Message');
  console.log((bcC.parameters.jsCode.includes('USER PERSONALISATION') ? '✅' : '❌') + ' Read-back: Build Context');
  console.log('✅ Brain userPrefs patch live');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
