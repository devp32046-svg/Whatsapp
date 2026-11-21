'use strict';
/*
 * Fix search_products (IdQQ66Ugw7eJIqax):
 *   1. Find Products node has database:undefined — set to 'indiamart'
 *   2. Credential g9NnHH7ocvb52kdM (Aaziko Brain - indiamart) has empty URI — patch with AAZIKO_TRADE_DB_URI
 *
 * indiamart.products = 1.23M products (product_name, company_name, category, subcategory, product_url, contact_details)
 *
 * node aaziko/brain/deploy/fix-search-products.js          -- verify
 * node aaziko/brain/deploy/fix-search-products.js --write  -- deploy
 */
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { req, getWf, putWf, activate, RROOT } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(RROOT, 'backups');
const WF_ID   = 'IdQQ66Ugw7eJIqax';
const CRED_ID = 'g9NnHH7ocvb52kdM';
const WRITE   = process.argv.includes('--write');

const CONN_STR = process.env.AAZIKO_TRADE_DB_URI;
if (!CONN_STR) { console.log('❌ AAZIKO_TRADE_DB_URI not set'); process.exit(1); }
console.log('✅ AAZIKO_TRADE_DB_URI present (' + CONN_STR.slice(0,20) + '...)');

if (!WRITE) {
  console.log('\nDry-run checks:');
  console.log(' Workflow ID:', WF_ID);
  console.log(' Credential to patch:', CRED_ID, '(Aaziko Brain - indiamart)');
  console.log(' database → indiamart, collection → products, op → aggregate');
  console.log('\n(--write to deploy)');
  process.exit(0);
}

(async () => {
  // 1. Patch the credential with the correct connection string
  console.log('\nPatching credential', CRED_ID, '...');
  const patchR = await req('PUT', '/api/v1/credentials/' + CRED_ID, {
    name: 'Aaziko Brain - indiamart (products)',
    type: 'mongoDb',
    data: { connectionString: CONN_STR }
  });
  if (patchR.status !== 200) {
    console.log('❌ Credential PUT failed:', patchR.status, patchR.body.slice(0, 300));
    // Don't abort — maybe PUT not supported, try PATCH
    const patchR2 = await req('PATCH', '/api/v1/credentials/' + CRED_ID, {
      name: 'Aaziko Brain - indiamart (products)',
      type: 'mongoDb',
      data: { connectionString: CONN_STR }
    });
    if (patchR2.status !== 200) {
      console.log('❌ Credential PATCH also failed:', patchR2.status, patchR2.body.slice(0, 300));
      console.log('Proceeding with workflow node fix only (credential might need manual update in n8n UI)');
    } else {
      console.log('✅ Credential patched via PATCH');
    }
  } else {
    console.log('✅ Credential patched via PUT');
  }

  // 2. Fix the workflow: set database to 'indiamart'
  const wf = await getWf(WF_ID);
  fs.writeFileSync(path.join(BACKUP_DIR, WF_ID + '_before_fix_search_products.json'), JSON.stringify(wf, null, 2), 'utf8');
  console.log('\nBackup saved. Nodes:', wf.nodes.length);

  const findNode = wf.nodes.find(n => n.name === 'Find Products');
  if (!findNode) {
    console.log('❌ Find Products node missing:', wf.nodes.map(n=>n.name).join(', '));
    process.exit(1);
  }

  findNode.parameters.database   = 'indiamart';
  findNode.parameters.collection = 'products';
  findNode.parameters.operation  = 'aggregate';
  // Keep the same credential (now patched with correct URI)
  findNode.credentials = { mongoDb: { id: CRED_ID, name: 'Aaziko Brain - indiamart (products)' } };

  const settings = Object.assign({}, wf.settings); delete settings.binaryMode;
  const r = await putWf(WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) { console.log('❌ PUT failed:', r.status, r.body.slice(0, 300)); process.exit(1); }
  console.log('✅ PUT 200');

  await activate(WF_ID);
  console.log('✅ Deactivated + activated');

  // Read-back verify
  const check = await getWf(WF_ID);
  const fn2 = check.nodes.find(n => n.name === 'Find Products');
  const dbOK = fn2 && fn2.parameters.database === 'indiamart';
  const credOK = fn2 && fn2.credentials?.mongoDb?.id === CRED_ID;
  console.log((dbOK ? '✅' : '❌') + ' database = indiamart');
  console.log((credOK ? '✅' : '❌') + ' credential = indiamart cred');

  if (!dbOK) { console.log('❌ Read-back failed'); process.exit(1); }
  console.log('\n✅ search_products fixed. Test: brain pe "cotton t-shirts ke suppliers dhundho"');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
