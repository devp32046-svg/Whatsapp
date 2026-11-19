'use strict';
/* Fix Chat Memory node in Aaziko Brain:
 *   1. sessionIdType: 'customKey' → 'fromInput'  (sub-node can't resolve $('NodeName') expressions)
 *   2. credential: Reminders credential → aaziko_search credential
 *
 * node aaziko/brain/deploy/fix-memory-node.js          -- dry run
 * node aaziko/brain/deploy/fix-memory-node.js --write  -- patch + activate
 */
const path = require('path'), fs = require('fs');
const { req, getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const SEC_DIR = path.resolve(__dirname, '..', '..', '.secrets');
const ids = JSON.parse(fs.readFileSync(path.join(SEC_DIR, 'brain-n8n.json'), 'utf8'));
const WRITE = process.argv.includes('--write');

const BRAIN_ID     = ids.brainWfId;   // w7no6uCJkz7lfaah
const CRED_SEARCH  = { id: 'BBaiP3Y5ede0zxY6', name: 'Aaziko Brain - aaziko_search (config+logs)' };

(async () => {
  const wf = await getWf(BRAIN_ID);
  const memIdx = wf.nodes.findIndex(n => n.name === 'Chat Memory');
  if (memIdx === -1) { console.error('Chat Memory node not found!'); process.exit(1); }

  const before = JSON.parse(JSON.stringify(wf.nodes[memIdx]));
  console.log('BEFORE — sessionIdType:', before.parameters.sessionIdType,
              '| sessionKey:', before.parameters.sessionKey,
              '| credential:', before.credentials?.mongoDb?.name);

  if (!WRITE) {
    console.log('\nWould change:');
    console.log('  sessionIdType: customKey → fromInput');
    console.log('  remove sessionKey parameter');
    console.log('  credential →', CRED_SEARCH.name);
    console.log('\n(dry run — pass --write to patch)');
    return;
  }

  // Backup
  const backupDir = path.resolve(__dirname, '..', '..', '..', 'backups');
  fs.writeFileSync(path.join(backupDir, BRAIN_ID + '_before_fix_memory.json'), JSON.stringify(wf, null, 2));
  console.log('Backup saved');

  // Patch memory node
  wf.nodes[memIdx].parameters = {
    notice: '',
    sessionIdType: 'fromInput',
    collectionName: 'az_chat_memory',
    contextWindowLength: 6
  };
  wf.nodes[memIdx].credentials = { mongoDb: CRED_SEARCH };

  console.log('AFTER  — sessionIdType: fromInput | credential:', CRED_SEARCH.name);

  // PUT
  await putWf(BRAIN_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings });
  await activate(BRAIN_ID);

  // Read back
  const live = await getWf(BRAIN_ID);
  const lMem = live.nodes.find(n => n.name === 'Chat Memory');
  console.log('LIVE   — sessionIdType:', lMem.parameters.sessionIdType,
              '| credential:', lMem.credentials?.mongoDb?.name);
  console.log('Active:', live.active, '| nodes:', live.nodes.length);
  console.log('\n✅ Chat Memory node patched');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
