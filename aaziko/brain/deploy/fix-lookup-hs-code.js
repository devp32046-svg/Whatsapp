'use strict';
/*
 * Fix lookup_hs_code (OqZH3AoC6yy8UIbz):
 *   Find HS node has database:undefined — set to 'aaziko_organized'
 *   Credential 9hyaSxc0saIzUgsX (organized) is already correct.
 *
 * node aaziko/brain/deploy/fix-lookup-hs-code.js --write
 */
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate, RROOT } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(RROOT, 'backups');
const WF_ID = 'OqZH3AoC6yy8UIbz';
const WRITE = process.argv.includes('--write');

if (!WRITE) { console.log('Fix lookup_hs_code: set database=aaziko_organized on Find HS node\n(--write to deploy)'); process.exit(0); }

(async () => {
  const wf = await getWf(WF_ID);
  fs.writeFileSync(path.join(BACKUP_DIR, WF_ID + '_before_fix_db.json'), JSON.stringify(wf, null, 2), 'utf8');
  console.log('Backup saved. Nodes:', wf.nodes.length);

  const findHS = wf.nodes.find(n => n.name === 'Find HS');
  if (!findHS) { console.log('ERR: Find HS node not found:', wf.nodes.map(n=>n.name).join(', ')); process.exit(1); }

  console.log('Before: database =', findHS.parameters.database, '| cred:', findHS.credentials?.mongoDb?.id);

  findHS.parameters.database   = 'aaziko_organized';
  findHS.parameters.collection = 'map_products_organized';

  const settings = Object.assign({}, wf.settings); delete settings.binaryMode;
  const r = await putWf(WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) { console.log('❌ PUT failed:', r.status, r.body.slice(0, 200)); process.exit(1); }
  console.log('✅ PUT 200');

  await activate(WF_ID);
  console.log('✅ Deactivated + activated');

  const check = await getWf(WF_ID);
  const fn2 = check.nodes.find(n => n.name === 'Find HS');
  const dbOK = fn2 && fn2.parameters.database === 'aaziko_organized';
  console.log((dbOK ? '✅' : '❌') + ' database = aaziko_organized');
  if (!dbOK) process.exit(1);
  console.log('✅ lookup_hs_code fixed');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
