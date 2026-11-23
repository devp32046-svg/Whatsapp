'use strict';
/*
 * Hindi map v2: fix jeera→cumin seeds + compound chamda/kapda pattern.
 *
 * node aaziko/brain/deploy/fix-hindi-map-v2.js          -- verify
 * node aaziko/brain/deploy/fix-hindi-map-v2.js --write  -- deploy
 */
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate, RROOT } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(RROOT, 'backups');
const WF_ID = 'w7no6uCJkz7lfaah';
const WRITE = process.argv.includes('--write');

// Fix 1: jeera → cumin seeds (was: cumin → matched coriander 090920)
const OLD_JEERA = 'jeera → cumin | mirch → chili pepper';
const NEW_JEERA = 'jeera → cumin seeds | mirch → chili pepper';

// Fix 2: compound chamda/kapda pattern
const OLD_ANCHOR = 'aluminium patta → aluminum sheet | plastic dana → plastic granules\n\n';
const NEW_ANCHOR = `aluminium patta → aluminum sheet | plastic dana → plastic granules
Compound pattern: "chamda se bana/banaya/banaye [item]" → product_name="leather [item]" (e.g. "chamda se banaye jacket" → "leather jacket")
Compound pattern: "kapda/suti se bana/banaya/banaye [item]" → product_name="cotton [item]"

`;

(async () => {
  const wf = await getWf(WF_ID);
  fs.writeFileSync(
    path.join(BACKUP_DIR, WF_ID + '_before_hindi-map-v2.json'),
    JSON.stringify(wf, null, 2), 'utf8'
  );
  console.log('Backup saved. Nodes:', wf.nodes.length);

  const bc = wf.nodes.find(n => n.name === 'Build Context');
  if (!bc) { console.log('ERR: Build Context not found'); process.exit(1); }

  let changed = 0;

  if (bc.parameters.jsCode.includes(OLD_JEERA)) {
    bc.parameters.jsCode = bc.parameters.jsCode.replace(OLD_JEERA, NEW_JEERA);
    console.log('OK: jeera → cumin seeds fixed');
    changed++;
  } else if (bc.parameters.jsCode.includes('cumin seeds')) {
    console.log('OK: jeera already fixed');
  } else {
    console.log('ERR: jeera anchor not found'); process.exit(1);
  }

  if (bc.parameters.jsCode.includes(OLD_ANCHOR)) {
    bc.parameters.jsCode = bc.parameters.jsCode.replace(OLD_ANCHOR, NEW_ANCHOR);
    console.log('OK: compound chamda/kapda pattern added');
    changed++;
  } else if (bc.parameters.jsCode.includes('Compound pattern')) {
    console.log('OK: compound pattern already present');
  } else {
    console.log('ERR: compound anchor not found'); process.exit(1);
  }

  const ok1 = bc.parameters.jsCode.includes('cumin seeds');
  const ok2 = bc.parameters.jsCode.includes('Compound pattern');
  console.log((ok1 ? '✅' : '❌') + ' jeera→cumin seeds');
  console.log((ok2 ? '✅' : '❌') + ' compound pattern');
  if (!ok1 || !ok2) process.exit(1);

  if (!WRITE) { console.log('\n✅ Verify OK — run --write to deploy'); process.exit(0); }

  const settings = Object.assign({}, wf.settings); delete settings.binaryMode;
  const r = await putWf(WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) { console.log('PUT failed:', r.status, r.body.slice(0, 300)); process.exit(1); }
  console.log('✅ PUT 200');

  await activate(WF_ID);
  console.log('✅ Activated');

  const check = await getWf(WF_ID);
  const bcC = check.nodes.find(n => n.name === 'Build Context');
  const v1 = bcC.parameters.jsCode.includes('cumin seeds');
  const v2 = bcC.parameters.jsCode.includes('Compound pattern');
  console.log((v1 ? '✅' : '❌') + ' Read-back: jeera fix live');
  console.log((v2 ? '✅' : '❌') + ' Read-back: compound pattern live');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
