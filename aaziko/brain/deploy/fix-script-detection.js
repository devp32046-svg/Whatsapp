'use strict';
/*
 * Strengthen Roman-script detection rule in brain prompt.
 * Problem: brain replies in Devanagari for Hinglish queries like
 *   "HS 854140 kya hota hai" or "aam ke top markets"
 * Root cause: (1) model detects "aam"/"kya" as Hindi → Devanagari
 *             (2) tool returns DB descriptions in Devanagari → brain mirrors
 * Fix: explicitly say "detect by ASCII characters, not by word language;
 *       if tool returns Devanagari but user typed Roman, translate it"
 *
 * node aaziko/brain/deploy/fix-script-detection.js          -- verify
 * node aaziko/brain/deploy/fix-script-detection.js --write  -- deploy
 */
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate, RROOT } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(RROOT, 'backups');
const WF_ID = 'w7no6uCJkz7lfaah';
const WRITE = process.argv.includes('--write');

const OLD = `- **CRITICAL: If user writes in Latin/Roman script (even Hindi words like "kya hota hai", "batao", "chahiye"), ALWAYS reply in Latin/Roman script — NEVER use Devanagari or Gujarati script. When in doubt, default to Roman/Hinglish.**`;

const NEW = `- **CRITICAL — SCRIPT DETECTION BY CHARACTERS, NOT WORDS:** Any message using only ASCII/Latin characters is Roman script — this includes Hindi words written in Latin like "aam", "chawal", "kya hota hai", "batao". For ALL Roman-script inputs: reply in English/Hinglish ONLY, never output Devanagari or Gujarati characters. If a tool returns a description in Devanagari, translate/paraphrase it into English in your reply. Exception: user sends actual Devanagari (e.g. "कया है") → reply in Devanagari.**`;

(async () => {
  const wf = await getWf(WF_ID);
  fs.writeFileSync(path.join(BACKUP_DIR, WF_ID + '_before_script-v2.json'), JSON.stringify(wf, null, 2), 'utf8');
  console.log('Backup saved. Nodes:', wf.nodes.length);

  const bc = wf.nodes.find(n => n.name === 'Build Context');
  if (!bc) { console.log('ERR: Build Context not found'); process.exit(1); }

  if (bc.parameters.jsCode.includes('SCRIPT DETECTION BY CHARACTERS')) {
    console.log('OK: Already patched');
  } else if (bc.parameters.jsCode.includes(OLD)) {
    bc.parameters.jsCode = bc.parameters.jsCode.replace(OLD, NEW);
    console.log('OK: Script detection rule strengthened');
  } else {
    console.log('ERR: OLD string not found');
    // Show what's around the CRITICAL line
    const idx = bc.parameters.jsCode.indexOf('CRITICAL');
    if (idx >= 0) console.log('Found CRITICAL at:', bc.parameters.jsCode.slice(idx, idx + 200));
    process.exit(1);
  }

  const ok = bc.parameters.jsCode.includes('SCRIPT DETECTION BY CHARACTERS');
  console.log((ok ? '✅' : '❌') + ' Script detection rule (characters not words)');
  if (!ok) process.exit(1);

  if (!WRITE) { console.log('\n✅ Verify OK — run --write to deploy'); process.exit(0); }

  const settings = Object.assign({}, wf.settings); delete settings.binaryMode;
  const r = await putWf(WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) { console.log('PUT failed:', r.status, r.body.slice(0, 300)); process.exit(1); }
  console.log('✅ PUT 200');
  await activate(WF_ID);
  console.log('✅ Activated');

  const check = await getWf(WF_ID);
  const bcC = check.nodes.find(n => n.name === 'Build Context');
  console.log((bcC.parameters.jsCode.includes('SCRIPT DETECTION BY CHARACTERS') ? '✅' : '❌') + ' Read-back live');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
