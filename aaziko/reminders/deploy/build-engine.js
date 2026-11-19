'use strict';
/* Build WORKFLOW #2 — the fire-engine, on ai.cgpe.in. ISOLATED (Aaziko mongo cred only, no CGPE node).
 * Send is GATED by the config doc aaziko_reminders.config {_id:'engine'}: with sendEnabled:false (seeded)
 * the Decide node emits 0 items, so Claim/Send/Mark never run — the engine is a clean LIVE no-op every
 * minute. Go-live = set phoneNumberId/token + sendEnabled:true in that doc (no redeploy needed).
 *
 *   node aaziko/reminders/deploy/build-engine.js          # dry-run: print workflow, seed/create nothing
 *   node aaziko/reminders/deploy/build-engine.js --write    # seed config (sendEnabled:false) + create/update + activate
 *   node aaziko/reminders/deploy/build-engine.js --verify   # read recent executions to confirm it ticks + no-ops
 */
const path = require('path'), fs = require('fs');
const { req, HOST } = require('../../../scripts/lib/n8n-req');

const SEC_DIR = path.resolve(__dirname, '..', '..', '.secrets');
const IDS_FILE = path.join(SEC_DIR, 'reminders-n8n.json');
const ids = (() => { try { return JSON.parse(fs.readFileSync(IDS_FILE, 'utf8')); } catch (e) { return {}; } })();
const saveIds = () => fs.writeFileSync(IDS_FILE, JSON.stringify(ids, null, 2));
const CRED = 'Hxh39r3Fnn77hr55', CRED_NAME = 'Aaziko Reminders Mongo (aaziko_reminders ONLY)', CGPE_MONGO_CRED = 'WZ2iSk9j0aJMoLDk';

const { DECIDE, BUILD_MARK, BUILD_UI_ROW, BUILD_MARK_UI } = require('../lib/node-code'); // shipped Code-node strings (tested by selftest.js)

const mongo = (name, params, pos) => ({ id: name.replace(/\\W/g, '').slice(0, 8) + pos[0], name,
  type: 'n8n-nodes-base.mongoDb', typeVersion: 1.3, position: pos,
  parameters: params, credentials: { mongoDb: { id: CRED, name: CRED_NAME } } });

const wfPayload = () => ({
  name: 'Aaziko Reminders — Fire Engine',
  nodes: [
    { id: 'sch', name: 'Every 1 Minute', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.3, position: [0, 0],
      parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } } },
    mongo('Load Config', { collection: 'config', query: '{"key":"engine"}', options: { limit: 1 } }, [220, 0]),
    // limit 2000: Decide filters ALL loaded rows in code; only risk is truncation past the limit (ample for an internal tool).
    mongo('Find Active', { collection: 'reminders', query: '{"status":"active"}', options: { limit: 2000 } }, [440, 0]),
    { id: 'dec', name: 'Decide', type: 'n8n-nodes-base.code', typeVersion: 2, position: [660, 0],
      parameters: { jsCode: DECIDE } },
    mongo('Claim', { operation: 'findOneAndUpdate', collection: 'reminders', updateKey: '_id', fields: '={{ $json.__fields }}', options: {} }, [880, 0]),
    // route by channel — read from Decide (Claim replaced the item's fields)
    { id: 'rt', name: 'Route Channel', type: 'n8n-nodes-base.if', typeVersion: 2, position: [1080, 0],
      parameters: { conditions: { options: { caseSensitive: true, typeValidation: 'loose' }, combinator: 'and',
        conditions: [{ id: 'c1', leftValue: "={{ $('Decide').item.json.channel }}", rightValue: 'whatsapp', operator: { type: 'string', operation: 'equals' } }] } } },
    // --- WhatsApp branch (channel === 'whatsapp') ---
    { id: 'snd', name: 'Send', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4, position: [1300, -120],
      continueOnFail: true,
      parameters: { method: 'POST',
        url: "=https://graph.facebook.com/{{ $('Decide').item.json.graphVersion }}/{{ $('Decide').item.json.phoneNumberId }}/messages",
        sendHeaders: true, headerParameters: { parameters: [{ name: 'Authorization', value: "=Bearer {{ $('Decide').item.json.token }}" }] },
        sendBody: true, specifyBody: 'json',
        jsonBody: "={{ JSON.stringify({ messaging_product: 'whatsapp', to: $('Decide').item.json.recipientPhone, type: 'text', text: { body: String($('Decide').item.json.remText || '').slice(0, 1000) } }) }}",
        options: { batching: { batch: { batchSize: 1, batchInterval: 2000 } } } } },
    { id: 'bmk', name: 'Build Mark', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1520, -120],
      parameters: { mode: 'runOnceForEachItem', jsCode: BUILD_MARK } },
    // --- UI branch (channel === 'ui') — writes to ui_inbox, no number needed ---
    { id: 'uir', name: 'Build UI Row', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1300, 120],
      parameters: { mode: 'runOnceForEachItem', jsCode: BUILD_UI_ROW } },
    mongo('Deliver UI', { operation: 'insert', collection: 'ui_inbox', fields: 'reminderId,recipientPhone,text,channel,delivered,firedAt', options: {} }, [1520, 120]),
    { id: 'bmu', name: 'Build Mark UI', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1740, 120],
      parameters: { mode: 'runOnceForEachItem', jsCode: BUILD_MARK_UI } },
    mongo('Mark', { operation: 'findOneAndUpdate', collection: 'reminders', updateKey: '_id', fields: '={{ $json.__fields }}', options: {} }, [1960, 0]),
  ],
  connections: {
    'Every 1 Minute': { main: [[{ node: 'Load Config', type: 'main', index: 0 }]] },
    'Load Config': { main: [[{ node: 'Find Active', type: 'main', index: 0 }]] },
    'Find Active': { main: [[{ node: 'Decide', type: 'main', index: 0 }]] },
    'Decide': { main: [[{ node: 'Claim', type: 'main', index: 0 }]] },
    'Claim': { main: [[{ node: 'Route Channel', type: 'main', index: 0 }]] },
    'Route Channel': { main: [[{ node: 'Send', type: 'main', index: 0 }], [{ node: 'Build UI Row', type: 'main', index: 0 }]] },
    'Send': { main: [[{ node: 'Build Mark', type: 'main', index: 0 }]] },
    'Build Mark': { main: [[{ node: 'Mark', type: 'main', index: 0 }]] },
    'Build UI Row': { main: [[{ node: 'Deliver UI', type: 'main', index: 0 }]] },
    'Deliver UI': { main: [[{ node: 'Build Mark UI', type: 'main', index: 0 }]] },
    'Build Mark UI': { main: [[{ node: 'Mark', type: 'main', index: 0 }]] },
  },
  // frequent (1-min) workflow → don't save success execs (shared-DB bloat, CLAUDE.md §5); keep errors.
  settings: { saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all' },
});

function assertClean(wf) {
  const s = JSON.stringify(wf);
  if (s.includes(CGPE_MONGO_CRED)) throw new Error('ABORT: CGPE mongo cred leaked');
  const credIds = wf.nodes.flatMap(n => Object.values(n.credentials || {}).map(c => c.id));
  const bad = credIds.filter(id => id !== CRED);
  if (bad.length) throw new Error('ABORT: unexpected cred id(s): ' + bad.join(','));
}

async function seedConfig() {
  const { withDb } = require('../lib/db');
  await withDb(async (client, db) => {
    await db.collection('config').deleteOne({ _id: 'engine' }); // drop old string-_id doc (mongoDb node can't query _id:'engine')
    await db.collection('config').updateOne({ key: 'engine' },
      { $setOnInsert: { key: 'engine', sendEnabled: false, channel: 'ui', graphVersion: 'v21.0', phoneNumberId: '', token: '', createdAt: new Date().toISOString() } },
      { upsert: true });
    await db.collection('config').updateOne({ key: 'engine', channel: { $exists: false } }, { $set: { channel: 'ui' } }); // backfill channel on an older doc
    const doc = await db.collection('config').findOne({ key: 'engine' });
    console.log('config: sendEnabled=' + doc.sendEnabled + ' channel=' + (doc.channel || '(none)') + ' phoneNumberId=' + (doc.phoneNumberId || '(empty)'));
  });
}

(async () => {
  const mode = process.argv.includes('--write') ? 'write' : process.argv.includes('--verify') ? 'verify' : 'dry';

  if (mode === 'verify') {
    if (!ids.engineWfId) { console.log('no engineWfId yet'); return; }
    const r = await req('GET', '/api/v1/executions?workflowId=' + ids.engineWfId + '&includeData=true&limit=3');
    const j = JSON.parse(r.body); const rows = j.data || [];
    console.log('recent executions:', rows.length);
    for (const ex of rows) {
      const rd = (ex.data && ex.data.resultData && ex.data.resultData.runData) || {};
      const dec = rd['Decide'] && rd['Decide'][0];
      const fired = dec && dec.data && dec.data.main && dec.data.main[0] ? dec.data.main[0].length : '?';
      console.log('  exec ' + ex.id + ' | ' + ex.status + ' | startedAt ' + ex.startedAt + ' | Decide emitted ' + fired + ' (0 = clean no-op)');
    }
    return;
  }

  const wf = wfPayload(); assertClean(wf);
  if (mode === 'dry') {
    console.log('nodes:', wf.nodes.map(n => n.name).join(' -> '));
    console.log('\nDECIDE jsCode:\n' + DECIDE);
    console.log('\nDRY-RUN only. --write to seed config (sendEnabled:false) + deploy + activate.');
    return;
  }

  // --write
  await seedConfig();
  if (!ids.engineWfId) {
    const r = await req('POST', '/api/v1/workflows', wf);
    if (r.status >= 300) throw new Error('create -> ' + r.status + ' ' + r.body.slice(0, 400));
    ids.engineWfId = JSON.parse(r.body).id; saveIds();
    console.log('created fire-engine workflow:', ids.engineWfId);
  } else {
    const put = await req('PUT', '/api/v1/workflows/' + ids.engineWfId, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings });
    console.log('updated fire-engine ' + ids.engineWfId + ' -> ' + put.status + (put.status >= 300 ? ' ' + put.body.slice(0, 400) : ''));
    if (put.status >= 300) { const live = JSON.parse((await req('GET', '/api/v1/workflows/' + ids.engineWfId)).body); console.log('LIVE after non-2xx: active=' + live.active + ' nodes=' + live.nodes.length); }
  }
  const act = await req('POST', '/api/v1/workflows/' + ids.engineWfId + '/activate');
  console.log('activate -> ' + act.status);
  const live = JSON.parse((await req('GET', '/api/v1/workflows/' + ids.engineWfId)).body);
  assertClean(live);
  console.log('read-back clean: active=' + live.active + ' | nodes =', live.nodes.map(n => n.name).join(' -> '));
  console.log('\nDeployed. Delivery gated by config {key:engine}: channel (ui|whatsapp) + sendEnabled.');
  console.log('UI mode: node aaziko/reminders/deploy/set-meta.js --channel ui --enable  (then verify-tick.js / the UI page)');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
