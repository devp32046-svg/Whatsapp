'use strict';
/*
 * Fix find_port Find Ports node: revert credential to searates-specific one.
 *
 * Problem: credential OXJ4UVacMY1qofx6 ("Aaziko Brain - searates (ports)") had
 * "URI contained empty userinfo section" errors (11-19 14:15-14:16). But the
 * credential was fixed in n8n UI by 14:20 on 11-19 (exec 1457750 = success).
 *
 * Our earlier fix (fix-tariff-credential.js pattern) wrongly replaced the
 * credential with 9hyaSxc0saIzUgsX ("Aaziko Brain - organized") which only
 * has access to aaziko_organized — not searates-scraper — returning 0 rows.
 *
 * Fix: revert Find Ports credential back to OXJ4UVacMY1qofx6.
 *
 * node aaziko/brain/deploy/fix-port-credential.js         -- dry run
 * node aaziko/brain/deploy/fix-port-credential.js --write -- apply
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const WRITE        = process.argv.includes('--write');
const PORT_WF_ID   = '7EaCbHmYLnzpaLPn';
const SEARATES_CRED = { id: 'OXJ4UVacMY1qofx6', name: 'Aaziko Brain - searates (ports)' };
const BACKUP_DIR   = path.resolve(__dirname, '../../../backups');

(async () => {
  console.log('=== Fix: find_port Find Ports credential ===');
  console.log('Problem: 9hyaSxc0saIzUgsX (aaziko_organized) cannot access searates-scraper DB');
  console.log('Fix: revert to OXJ4UVacMY1qofx6 (searates-specific, fixed on 11-19)\n');

  const wf = await getWf(PORT_WF_ID);
  const findNode = wf.nodes.find(n => n.name === 'Find Ports');
  if (!findNode) { console.log('❌ Find Ports node not found'); process.exit(1); }

  console.log('Current credential:', JSON.stringify(findNode.credentials && findNode.credentials.mongoDb));

  if (!WRITE) { console.log('\n(dry run — pass --write to apply)'); return; }

  const bk = path.join(BACKUP_DIR, PORT_WF_ID + '_before_port-cred-revert.json');
  fs.writeFileSync(bk, JSON.stringify(wf, null, 2), 'utf8');
  console.log('Backup:', bk);

  findNode.credentials = { mongoDb: SEARATES_CRED };

  const settings = Object.assign({}, wf.settings);
  delete settings.binaryMode;

  const r = await putWf(PORT_WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) {
    console.log('❌ PUT failed (' + r.status + '):', JSON.stringify(r.body).slice(0, 300));
    process.exit(1);
  }
  await activate(PORT_WF_ID);

  const check = await getWf(PORT_WF_ID);
  const live = check.nodes.find(n => n.name === 'Find Ports');
  const ok = live.credentials && live.credentials.mongoDb && live.credentials.mongoDb.id === SEARATES_CRED.id;
  console.log(ok ? '✅ Credential reverted to searates: ' + SEARATES_CRED.name : '❌ Revert failed');
  if (!ok) process.exit(1);
  console.log('\n✅ Now test: "JNPT port ki facilities kya hain?"');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
