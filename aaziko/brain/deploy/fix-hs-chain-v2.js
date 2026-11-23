'use strict';
/*
 * Fix v2: HS auto-chain extended to compliance/documents + tariff cases.
 * Brain now auto-calls lookup_hs_code for ALL 3 cases when no HS given:
 *   1. Top markets  → lookup_hs_code → get_top_markets
 *   2. Tariff/duty  → lookup_hs_code → search_tariff
 *   3. Documents    → lookup_hs_code → get_compliance
 * Also instructs brain to pass ONLY product name (strip destination/action words).
 *
 * node aaziko/brain/deploy/fix-hs-chain-v2.js          -- verify
 * node aaziko/brain/deploy/fix-hs-chain-v2.js --write  -- deploy
 */
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate, RROOT } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(RROOT, 'backups');
const WF_ID = 'w7no6uCJkz7lfaah';
const WRITE = process.argv.includes('--write');

const OLD = `**IMPORTANT: Agar user top markets ya tariff pooche aur HS code NA de, PEHLE lookup_hs_code(product_name) se HS nikalo, PHIR get_top_markets(hs_code) karo — user se HS code MAANGNA NAHI hai, khud dhoondhlo.**`;

const NEW = `**IMPORTANT — HS auto-chain (3 cases):** (1) Top markets maange bina HS ke → lookup_hs_code(product_name) PHIR get_top_markets. (2) Tariff/duty maange bina HS ke → lookup_hs_code(product_name) PHIR search_tariff. (3) Documents/compliance maange bina HS ke → lookup_hs_code(product_name) PHIR get_compliance. Teeno case mein: sirf PRODUCT ka naam pass karo (destination/action words chhod do, e.g. "leather belt export karna hai Germany" → product_name="leather belt"), aur user se HS code KABHI mat maango — khud nikalo.**`;

(async () => {
  const wf = await getWf(WF_ID);
  fs.writeFileSync(
    path.join(BACKUP_DIR, WF_ID + '_before_hs-chain-v2.json'),
    JSON.stringify(wf, null, 2), 'utf8'
  );
  console.log('Backup saved. Nodes:', wf.nodes.length);

  const bc = wf.nodes.find(n => n.name === 'Build Context');
  if (!bc) { console.log('ERR: Build Context not found'); process.exit(1); }

  if (bc.parameters.jsCode.includes('3 cases')) {
    console.log('OK: Already patched (3 cases present)');
  } else if (bc.parameters.jsCode.includes(OLD)) {
    bc.parameters.jsCode = bc.parameters.jsCode.replace(OLD, NEW);
    console.log('OK: Build Context patched');
  } else {
    console.log('ERR: Neither old nor new string found — check manually');
    process.exit(1);
  }

  const ok = bc.parameters.jsCode.includes('3 cases');
  console.log((ok ? '✅' : '❌') + ' HS auto-chain v2 instruction present');
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
  console.log((bcC.parameters.jsCode.includes('3 cases') ? '✅' : '❌') + ' Read-back: HS chain v2 live');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
