'use strict';
/*
 * Revert all 6 Aaziko tool sub-workflows from httpRequest → original mongoDb nodes.
 * Uses backups/_before_proxy_wire.json created by wire-tools-to-proxy.js.
 *
 * node aaziko/brain/deploy/revert-to-mongodb-nodes.js          -- dry run
 * node aaziko/brain/deploy/revert-to-mongodb-nodes.js --write  -- apply
 */
const path = require('path'), fs = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const BACKUP_DIR = path.resolve(__dirname, '..', '..', '..', 'backups');
const WRITE = process.argv.includes('--write');

const TOOLS = [
  { id: 'k71O78yLV0v0TXZl', label: 'search_tariff' },
  { id: 'IdQQ66Ugw7eJIqax', label: 'search_products' },
  { id: '7EaCbHmYLnzpaLPn', label: 'find_port' },
  { id: '3qY2tab3Pnt6FmPD', label: 'get_compliance' },
  { id: 'OqZH3AoC6yy8UIbz', label: 'lookup_hs_code' },
  { id: 'WPAowCu3eKOHz4Yr', label: 'find_buyers' },
];

async function revertTool(tool) {
  const backupFile = path.join(BACKUP_DIR, tool.id + '_before_proxy_wire.json');
  if (!fs.existsSync(backupFile)) {
    console.log(tool.label + ': backup MISSING — skip');
    return;
  }

  const backup = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
  const mongoNode = backup.nodes.find(n => n.type && n.type.includes('mongoDb'));
  if (!mongoNode) {
    console.log(tool.label + ': no mongoDb node in backup — skip');
    return;
  }

  const live = await getWf(tool.id);
  const httpIdx = live.nodes.findIndex(n => n.type && n.type.includes('httpRequest'));
  const alreadyMongo = live.nodes.some(n => n.type && n.type.includes('mongoDb'));

  if (alreadyMongo) {
    console.log(tool.label + ': already using mongoDb — skip ✅');
    return;
  }

  console.log(tool.label + ' (' + tool.id + '): httpRequest → mongoDb');
  console.log('  DB:', mongoNode.parameters.databaseName, '| coll:', mongoNode.parameters.collection);

  if (!WRITE) return;

  live.nodes[httpIdx] = mongoNode;
  await putWf(tool.id, { name: live.name, nodes: live.nodes, connections: live.connections, settings: live.settings });
  await activate(tool.id);

  const check = await getWf(tool.id);
  const hasMongo = check.nodes.some(n => n.type && n.type.includes('mongoDb'));
  const hasHttp  = check.nodes.some(n => n.type && n.type.includes('httpRequest'));
  console.log('  → mongoDb:', hasMongo, '| httpRequest gone:', !hasHttp, hasMongo && !hasHttp ? '✅' : '❌');
}

(async () => {
  console.log('=== REVERT TO MONGODB NODES (dry:' + !WRITE + ') ===\n');
  for (const tool of TOOLS) await revertTool(tool);
  if (!WRITE) console.log('\n(pass --write to apply)');
  else console.log('\n✅ All tools reverted — test a query on Aaziko UI');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
