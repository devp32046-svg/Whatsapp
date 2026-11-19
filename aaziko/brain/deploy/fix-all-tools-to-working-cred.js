'use strict';
/* Switch all 6 Aaziko tool sub-workflows to the working credential:
 *   "Aaziko Trade DB (all DBs)"  id: Ms2XatAbnJ799nGw
 *   (confirmed working via n8n UI — connects to 100.70.212.45, all DBs)
 *
 * node aaziko/brain/deploy/fix-all-tools-to-working-cred.js          -- dry run
 * node aaziko/brain/deploy/fix-all-tools-to-working-cred.js --write  -- apply
 */
const path = require('path'), fs = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const SEC_DIR = path.resolve(__dirname, '..', '..', '.secrets');
const ids = JSON.parse(fs.readFileSync(path.join(SEC_DIR, 'brain-n8n.json'), 'utf8'));
const WRITE = process.argv.includes('--write');
const BACKUP_DIR = path.resolve(__dirname, '..', '..', '..', 'backups');

// The ONE working credential — confirmed connected in n8n UI 2026-11-19
const WORKING_CRED = { id: 'Ms2XatAbnJ799nGw', name: 'Aaziko Trade DB (all DBs)' };

const TOOLS = [
  { wfId: ids.tariffWfId,     label: 'search_tariff'   },
  { wfId: ids.productWfId,    label: 'search_products' },
  { wfId: ids.portWfId,       label: 'find_port'       },
  { wfId: ids.complianceWfId, label: 'get_compliance'  },
  { wfId: ids.hsLookupWfId,   label: 'lookup_hs_code'  },
  { wfId: ids.buyersWfId,     label: 'find_buyers'     },
];

async function fixWf({ wfId, label }) {
  const wf = await getWf(wfId);
  const mongoNodes = wf.nodes.filter(n => n.type && n.type.includes('mongoDb'));

  if (!mongoNodes.length) {
    console.log(label + ' (' + wfId + '): no mongoDb node — skip');
    return;
  }

  const before = mongoNodes.map(n =>
    (n.credentials && n.credentials.mongoDb && n.credentials.mongoDb.name) || 'none'
  ).join(', ');

  console.log(label + ' (' + wfId + '): ' + mongoNodes.length + ' node(s), cred before: ' + before);

  if (!WRITE) return;

  fs.writeFileSync(
    path.join(BACKUP_DIR, wfId + '_before_working_cred.json'),
    JSON.stringify(wf, null, 2)
  );

  mongoNodes.forEach(n => {
    n.credentials = { mongoDb: WORKING_CRED };
  });

  await putWf(wfId, {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: wf.settings
  });
  await activate(wfId);

  // Verify
  const live = await getWf(wfId);
  const lNodes = live.nodes.filter(n => n.type && n.type.includes('mongoDb'));
  const ok = lNodes.every(n =>
    n.credentials && n.credentials.mongoDb && n.credentials.mongoDb.id === WORKING_CRED.id
  );
  const after = lNodes.map(n =>
    (n.credentials && n.credentials.mongoDb && n.credentials.mongoDb.name) || 'none'
  ).join(', ');
  console.log('  → ' + after + ' ' + (ok ? '✅' : '❌'));
}

(async () => {
  console.log('=== FIX ALL TOOLS → WORKING CRED (dry:' + !WRITE + ') ===\n');
  console.log('Target cred: "' + WORKING_CRED.name + '" id:' + WORKING_CRED.id + '\n');

  for (const tool of TOOLS) {
    await fixWf(tool);
  }

  if (!WRITE) {
    console.log('\n(pass --write to apply)');
  } else {
    console.log('\n✅ All tool credentials updated — test a query now');
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
