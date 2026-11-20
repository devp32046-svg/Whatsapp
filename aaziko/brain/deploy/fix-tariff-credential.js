'use strict';
/*
 * Fix search_tariff Find Tariff node: wrong credential.
 * "Aaziko (Wits)" connects to WITS server — aaziko_organized doesn't exist there.
 * Fix: use "Aaziko Brain - organized (compliance)" (same cred as Load History/Save Turn).
 *
 * node aaziko/brain/deploy/fix-tariff-credential.js         -- dry run
 * node aaziko/brain/deploy/fix-tariff-credential.js --write -- apply
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const WRITE        = process.argv.includes('--write');
const TARIFF_WF_ID = 'k71O78yLV0v0TXZl';
const BRAIN_ID     = 'w7no6uCJkz7lfaah';
const BACKUP_DIR   = path.resolve(__dirname, '../../../backups');

(async () => {
  console.log('=== Fix: search_tariff Find Tariff credential ===');
  console.log('Problem: credential "Aaziko (Wits)" = WITS server, aaziko_organized not there');
  console.log('Fix: copy credential from brain Load History (aaziko_organized access)\n');

  // Get correct credential from brain
  const brain = await getWf(BRAIN_ID);
  const lh = brain.nodes.find(n => n.name === 'Load History');
  if (!lh || !lh.credentials || !lh.credentials.mongoDb) {
    console.log('❌ Could not find Load History credential'); process.exit(1);
  }
  const correctCred = lh.credentials.mongoDb;
  console.log('Correct credential:', JSON.stringify(correctCred));

  const wf = await getWf(TARIFF_WF_ID);
  const ft = wf.nodes.find(n => n.name === 'Find Tariff');
  if (!ft) { console.log('❌ Find Tariff not found'); process.exit(1); }

  console.log('Current credential:', JSON.stringify(ft.credentials && ft.credentials.mongoDb));

  if (!WRITE) { console.log('\n(dry run — pass --write to apply)'); return; }

  const bk = path.join(BACKUP_DIR, TARIFF_WF_ID + '_before_cred-fix.json');
  fs.writeFileSync(bk, JSON.stringify(wf, null, 2), 'utf8');
  console.log('Backup:', bk);

  ft.credentials = { mongoDb: correctCred };

  const settings = Object.assign({}, wf.settings);
  delete settings.binaryMode;

  const r = await putWf(TARIFF_WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) {
    console.log('❌ PUT failed (' + r.status + '):', JSON.stringify(r.body).slice(0, 300));
    process.exit(1);
  }
  await activate(TARIFF_WF_ID);

  const check = await getWf(TARIFF_WF_ID);
  const liveFt = check.nodes.find(n => n.name === 'Find Tariff');
  const ok = liveFt.credentials && liveFt.credentials.mongoDb && liveFt.credentials.mongoDb.id === correctCred.id;
  console.log(ok ? '✅ Credential updated: ' + correctCred.name : '❌ Credential verify FAILED');
  if (!ok) process.exit(1);
  console.log('\n✅ Now test: "India se USA mein cotton export karne ka tariff kya hai?"');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
