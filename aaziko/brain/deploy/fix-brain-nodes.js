'use strict';
/* Fix 2 nodes in Aaziko Brain:
 *   1. Chat Memory — add databaseName: 'aaziko_search' back (removed in prior patch)
 *   2. Gemini Flash — model gemini-2.0-flash-exp → gemini-1.5-flash
 *
 * node aaziko/brain/deploy/fix-brain-nodes.js          -- dry run
 * node aaziko/brain/deploy/fix-brain-nodes.js --write  -- patch + activate
 */
const path = require('path'), fs = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const SEC_DIR = path.resolve(__dirname, '..', '..', '.secrets');
const ids = JSON.parse(fs.readFileSync(path.join(SEC_DIR, 'brain-n8n.json'), 'utf8'));
const WRITE = process.argv.includes('--write');
const BRAIN_ID = ids.brainWfId;

(async () => {
  const wf = await getWf(BRAIN_ID);

  const memNode = wf.nodes.find(n => n.name === 'Chat Memory');
  const llmNode = wf.nodes.find(n => n.name === 'Gemini Flash');

  console.log('Chat Memory — databaseName:', memNode.parameters.databaseName, '| sessionIdType:', memNode.parameters.sessionIdType);
  console.log('Gemini Flash — modelName:', llmNode.parameters.modelName);

  if (!WRITE) {
    console.log('\nWould change:');
    console.log('  Chat Memory.databaseName: (empty) → aaziko_search');
    console.log('  Gemini Flash.modelName:', llmNode.parameters.modelName, '→ gemini-1.5-flash');
    console.log('\n(dry run — pass --write to patch)');
    return;
  }

  // Backup
  const backupDir = path.resolve(__dirname, '..', '..', '..', 'backups');
  fs.writeFileSync(path.join(backupDir, BRAIN_ID + '_before_fix_nodes2.json'), JSON.stringify(wf, null, 2));

  // Fix 1: Chat Memory — add databaseName
  memNode.parameters.databaseName = 'aaziko_search';

  // Fix 2: Gemini Flash — change model
  llmNode.parameters.modelName = 'gemini-1.5-flash';

  await putWf(BRAIN_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings });
  await activate(BRAIN_ID);

  const live = await getWf(BRAIN_ID);
  const lMem = live.nodes.find(n => n.name === 'Chat Memory');
  const lLlm = live.nodes.find(n => n.name === 'Gemini Flash');
  console.log('LIVE Chat Memory — databaseName:', lMem.parameters.databaseName);
  console.log('LIVE Gemini Flash — modelName:', lLlm.parameters.modelName);
  console.log('Active:', live.active, '| nodes:', live.nodes.length);
  console.log('\n✅ Both nodes patched');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
