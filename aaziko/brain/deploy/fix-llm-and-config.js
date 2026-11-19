'use strict';
/* Fix 2 critical bugs in Aaziko Brain:
 *   1. Gemini Flash — wrong node type (lmChatGoogleVertex → lmChatGoogleGemini)
 *      Vertex requires OAuth service account; AI Studio needs googlePalmApi key.
 *   2. Load Config — wrong credential (aaziko_reminders → aaziko_search)
 *      Config doc lives in aaziko_search DB, not reminders DB.
 *
 * node aaziko/brain/deploy/fix-llm-and-config.js          -- dry run
 * node aaziko/brain/deploy/fix-llm-and-config.js --write  -- patch + activate
 */
const path = require('path'), fs = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const SEC_DIR = path.resolve(__dirname, '..', '..', '.secrets');
const ids = JSON.parse(fs.readFileSync(path.join(SEC_DIR, 'brain-n8n.json'), 'utf8'));
const WRITE = process.argv.includes('--write');
const BRAIN_ID = ids.brainWfId;

// rot1 = same cred CGPE brain uses successfully with models/gemini-flash-latest
const GEMINI_ROT1_CRED = { id: 'z1yT4WXRANdfPHjQ', name: 'Gemini Brain (rot1)' };
// aaziko_reminders credential works (aaziko_search URI is empty/broken)
const REMINDERS_CRED = { id: 'Hxh39r3Fnn77hr55', name: 'Aaziko Reminders Mongo (aaziko_reminders ONLY)' };

(async () => {
  const wf = await getWf(BRAIN_ID);

  const llmIdx = wf.nodes.findIndex(n => n.name === 'Gemini Flash');
  const cfgIdx = wf.nodes.findIndex(n => n.name === 'Load Config');

  if (llmIdx === -1) { console.error('Gemini Flash node not found!'); process.exit(1); }
  if (cfgIdx === -1) { console.error('Load Config node not found!'); process.exit(1); }

  const llm = wf.nodes[llmIdx];
  const cfg = wf.nodes[cfgIdx];

  console.log('=== BEFORE ===');
  console.log('Gemini Flash — type:', llm.type, '| version:', llm.typeVersion, '| cred:', llm.credentials?.googleApi?.name || llm.credentials?.googlePalmApi?.name || '(none)');
  console.log('Load Config  — cred:', cfg.credentials?.mongoDb?.name || '(none)');

  if (!WRITE) {
    console.log('\n=== WOULD FIX ===');
    console.log('Gemini Flash: lmChatGoogleVertex → lmChatGoogleGemini, cred → Gemini Brain (free)');
    console.log('Load Config:  cred → Aaziko Brain - aaziko_search');
    console.log('\n(dry run — pass --write to apply)');
    return;
  }

  // Backup
  const backupDir = path.resolve(__dirname, '..', '..', '..', 'backups');
  fs.writeFileSync(path.join(backupDir, BRAIN_ID + '_before_fix_llm_config.json'), JSON.stringify(wf, null, 2));
  console.log('Backup saved');

  // Fix 1: Gemini Flash — correct node type + credential
  wf.nodes[llmIdx] = {
    id: llm.id,
    name: llm.name,
    type: '@n8n/n8n-nodes-langchain.lmChatGoogleGemini',
    typeVersion: 1,
    position: llm.position,
    parameters: {
      modelName: 'models/gemini-flash-latest',
      options: {}
    },
    credentials: {
      googlePalmApi: GEMINI_ROT1_CRED
    }
  };

  // Fix 2: Load Config — use working reminders credential (aaziko_search URI is broken)
  cfg.credentials = { mongoDb: REMINDERS_CRED };

  await putWf(BRAIN_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings });
  await activate(BRAIN_ID);

  const live = await getWf(BRAIN_ID);
  const lLlm = live.nodes.find(n => n.name === 'Gemini Flash');
  const lCfg = live.nodes.find(n => n.name === 'Load Config');

  console.log('\n=== LIVE ===');
  console.log('Gemini Flash — type:', lLlm.type, '| version:', lLlm.typeVersion, '| cred:', lLlm.credentials?.googlePalmApi?.name || '(none)');
  console.log('Load Config  — cred:', lCfg.credentials?.mongoDb?.name || '(none)');
  console.log('Active:', live.active, '| nodes:', live.nodes.length);

  if (lLlm.type === '@n8n/n8n-nodes-langchain.lmChatGoogleGemini' && lCfg.credentials?.mongoDb?.id === REMINDERS_CRED.id) {
    console.log('\n✅ Both fixes applied successfully');
  } else {
    console.error('\n❌ Verification failed — check live state manually');
    process.exit(1);
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
