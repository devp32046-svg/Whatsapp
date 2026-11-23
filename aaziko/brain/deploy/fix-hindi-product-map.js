'use strict';
/*
 * Add Hindi/Hinglish product name → English mapping to brain prompt.
 * When user says "suti kapde", "chawal", "haldi" etc., brain now translates
 * to English before calling lookup_hs_code.
 *
 * node aaziko/brain/deploy/fix-hindi-product-map.js          -- verify
 * node aaziko/brain/deploy/fix-hindi-product-map.js --write  -- deploy
 */
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate, RROOT } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(RROOT, 'backups');
const WF_ID = 'w7no6uCJkz7lfaah';
const WRITE = process.argv.includes('--write');

const ANCHOR = '## RULES\n- NEVER invent tariff rates, product details, port data, or HS codes — call the tool, always.';

const HINDI_BLOCK = `## HINDI/HINGLISH PRODUCT NAMES
Jab user Hindi ya Hinglish mein product naam de, lookup_hs_code mein English equivalent pass karo:
suti/suti kapde/suti cloth → cotton fabric | resham/reshmi → silk | uun → wool
chawal → rice | gehun → wheat | makka → corn | dal → lentils | cheeni → sugar | namak → salt
haldi → turmeric | jeera → cumin | mirch → chili pepper | adrak → ginger | lahsun → garlic
pyaz → onion | sarson → mustard | tel → oil | masale → spices
kapda/kapde → fabric | chamda → leather | jute → jute fiber
loha/lohe → iron | tamba → copper | sona → gold | chandi → silver
aluminium patta → aluminum sheet | plastic dana → plastic granules

`;

(async () => {
  const wf = await getWf(WF_ID);
  fs.writeFileSync(
    path.join(BACKUP_DIR, WF_ID + '_before_hindi-map.json'),
    JSON.stringify(wf, null, 2), 'utf8'
  );
  console.log('Backup saved. Nodes:', wf.nodes.length);

  const bc = wf.nodes.find(n => n.name === 'Build Context');
  if (!bc) { console.log('ERR: Build Context not found'); process.exit(1); }

  if (bc.parameters.jsCode.includes('HINDI/HINGLISH')) {
    console.log('OK: Already patched');
  } else if (bc.parameters.jsCode.includes(ANCHOR)) {
    bc.parameters.jsCode = bc.parameters.jsCode.replace(ANCHOR, HINDI_BLOCK + ANCHOR);
    console.log('OK: Hindi map added');
  } else {
    console.log('ERR: anchor "## RULES" not found — check manually');
    process.exit(1);
  }

  const ok = bc.parameters.jsCode.includes('HINDI/HINGLISH');
  console.log((ok ? '✅' : '❌') + ' Hindi map present');
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
  console.log((bcC.parameters.jsCode.includes('HINDI/HINGLISH') ? '✅' : '❌') + ' Read-back: Hindi map live');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
