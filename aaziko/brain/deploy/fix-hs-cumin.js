'use strict';
/*
 * Fix: jeera/cumin HS code in lookup_hs_code workflow DIRECT_HS table.
 * 090920 = coriander seeds (WRONG)
 * 090930 = cumin seeds (CORRECT)
 *
 * node aaziko/brain/deploy/fix-hs-cumin.js          -- verify
 * node aaziko/brain/deploy/fix-hs-cumin.js --write  -- deploy
 */
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate, RROOT } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(RROOT, 'backups');
const WF_ID = 'OqZH3AoC6yy8UIbz'; // lookup_hs_code workflow
const WRITE = process.argv.includes('--write');

const OLD = `'haldi powder':'091030','jeera':'090920','cumin':'090920','adrak':'091011'`;
const NEW = `'haldi powder':'091030','jeera':'090930','cumin':'090930','zeera':'090930','adrak':'091011'`;

(async () => {
  const wf = await getWf(WF_ID);
  fs.writeFileSync(
    path.join(BACKUP_DIR, WF_ID + '_before_cumin-fix.json'),
    JSON.stringify(wf, null, 2), 'utf8'
  );
  console.log('Backup saved. Nodes:', wf.nodes.length);

  const prep = wf.nodes.find(n => n.name === 'HS Prep');
  if (!prep) { console.log('ERR: HS Prep not found'); process.exit(1); }

  if (prep.parameters.jsCode.includes("'cumin':'090930'")) {
    console.log('OK: Already fixed');
  } else if (prep.parameters.jsCode.includes(OLD)) {
    prep.parameters.jsCode = prep.parameters.jsCode.replace(OLD, NEW);
    console.log('OK: cumin 090920 → 090930 fixed');
  } else {
    console.log('ERR: OLD string not found in HS Prep — check manually');
    console.log('Looking for:', OLD);
    // Show surrounding context
    const idx = prep.parameters.jsCode.indexOf('jeera');
    if (idx >= 0) console.log('jeera context:', prep.parameters.jsCode.slice(idx-10, idx+60));
    process.exit(1);
  }

  const ok = prep.parameters.jsCode.includes("'cumin':'090930'");
  console.log((ok ? '✅' : '❌') + ' cumin→090930 (cumin seeds)');
  if (!ok) process.exit(1);

  if (!WRITE) { console.log('\n✅ Verify OK — run --write to deploy'); process.exit(0); }

  const settings = Object.assign({}, wf.settings); delete settings.binaryMode;
  const r = await putWf(WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) { console.log('PUT failed:', r.status, r.body.slice(0, 300)); process.exit(1); }
  console.log('✅ PUT 200');

  await activate(WF_ID);
  console.log('✅ Activated');

  const check = await getWf(WF_ID);
  const prepC = check.nodes.find(n => n.name === 'HS Prep');
  console.log((prepC.parameters.jsCode.includes("'cumin':'090930'") ? '✅' : '❌') + ' Read-back: cumin fix live');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
