'use strict';
/*
 * Add plastic granules/dana to lookup_hs_code DIRECT_HS table.
 * HS 390110 = polyethylene granules (most common plastic dana export)
 *
 * node aaziko/brain/deploy/fix-hs-plastic.js          -- verify
 * node aaziko/brain/deploy/fix-hs-plastic.js --write  -- deploy
 */
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate, RROOT } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(RROOT, 'backups');
const WF_ID = 'OqZH3AoC6yy8UIbz';
const WRITE = process.argv.includes('--write');

const OLD = `'plastic toys':'950300','toys':'950300'`;
const NEW = `'plastic granules':'390110','plastic dana':'390110','plastic pellets':'390110','plastic toys':'950300','toys':'950300'`;

(async () => {
  const wf = await getWf(WF_ID);
  fs.writeFileSync(path.join(BACKUP_DIR, WF_ID + '_before_plastic.json'), JSON.stringify(wf, null, 2), 'utf8');
  console.log('Backup saved. Nodes:', wf.nodes.length);

  const prep = wf.nodes.find(n => n.name === 'HS Prep');
  if (!prep) { console.log('ERR: HS Prep not found'); process.exit(1); }

  if (prep.parameters.jsCode.includes("'plastic granules':'390110'")) {
    console.log('OK: Already patched');
  } else if (prep.parameters.jsCode.includes(OLD)) {
    prep.parameters.jsCode = prep.parameters.jsCode.replace(OLD, NEW);
    console.log('OK: plastic granules/dana added → HS 390110');
  } else {
    console.log('ERR: anchor not found'); process.exit(1);
  }

  const ok = prep.parameters.jsCode.includes("'plastic granules':'390110'");
  console.log((ok ? '✅' : '❌') + ' plastic granules in DIRECT_HS');
  if (!ok) process.exit(1);
  if (!WRITE) { console.log('\n✅ Verify OK — run --write to deploy'); process.exit(0); }

  const settings = Object.assign({}, wf.settings); delete settings.binaryMode;
  const r = await putWf(WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) { console.log('PUT failed:', r.status, r.body.slice(0,300)); process.exit(1); }
  console.log('✅ PUT 200');
  await activate(WF_ID);
  console.log('✅ Activated');
  const check = await getWf(WF_ID);
  const prepC = check.nodes.find(n => n.name === 'HS Prep');
  console.log((prepC.parameters.jsCode.includes("'plastic granules':'390110'") ? '✅' : '❌') + ' Read-back live');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
