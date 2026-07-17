// Step 1 of the lastPremiumPayingDate repair: take a full backup and report what a write WOULD
// change. Nothing is written here.
//
// Only rows whose stored date is unusable get touched - a real ISO date is left exactly as it is,
// because those 2,806 rows are the only evidence the formula works and overwriting them would
// destroy the way to check it later.
const fs = require('fs'), https = require('https');
const KEY = (fs.readFileSync('c:/Users/Inet/Desktop/test-chat-bot/Whatsapp/.env', 'utf8').match(/^\s*N8N_API_KEY\s*=\s*(.+)\s*$/m) || [])[1].trim();
const BASE = 'https://ai.cgpe.in';
const OUT = __dirname + '/backup_lastPremiumPayingDate.json';

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
    const r = https.request(new URL(BASE + p), { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: 300000 },
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

const backup = [], changes = [], samples = [];
const st = { total: rows.length, keepActual: 0, willFill: 0, cannotFill: 0, alreadyDerived: 0 };

for (const r of rows) {
  const id = String(r._id);
  const raw = r.lastPremiumPayingDate;
  const s = String(raw == null ? '' : raw).trim();
  // Every row is backed up, not just the ones we touch, so a restore can rebuild the field exactly.
  backup.push({ _id: id, lastPremiumPayingDate: raw === undefined ? null : raw, premiumDateSource: r.premiumDateSource || null });

  if (r.premiumDateSource === 'derived') { st.alreadyDerived++; continue; }  // re-runnable: skip our own writes
  if (iso(s)) { st.keepActual++; continue; }

  const d = derive(r.commencementDate, num(r.ppt));
  if (!d) { st.cannotFill++; continue; }
  st.willFill++;
  changes.push({ _id: id, lastPremiumPayingDate: d, premiumDateSource: 'derived', premiumDateRaw: s });
  if (samples.length < 5) samples.push({ name: r.name, policy: r.policyNo, comm: r.commencementDate, ppt: num(r.ppt), was: s || '(empty)', becomes: d });
}
return [{ json: { stats: st, samples: samples, changeCount: changes.length, backup: backup } }];
`;

const PATH = 'cgpe-tmp-premdate-plan';
const WF = {
  name: 'TMP premdate plan', settings: { executionOrder: 'v1' },
  nodes: [
    { parameters: { httpMethod: 'POST', path: PATH, responseMode: 'responseNode', options: {} }, id: 'b1', name: 'Start', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: 'premdate-plan-hook' },
    { parameters: { operation: 'find', collection: 'clients', query: '={}', options: { projection: '{"name":1,"policyNo":1,"commencementDate":1,"ppt":1,"lastPremiumPayingDate":1,"premiumDateSource":1}' } },
      id: 'b2', name: 'Fetch', type: 'n8n-nodes-base.mongoDb', typeVersion: 1.1, position: [220, 0], credentials: { mongoDb: { id: 'WZ2iSk9j0aJMoLDk', name: 'MongoDB account' } } },
    { parameters: { jsCode: PLAN }, id: 'b3', name: 'Plan', type: 'n8n-nodes-base.code', typeVersion: 2, position: [440, 0] },
    { parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json) }}', options: {} }, id: 'b4', name: 'Respond', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1, position: [660, 0] },
  ],
  connections: { Start: { main: [[{ node: 'Fetch', type: 'main', index: 0 }]] }, Fetch: { main: [[{ node: 'Plan', type: 'main', index: 0 }]] }, Plan: { main: [[{ node: 'Respond', type: 'main', index: 0 }]] } },
};

(async () => {
  const c = await api('POST', '/api/v1/workflows', WF);
  if (c.status !== 200) { console.error('create failed', c.status, c.body.slice(0, 300)); process.exit(1); }
  const id = JSON.parse(c.body).id;
  try {
    const a = await api('POST', '/api/v1/workflows/' + id + '/activate');
    if (a.status !== 200) { console.error('activate failed', a.status, a.body.slice(0, 300)); return; }
    const r = await hit('/webhook/' + PATH, {});
    if (r.status !== 200) { console.error('HTTP', r.status, r.body.slice(0, 400)); return; }
    const j = JSON.parse(r.body);

    fs.writeFileSync(OUT, JSON.stringify(j.backup));
    console.log('BACKUP written: ' + OUT);
    console.log('  rows backed up: ' + j.backup.length + ' | file: ' + Math.round(fs.statSync(OUT).size / 1024) + ' kB\n');

    console.log('DRY RUN - nothing written yet');
    console.log('  total rows        : ' + j.stats.total);
    console.log('  keep actual date  : ' + j.stats.keepActual + '  (untouched)');
    console.log('  WILL FILL         : ' + j.stats.willFill);
    console.log('  cannot fill (ppt) : ' + j.stats.cannotFill);
    console.log('  already derived   : ' + j.stats.alreadyDerived + '  (re-run safe)\n');
    console.log('  samples of what changes:');
    j.samples.forEach(s => console.log('    ' + s.name + ' [' + s.policy + ']\n      comm ' + s.comm + ' + ppt ' + s.ppt + ' - 1  =>  ' + s.was + '  becomes  ' + s.becomes));
  } finally {
    await api('POST', '/api/v1/workflows/' + id + '/deactivate');
    await api('DELETE', '/api/v1/workflows/' + id);
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
