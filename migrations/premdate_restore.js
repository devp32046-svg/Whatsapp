// Undo premdate_migrate.js: puts lastPremiumPayingDate back to exactly what
// backup_lastPremiumPayingDate.json recorded, and clears the markers we added.
// Only rows we actually touched (premiumDateSource === 'derived') are restored, so a real date
// someone entered after the migration is not clobbered by a stale backup.
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

const backup = JSON.parse(fs.readFileSync(__dirname + '/backup_lastPremiumPayingDate.json', 'utf8'));
const PRIOR = {};
for (const b of backup) PRIOR[b._id] = b.lastPremiumPayingDate;

const PLAN = `
const PRIOR = ${JSON.stringify(PRIOR)};
const out = [];
for (const i of $input.all()) {
  const r = i.json;
  if (r.premiumDateSource !== 'derived') continue;   // never ours - leave it
  const id = String(r._id);
  if (!(id in PRIOR)) continue;                      // added after the backup - not ours to revert
  out.push({ json: { _id: id, lastPremiumPayingDate: PRIOR[id], premiumDateSource: null, premiumDateRaw: null } });
}
return out;
`;

const PATH = 'cgpe-tmp-premdate-restore';
const WF = {
  name: 'TMP premdate restore', settings: { executionOrder: 'v1' },
  nodes: [
    { parameters: { httpMethod: 'POST', path: PATH, responseMode: 'lastNode', options: {} }, id: 'd1', name: 'Start', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: 'premdate-restore-hook' },
    { parameters: { operation: 'find', collection: 'clients', query: '={"premiumDateSource":"derived"}', options: { projection: '{"lastPremiumPayingDate":1,"premiumDateSource":1}' } },
      id: 'd2', name: 'Fetch', type: 'n8n-nodes-base.mongoDb', typeVersion: 1.1, position: [220, 0], credentials: { mongoDb: { id: 'WZ2iSk9j0aJMoLDk', name: 'MongoDB account' } } },
    { parameters: { jsCode: PLAN }, id: 'd3', name: 'Plan', type: 'n8n-nodes-base.code', typeVersion: 2, position: [440, 0] },
    { parameters: { operation: 'update', collection: 'clients', updateKey: '_id', fields: 'lastPremiumPayingDate,premiumDateSource,premiumDateRaw', options: {} },
      id: 'd4', name: 'Apply', type: 'n8n-nodes-base.mongoDb', typeVersion: 1.1, position: [660, 0], credentials: { mongoDb: { id: 'WZ2iSk9j0aJMoLDk', name: 'MongoDB account' } } },
    { parameters: { jsCode: "return [{ json: { restored: $input.all().length } }];" }, id: 'd5', name: 'Count', type: 'n8n-nodes-base.code', typeVersion: 2, position: [880, 0] },
  ],
  connections: {
    Start: { main: [[{ node: 'Fetch', type: 'main', index: 0 }]] },
    Fetch: { main: [[{ node: 'Plan', type: 'main', index: 0 }]] },
    Plan: { main: [[{ node: 'Apply', type: 'main', index: 0 }]] },
    Apply: { main: [[{ node: 'Count', type: 'main', index: 0 }]] },
  },
};

(async () => {
  const c = await api('POST', '/api/v1/workflows', WF);
  if (c.status !== 200) { console.error('create failed', c.status, c.body.slice(0, 300)); process.exit(1); }
  const id = JSON.parse(c.body).id;
  try {
    await api('POST', '/api/v1/workflows/' + id + '/activate');
    console.log('restoring from backup of ' + backup.length + ' rows...');
    const r = await hit('/webhook/' + PATH, {});
    console.log('HTTP', r.status, '|', r.body.slice(0, 300));
  } finally {
    await api('POST', '/api/v1/workflows/' + id + '/deactivate');
    await api('DELETE', '/api/v1/workflows/' + id);
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
