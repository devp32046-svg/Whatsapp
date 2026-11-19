'use strict';
/* Build WORKFLOW #1 — create-reminder webhook, on ai.cgpe.in. ISOLATED: uses only the Aaziko mongo
 * cred (Hxh39r3Fnn77hr55), touches no CGPE node. No Meta, no sending — it only inserts reminders.
 *
 *   node aaziko/reminders/deploy/build-create.js            # dry-run: print the workflow, create nothing
 *   node aaziko/reminders/deploy/build-create.js --write     # create/update + activate + read-back assert
 *   node aaziko/reminders/deploy/build-create.js --smoke     # POST a test reminder to the live webhook, then clean it
 *
 * Contract: POST { text, recipientPhone (digits, E.164 w/o +), nextFireAt (IST wall "YYYY-MM-DD HH:mm"),
 *                  setBy?, source?, secret } . nextFireAt with a Z/+ is REJECTED (store-UTC convention).
 */
const path = require('path'), fs = require('fs'), https = require('https'), crypto = require('crypto');
const { req, HOST } = require('../../../scripts/lib/n8n-req');
const L = require('../lib/fire-logic');

const SEC_DIR = path.resolve(__dirname, '..', '..', '.secrets');
const ENV = path.join(SEC_DIR, 'reminders.env');
function loadEnv() { try { fs.readFileSync(ENV, 'utf8').split(/\r?\n/).forEach(l => { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2]; }); } catch (e) {} }
loadEnv();
// ensure a create-webhook shared secret exists (generate + persist once)
if (!process.env.REMINDERS_CREATE_SECRET) {
  const s = crypto.randomBytes(16).toString('hex');
  fs.appendFileSync(ENV, '\nREMINDERS_CREATE_SECRET=' + s + '\n');
  process.env.REMINDERS_CREATE_SECRET = s;
  console.log('generated REMINDERS_CREATE_SECRET and saved to aaziko/.secrets/reminders.env');
}
const SECRET = process.env.REMINDERS_CREATE_SECRET;
const CRED = 'Hxh39r3Fnn77hr55', CGPE_MONGO_CRED = 'WZ2iSk9j0aJMoLDk';
const WEBHOOK_PATH = 'aaziko-reminder-create';

const IDS_FILE = path.join(SEC_DIR, 'reminders-n8n.json');
const ids = (() => { try { return JSON.parse(fs.readFileSync(IDS_FILE, 'utf8')); } catch (e) { return {}; } })();
const saveIds = () => fs.writeFileSync(IDS_FILE, JSON.stringify(ids, null, 2));

const BUILD_DOC = require('../lib/node-code').buildDoc(SECRET); // shipped Code-node string (tested by selftest.js)

const wfPayload = () => ({
  name: 'Aaziko Reminders — Create (webhook)',
  nodes: [
    { id: 'wh', name: 'Create Hook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0],
      parameters: { httpMethod: 'POST', path: WEBHOOK_PATH, responseMode: 'responseNode', options: {} } },
    { id: 'bd', name: 'Build Doc', type: 'n8n-nodes-base.code', typeVersion: 2, position: [240, 0],
      parameters: { jsCode: BUILD_DOC } },
    { id: 'rt', name: 'Route', type: 'n8n-nodes-base.if', typeVersion: 2, position: [480, 0],
      parameters: { conditions: { options: { caseSensitive: true, typeValidation: 'loose' }, combinator: 'and',
        conditions: [{ id: 'c1', leftValue: '={{ $json._ok }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }] } } },
    { id: 'ins', name: 'Insert Reminder', type: 'n8n-nodes-base.mongoDb', typeVersion: 1.3, position: [720, -80],
      parameters: { operation: 'insert', collection: 'reminders',
        fields: 'text,recipientPhone,setBy,source,nextFireAtIST,nextFireAt,status,firedAt,wamid,createdAt', options: {} },
      credentials: { mongoDb: { id: CRED, name: 'Aaziko Reminders Mongo (aaziko_reminders ONLY)' } } },
    { id: 'rok', name: 'Respond OK', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1, position: [960, -80],
      parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify({ ok: true, reminder: $(\'Build Doc\').item.json }) }}', options: {} } },
    { id: 'rerr', name: 'Respond Err', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1, position: [720, 140],
      parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify({ ok: false, error: $json._error, code: $json._code }) }}', options: { responseCode: 400 } } },
  ],
  connections: {
    'Create Hook': { main: [[{ node: 'Build Doc', type: 'main', index: 0 }]] },
    'Build Doc': { main: [[{ node: 'Route', type: 'main', index: 0 }]] },
    'Route': { main: [[{ node: 'Insert Reminder', type: 'main', index: 0 }], [{ node: 'Respond Err', type: 'main', index: 0 }]] },
    'Insert Reminder': { main: [[{ node: 'Respond OK', type: 'main', index: 0 }]] },
  },
  settings: { saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all' },
});

function assertClean(wf) {
  const s = JSON.stringify(wf);
  if (s.includes(CGPE_MONGO_CRED)) throw new Error('ABORT: CGPE mongo cred leaked');
  const credIds = wf.nodes.flatMap(n => Object.values(n.credentials || {}).map(c => c.id));
  const bad = credIds.filter(id => id !== CRED);
  if (bad.length) throw new Error('ABORT: unexpected cred id(s): ' + bad.join(','));
}

function istNowPlus(min) {
  const p = L.istParts(Date.now() + min * 60000); const z = n => String(n).padStart(2, '0');
  return p.y + '-' + z(p.mo) + '-' + z(p.d) + ' ' + z(p.hour) + ':' + z(p.min);
}
function post(body) {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((res, rej) => {
    const r = https.request({ hostname: HOST, path: '/webhook/' + WEBHOOK_PATH, method: 'POST', timeout: 30000,
      headers: { 'content-type': 'application/json', 'content-length': data.length } },
      x => { const c = []; x.on('data', d => c.push(d)); x.on('end', () => res({ status: x.statusCode, body: Buffer.concat(c).toString('utf8') })); });
    r.on('error', rej); r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); });
    r.write(data); r.end();
  });
}

(async () => {
  const mode = process.argv.includes('--write') ? 'write' : process.argv.includes('--smoke') ? 'smoke' : 'dry';

  if (mode === 'smoke') {
    const { withDb, COLL } = require('../lib/db');
    const ist = istNowPlus(5);
    const ok = await post({ text: 'WEBHOOK SELF-TEST (delete me)', recipientPhone: '910000000000', nextFireAt: ist, source: 'webhook-selftest', secret: SECRET });
    console.log('valid secret -> ' + ok.status + '  ' + ok.body.slice(0, 160));
    const bad = await post({ text: 'WRONG-SECRET TEST', recipientPhone: '910000000000', nextFireAt: ist, source: 'webhook-selftest', secret: 'definitely-wrong' });
    console.log('wrong secret -> ' + bad.status + '  ' + bad.body.slice(0, 160));
    const badData = await post({ text: 'BAD-DATA TEST', recipientPhone: '12', nextFireAt: ist, source: 'webhook-selftest', secret: SECRET });
    console.log('bad data     -> ' + badData.status + '  ' + badData.body.slice(0, 160));
    await withDb(async (client, db) => {
      const found = await db.collection(COLL).find({ source: 'webhook-selftest' }).toArray();
      const okDoc = found.find(d => d.text === 'WEBHOOK SELF-TEST (delete me)');
      const badDoc = found.find(d => d.text === 'WRONG-SECRET TEST');
      const badDataDoc = found.find(d => d.text === 'BAD-DATA TEST');
      console.log('read back:', found.length, 'doc(s) |', okDoc ? ('valid stored IST ' + okDoc.nextFireAtIST + ' -> UTC ' + okDoc.nextFireAt) : 'valid MISSING');
      const pass = ok.status === 200 && !!okDoc && bad.status !== 200 && !badDoc && badData.status !== 200 && !badDataDoc;
      console.log(pass ? '✅ PASS — valid inserted (200); wrong-secret & bad-data both rejected (non-200), neither inserted' : '❌ FAIL — ' + JSON.stringify({ okStatus: ok.status, okDoc: !!okDoc, badStatus: bad.status, badDoc: !!badDoc, badDataStatus: badData.status, badDataDoc: !!badDataDoc }));
      const del = await db.collection(COLL).deleteMany({ source: 'webhook-selftest' });
      console.log('cleaned', del.deletedCount, '| selftest left:', await db.collection(COLL).countDocuments({ source: 'webhook-selftest' }));
    });
    return;
  }

  const wf = wfPayload(); assertClean(wf);
  console.log('secret (keep private):', SECRET.slice(0, 6) + '… (full in reminders.env)');
  if (mode === 'dry') {
    console.log('WORKFLOW:', JSON.stringify(wf, null, 1));
    console.log('\nDRY-RUN only. --write to deploy, then --smoke to test.');
    return;
  }

  // --write: create or update
  if (!ids.createWfId) {
    const r = await req('POST', '/api/v1/workflows', wf);
    if (r.status >= 300) throw new Error('create -> ' + r.status + ' ' + r.body.slice(0, 300));
    ids.createWfId = JSON.parse(r.body).id; saveIds();
    console.log('created create-workflow:', ids.createWfId);
  } else {
    const put = await req('PUT', '/api/v1/workflows/' + ids.createWfId, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings });
    console.log('updated create-workflow ' + ids.createWfId + ' -> ' + put.status + (put.status >= 300 ? ' ' + put.body.slice(0, 300) : ''));
  }
  const act = await req('POST', '/api/v1/workflows/' + ids.createWfId + '/activate');
  console.log('activate -> ' + act.status);
  const live = JSON.parse((await req('GET', '/api/v1/workflows/' + ids.createWfId)).body);
  assertClean(live);
  console.log('read-back clean: nodes =', live.nodes.map(n => n.name).join(' -> '));
  console.log('webhook: https://' + HOST + '/webhook/' + WEBHOOK_PATH);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
