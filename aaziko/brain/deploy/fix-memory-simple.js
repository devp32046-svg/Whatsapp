'use strict';
/* Replace Chat Memory node: memoryMongoDbChat → memoryBufferWindow
 *   Simple window memory — no credentials, no DB dependency.
 *   Works immediately; MongoDB-backed memory can be added back later
 *   once the credential/connection issue is diagnosed.
 *
 * node aaziko/brain/deploy/fix-memory-simple.js          -- dry run
 * node aaziko/brain/deploy/fix-memory-simple.js --write  -- patch + activate
 */
const path = require('path'), fs = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const SEC_DIR = path.resolve(__dirname, '..', '..', '.secrets');
const ids = JSON.parse(fs.readFileSync(path.join(SEC_DIR, 'brain-n8n.json'), 'utf8'));
const WRITE = process.argv.includes('--write');
const BRAIN_ID = ids.brainWfId;

(async () => {
  const wf = await getWf(BRAIN_ID);
  const memIdx = wf.nodes.findIndex(n => n.name === 'Chat Memory');
  if (memIdx === -1) { console.error('Chat Memory node not found!'); process.exit(1); }

  const before = wf.nodes[memIdx];
  console.log('BEFORE — type:', before.type, '| version:', before.typeVersion);

  if (!WRITE) {
    console.log('\nWould replace with memoryBufferWindow (contextWindowLength:6)');
    console.log('(dry run — pass --write to patch)');
    return;
  }

  const backupDir = path.resolve(__dirname, '..', '..', '..', 'backups');
  fs.writeFileSync(path.join(backupDir, BRAIN_ID + '_before_fix_memory_simple.json'), JSON.stringify(wf, null, 2));

  // Replace with simple window memory — no credentials needed
  wf.nodes[memIdx] = {
    id: before.id,
    name: 'Chat Memory',
    type: '@n8n/n8n-nodes-langchain.memoryBufferWindow',
    typeVersion: 1.2,
    position: before.position,
    parameters: { contextWindowLength: 6 },
    credentials: {}
  };

  await putWf(BRAIN_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings });
  await activate(BRAIN_ID);

  const live = await getWf(BRAIN_ID);
  const lMem = live.nodes.find(n => n.name === 'Chat Memory');
  console.log('LIVE — type:', lMem.type, '| version:', lMem.typeVersion, '| contextWindowLength:', lMem.parameters.contextWindowLength);
  console.log('Active:', live.active, '| nodes:', live.nodes.length);
  console.log('\n✅ Memory node replaced with simple buffer window');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
