'use strict';
/* Aaziko Reminder Engine — STEP 0: prove that ai.cgpe.in's n8n can reach the Aaziko Mongo
 * (100.70.212.45, a tailnet IP). Deploys a tiny ISOLATED test: a brand-new Aaziko Mongo credential
 * (database forced to aaziko_reminders) + a 2-node workflow [Webhook POST] -> [mongoDb find], then
 * hits the webhook. 200 with an array = reachable; a 500/timeout = NOT reachable (go back to Ved:
 * fallback is Aaziko's local n8n).
 *
 * Touches ZERO existing CGPE nodes/workflows/credentials. Uses only the new cred it creates.
 *
 *   node aaziko/reminders/deploy/reachability-test.js            # dry-run: print plan, create nothing
 *   node aaziko/reminders/deploy/reachability-test.js --write    # create + activate + hit the webhook
 *   node aaziko/reminders/deploy/reachability-test.js --cleanup  # delete the test workflow (keeps cred)
 */
const path = require('path'), fs = require('fs'), https = require('https');
const { req, HOST } = require('../../../scripts/lib/n8n-req');

// load Aaziko reminder secrets (git-ignored)
const SEC_DIR = path.resolve(__dirname, '..', '..', '.secrets');
const ENV = path.join(SEC_DIR, 'reminders.env');
try { fs.readFileSync(ENV, 'utf8').split(/\r?\n/).forEach(l => { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }); } catch (e) {}
const URI = process.env.REMINDERS_MONGO_URI;
if (!URI) { console.error('REMINDERS_MONGO_URI missing in aaziko/.secrets/reminders.env'); process.exit(1); }

const IDS_FILE = path.join(SEC_DIR, 'reminders-n8n.json');
const ids = (() => { try { return JSON.parse(fs.readFileSync(IDS_FILE, 'utf8')); } catch (e) { return {}; } })();
const saveIds = () => fs.writeFileSync(IDS_FILE, JSON.stringify(ids, null, 2));

const CGPE_MONGO_CRED = 'WZ2iSk9j0aJMoLDk'; // CGPE's cred — must NEVER appear in what we build
const WEBHOOK_PATH = 'aaziko-reminders-reach-test';
const redact = s => String(s).replace(/:\/\/([^:]+):([^@]+)@/, '://$1:****@');

const credPayload = {
  name: 'Aaziko Reminders Mongo (aaziko_reminders ONLY)',
  type: 'mongoDb',
  data: { configurationType: 'connectionString', connectionString: URI, database: 'aaziko_reminders' },
};
const wfPayload = credId => ({
  name: 'Aaziko Reminders — REACHABILITY TEST (safe to delete)',
  nodes: [
    { id: 'wh', name: 'Test Hook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0],
      parameters: { httpMethod: 'POST', path: WEBHOOK_PATH, responseMode: 'lastNode', options: {} } },
    { id: 'mg', name: 'Reach Mongo', type: 'n8n-nodes-base.mongoDb', typeVersion: 1.3, position: [260, 0],
      parameters: { collection: 'reminders', query: '{}', options: { limit: 1 } },
      credentials: { mongoDb: { id: credId, name: credPayload.name } } },
  ],
  connections: { 'Test Hook': { main: [[{ node: 'Reach Mongo', type: 'main', index: 0 }]] } },
  settings: { saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all' },
});

function assertClean(wf, credId) {
  const s = JSON.stringify(wf);
  if (s.includes(CGPE_MONGO_CRED)) throw new Error('ABORT: CGPE mongo cred id leaked into the workflow');
  const credIds = wf.nodes.flatMap(n => Object.values(n.credentials || {}).map(c => c.id));
  const bad = credIds.filter(id => id !== credId);
  if (bad.length) throw new Error('ABORT: unexpected credential id(s): ' + bad.join(','));
  console.log('   clean: only cred ' + credId + ', no CGPE refs. cred-ids in wf =', JSON.stringify(credIds));
}

function hitWebhook() {
  const body = Buffer.from(JSON.stringify({ probe: true }), 'utf8');
  return new Promise((res, rej) => {
    const r = https.request({ hostname: HOST, path: '/webhook/' + WEBHOOK_PATH, method: 'POST', timeout: 30000,
      headers: { 'content-type': 'application/json', 'content-length': body.length } },
      x => { const c = []; x.on('data', d => c.push(d)); x.on('end', () => res({ status: x.statusCode, body: Buffer.concat(c).toString('utf8') })); });
    r.on('error', rej); r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); });
    r.write(body); r.end();
  });
}

(async () => {
  const mode = process.argv.includes('--write') ? 'write' : process.argv.includes('--cleanup') ? 'cleanup' : 'dry';

  if (mode === 'cleanup') {
    if (!ids.testWfId) { console.log('no testWfId saved — nothing to clean'); return; }
    const r = await req('DELETE', '/api/v1/workflows/' + ids.testWfId);
    console.log('delete test wf ' + ids.testWfId + ' -> ' + r.status);
    delete ids.testWfId; saveIds();
    return;
  }

  console.log('host:', HOST, '| mongo:', redact(URI), '| db forced: aaziko_reminders');
  console.log('\nCREDENTIAL to create:', JSON.stringify({ ...credPayload, data: { ...credPayload.data, connectionString: redact(URI) } }, null, 1));

  if (mode === 'dry') {
    const wf = wfPayload(ids.mongoCredId || '<new-cred-id>');
    console.log('\nWORKFLOW to create:', JSON.stringify(wf, null, 1));
    try { assertClean(wf, ids.mongoCredId || '<new-cred-id>'); } catch (e) { console.log('   (clean-check deferred — cred id not created yet in dry-run)'); }
    console.log('\nDRY-RUN only. Re-run with --write to create + activate + hit the webhook.');
    return;
  }

  // --write
  if (!ids.mongoCredId) {
    const r = await req('POST', '/api/v1/credentials', credPayload);
    if (r.status >= 300) throw new Error('credential create -> ' + r.status + ' ' + r.body.slice(0, 300));
    ids.mongoCredId = JSON.parse(r.body).id; saveIds();
    console.log('created Aaziko Mongo credential:', ids.mongoCredId);
  } else { console.log('reusing saved Aaziko Mongo credential:', ids.mongoCredId); }

  const wf = wfPayload(ids.mongoCredId);
  assertClean(wf, ids.mongoCredId);

  if (!ids.testWfId) {
    const r = await req('POST', '/api/v1/workflows', wf);
    if (r.status >= 300) throw new Error('workflow create -> ' + r.status + ' ' + r.body.slice(0, 300));
    ids.testWfId = JSON.parse(r.body).id; saveIds();
    console.log('created test workflow:', ids.testWfId);
  } else { console.log('reusing saved test workflow:', ids.testWfId); }

  const act = await req('POST', '/api/v1/workflows/' + ids.testWfId + '/activate');
  console.log('activate -> ' + act.status);

  // read back + re-assert on the LIVE workflow
  const live = await req('GET', '/api/v1/workflows/' + ids.testWfId);
  assertClean(JSON.parse(live.body), ids.mongoCredId);

  await new Promise(z => setTimeout(z, 1500));
  let hit;
  try { hit = await hitWebhook(); } catch (e) { hit = { status: 0, body: 'hit error: ' + e.message }; }
  console.log('\nWEBHOOK ' + HOST + '/webhook/' + WEBHOOK_PATH + ' -> status ' + hit.status);
  console.log('body:', hit.body.slice(0, 400));
  if (hit.status === 200) console.log('\n✅ REACHABLE — ai.cgpe.in n8n CAN reach the Aaziko Mongo. Safe to build the engine here.');
  else console.log('\n❌ NOT a clean 200 — likely ai.cgpe.in cannot route to the tailnet Mongo. Stop; take the host decision back to Ved (fallback = Aaziko local n8n). Then run --cleanup.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
