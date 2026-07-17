// Step 2: fill lastPremiumPayingDate on the 6,200 rows whose stored value is unusable.
//
// Safety rules baked into the plan node, not just this comment:
//  - a real ISO date is never written over - those 2,806 rows are the only proof the formula works
//  - the unusable value is preserved in premiumDateRaw, so nothing is actually destroyed
//  - premiumDateSource:'derived' marks every row we touched: it tells later readers the date is an
//    estimate, lets a restore find our writes, and makes a re-run skip them
// Full backup lives in backup_lastPremiumPayingDate.json (all 9,012 rows) - restore with
// premdate_restore.js if this turns out wrong.
const fs = require('fs'), https = require('https');
const KEY = (fs.readFileSync('c:/Users/Inet/Desktop/test-chat-bot/Whatsapp/.env', 'utf8').match(/^\s*N8N_API_KEY\s*=\s*(.+)\s*$/m) || [])[1].trim();
const BASE = 'https://ai.cgpe.in';

function api(m, p, b) {
  return new Promise((res, rej) => {
    const body = b ? JSON.stringify(b) : null;
    const h = { 'X-N8N-API-KEY': KEY, 'accept': 'application/json' };
    if (body) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(body); }
    const r = https.request(new URL(BASE + p), { method: m, headers: h, timeout: 180000 }, x => { let d = ''; x.on('data', c => d += c); x.on('end', () => res({ status: x.statusCode, body: d })); });
    r.on('error', rej); r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); });
    if (body) r.write(body); r.end();
  });
}
function hit(p, b) {
  return new Promise((res, rej) => {
    const body = JSON.stringify(b || {});
    const r = https.request(new URL(BASE + p), { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: 600000 },
      x => { const ch = []; x.on('data', c => ch.push(c)); x.on('end', () => res({ status: x.statusCode, body: Buffer.concat(ch).toString() })); });
    r.on('error', rej); r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); });
    r.write(body); r.end();
  });
}

const PLAN = `
const rows = $input.all().map(i => i.json);
const iso = (s) => /^\\d{4}-\\d{2}-\\d{2}/.test(String(s || ''));
const num = (v) => { const n = parseInt(String(v == null ? '' : v).replace(/[^0-9]/g, ''), 10); return isFinite(n) ? n : 0; };
const derive = (comm, ppt) => {
  if (!iso(comm) || !(ppt > 0)) return null;
  const d = new Date(String(comm).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(d)) return null;
  d.setUTCFullYear(d.getUTCFullYear() + ppt - 1);
  return d.toISOString().slice(0, 10);
};
const out = [];
for (const r of rows) {
  if (r.premiumDateSource === 'derived') continue;              // ours already - re-run safe
  const s = String(r.lastPremiumPayingDate == null ? '' : r.lastPremiumPayingDate).trim();
  if (iso(s)) continue;                                          // real date - never overwrite
  const d = derive(r.commencementDate, num(r.ppt));
  if (!d) continue;                                              // no ppt - leave alone
  out.push({ json: { _id: String(r._id), lastPremiumPayingDate: d, premiumDateSource: 'derived', premiumDateRaw: s } });
}
return out;
`;

const PATH = 'cgpe-tmp-premdate-migrate';
const WF = {
  name: 'TMP premdate migrate', settings: { executionOrder: 'v1' },
  nodes: [
    { parameters: { httpMethod: 'POST', path: PATH, responseMode: 'lastNode', options: {} }, id: 'c1', name: 'Start', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: 'premdate-migrate-hook' },
    { parameters: { operation: 'find', collection: 'clients', query: '={}', options: { projection: '{"commencementDate":1,"ppt":1,"lastPremiumPayingDate":1,"premiumDateSource":1}' } },
      id: 'c2', name: 'Fetch', type: 'n8n-nodes-base.mongoDb', typeVersion: 1.1, position: [220, 0], credentials: { mongoDb: { id: 'WZ2iSk9j0aJMoLDk', name: 'MongoDB account' } } },
    { parameters: { jsCode: PLAN }, id: 'c3', name: 'Plan', type: 'n8n-nodes-base.code', typeVersion: 2, position: [440, 0] },
    { parameters: { operation: 'update', collection: 'clients', updateKey: '_id', fields: 'lastPremiumPayingDate,premiumDateSource,premiumDateRaw', options: {} },
      id: 'c4', name: 'Apply', type: 'n8n-nodes-base.mongoDb', typeVersion: 1.1, position: [660, 0], credentials: { mongoDb: { id: 'WZ2iSk9j0aJMoLDk', name: 'MongoDB account' } } },
    { parameters: { jsCode: "return [{ json: { updated: $input.all().length } }];" }, id: 'c5', name: 'Count', type: 'n8n-nodes-base.code', typeVersion: 2, position: [880, 0] },
  ],
  connections: {
    Start: { main: [[{ node: 'Fetch', type: 'main', index: 0 }]] },
    Fetch: { main: [[{ node: 'Plan', type: 'main', index: 0 }]] },
    Plan: { main: [[{ node: 'Apply', type: 'main', index: 0 }]] },
    Apply: { main: [[{ node: 'Count', type: 'main', index: 0 }]] },
  },
};

(async () => {
  if (!fs.existsSync(__dirname + '/backup_lastPremiumPayingDate.json')) {
    console.error('REFUSING: backup file missing. Run premdate_backup_dryrun.js first.'); process.exit(1);
  }
  const c = await api('POST', '/api/v1/workflows', WF);
  if (c.status !== 200) { console.error('create failed', c.status, c.body.slice(0, 300)); process.exit(1); }
  const id = JSON.parse(c.body).id;
  try {
    const a = await api('POST', '/api/v1/workflows/' + id + '/activate');
    if (a.status !== 200) { console.error('activate failed', a.status, a.body.slice(0, 300)); return; }
    console.log('writing...');
    const r = await hit('/webhook/' + PATH, {});
    console.log('HTTP', r.status, '|', r.body.slice(0, 300));
  } finally {
    await api('POST', '/api/v1/workflows/' + id + '/deactivate');
    await api('DELETE', '/api/v1/workflows/' + id);
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
