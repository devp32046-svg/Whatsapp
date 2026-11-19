'use strict';
/* ROOT CAUSE FIX: All tool sub-workflows were using Hxh39r3Fnn77hr55
 * (aaziko_reminders ONLY) → every query returned empty.
 * Dedicated per-DB credentials already exist — this script wires them correctly.
 *
 *  wits (tariff)         → wh4qdyGdVZCVuW1O
 *  indiamart (products)  → g9NnHH7ocvb52kdM
 *  searates (ports)      → OXJ4UVacMY1qofx6
 *  aaziko_organized      → 9hyaSxc0saIzUgsX  (compliance + hs_lookup)
 *  Dhruval (buyers)      → OfzytI6wqCHPzKBG  (All DBs shared)
 *
 * node aaziko/brain/deploy/fix-tool-credentials.js          -- dry run
 * node aaziko/brain/deploy/fix-tool-credentials.js --write  -- apply
 */
const path = require('path'), fs = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const SEC_DIR = path.resolve(__dirname, '..', '..', '.secrets');
const ids = JSON.parse(fs.readFileSync(path.join(SEC_DIR, 'brain-n8n.json'), 'utf8'));
const WRITE = process.argv.includes('--write');
const BACKUP_DIR = path.resolve(__dirname, '..', '..', '..', 'backups');

const CRED_MAP = {
  tariff:     { id: 'wh4qdyGdVZCVuW1O', name: 'Aaziko Brain - wits (tariff)' },
  products:   { id: 'g9NnHH7ocvb52kdM', name: 'Aaziko Brain - indiamart (products)' },
  ports:      { id: 'OXJ4UVacMY1qofx6', name: 'Aaziko Brain - searates (ports)' },
  organized:  { id: '9hyaSxc0saIzUgsX', name: 'Aaziko Brain - organized (compliance)' },
  buyers:     { id: 'OfzytI6wqCHPzKBG', name: 'Aaziko Brain - All DBs (shared)' },
};

async function fixWfCredential(wfId, credObj, label) {
  const wf = await getWf(wfId);
  const mongoNodes = wf.nodes.filter(n => n.type.includes('mongoDb'));
  if (!mongoNodes.length) { console.log(label + ': no mongoDb node — skip'); return; }

  const before = mongoNodes.map(n => n.credentials && n.credentials.mongoDb && n.credentials.mongoDb.name).join(', ');
  console.log(label + ': ' + mongoNodes.length + ' node(s), cred before: ' + before);

  if (!WRITE) return;

  fs.writeFileSync(path.join(BACKUP_DIR, wfId + '_before_cred_fix.json'), JSON.stringify(wf, null, 2));

  mongoNodes.forEach(n => {
    n.credentials = { mongoDb: credObj };
  });

  await putWf(wfId, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings });
  await activate(wfId);

  // Verify
  const live = await getWf(wfId);
  const lMongo = live.nodes.filter(n => n.type.includes('mongoDb'));
  const after = lMongo.map(n => n.credentials && n.credentials.mongoDb && n.credentials.mongoDb.name).join(', ');
  const ok = lMongo.every(n => n.credentials && n.credentials.mongoDb && n.credentials.mongoDb.id === credObj.id);
  console.log('  → after: ' + after, ok ? '✅' : '❌');
}

(async () => {
  console.log('=== CREDENTIAL FIX (dry run: ' + !WRITE + ') ===\n');

  await fixWfCredential(ids.tariffWfId,     CRED_MAP.tariff,    'search_tariff');
  await fixWfCredential(ids.productWfId,    CRED_MAP.products,  'search_products');
  await fixWfCredential(ids.portWfId,       CRED_MAP.ports,     'find_port');
  await fixWfCredential(ids.complianceWfId, CRED_MAP.organized, 'get_compliance');
  await fixWfCredential(ids.hsLookupWfId,   CRED_MAP.organized, 'lookup_hs_code');
  await fixWfCredential(ids.buyersWfId,     CRED_MAP.buyers,    'find_buyers');

  if (!WRITE) {
    console.log('\n(pass --write to apply)');
  } else {
    console.log('\n✅ All tool credentials fixed');
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
