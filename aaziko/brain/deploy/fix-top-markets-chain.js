'use strict';
/*
 * Fix: get_top_markets auto-chain with lookup_hs_code
 * When user asks for top markets without HS code, brain should call
 * lookup_hs_code first, then get_top_markets — not ask the user for HS.
 *
 * node aaziko/brain/deploy/fix-top-markets-chain.js          -- verify
 * node aaziko/brain/deploy/fix-top-markets-chain.js --write  -- deploy
 */
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate, RROOT } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(RROOT, 'backups');
const WF_ID = 'w7no6uCJkz7lfaah';
const WRITE = process.argv.includes('--write');

const OLD = `- get_top_markets: Jab bhi kisi product ka HS code milta hai, TURANT get_top_markets(hs_code) bhi call karo (ek hi response mein). Result mein top 3-4 markets ka naam aur export value batao. Example: "Leather jackets (HS 420310) ke liye Spain $66M, USA $75M, Italy $47M export hota hai. Kisi ke liye tariff ya compliance dekhna hai?" — Sirf tab skip karo jab user specifically ek country maange aur markets ka sawaal hi na ho.
- lookup_hs_code: call with hs_code (6-digit) for description, OR product_name for reverse HS code lookup.`;

const NEW = `- get_top_markets: Jab bhi kisi product ka HS code milta hai, TURANT get_top_markets(hs_code) bhi call karo (ek hi response mein). Result mein top 3-4 markets ka naam aur export value batao. Example: "Leather jackets (HS 420310) ke liye Spain $66M, USA $75M, Italy $47M export hota hai. Kisi ke liye tariff ya compliance dekhna hai?" — Sirf tab skip karo jab user specifically ek country maange aur markets ka sawaal hi na ho.
- lookup_hs_code: call with hs_code (6-digit) for description, OR product_name for reverse HS code lookup. **IMPORTANT: Agar user top markets ya tariff pooche aur HS code NA de, PEHLE lookup_hs_code(product_name) se HS nikalo, PHIR get_top_markets(hs_code) karo — user se HS code MAANGNA NAHI hai, khud dhoondhlo.**`;

(async () => {
  const wf = await getWf(WF_ID);
  fs.writeFileSync(
    path.join(BACKUP_DIR, WF_ID + '_before_top-markets-chain.json'),
    JSON.stringify(wf, null, 2), 'utf8'
  );
  console.log('Backup saved. Nodes:', wf.nodes.length);

  const bc = wf.nodes.find(n => n.name === 'Build Context');
  if (!bc) { console.log('ERR: Build Context not found'); process.exit(1); }

  if (!bc.parameters.jsCode.includes(OLD)) {
    if (bc.parameters.jsCode.includes('khud dhoondhlo')) {
      console.log('OK: Already patched');
    } else {
      console.log('ERR: OLD string not found — check manually');
      process.exit(1);
    }
  } else {
    bc.parameters.jsCode = bc.parameters.jsCode.replace(OLD, NEW);
    console.log('OK: Build Context patched');
  }

  // Verify
  const ok = bc.parameters.jsCode.includes('khud dhoondhlo');
  console.log((ok ? '✅' : '❌') + ' Chain instruction present');
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
  console.log((bcC.parameters.jsCode.includes('khud dhoondhlo') ? '✅' : '❌') + ' Read-back: chain instruction live');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
