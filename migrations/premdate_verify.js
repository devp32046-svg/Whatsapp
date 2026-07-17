// Step 3: prove the migration did what it claimed, by comparing the live collection against the
// backup taken before the write. The one thing that must never have happened is a real date being
// replaced by an estimate - that is checked explicitly, not assumed.
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
function hit(p) {
  return new Promise((res, rej) => {
    const r = https.request(new URL(BASE + p), { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 2 }, timeout: 300000 },
      x => { const ch = []; x.on('data', c => ch.push(c)); x.on('end', () => res({ status: x.statusCode, body: Buffer.concat(ch).toString() })); });
    r.on('error', rej); r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); });
    r.write('{}'); r.end();
  });
}

const backup = JSON.parse(fs.readFileSync(__dirname + '/backup_lastPremiumPayingDate.json', 'utf8'));
const PRIOR = {};
for (const b of backup) PRIOR[b._id] = b.lastPremiumPayingDate == null ? '' : String(b.lastPremiumPayingDate);

const CHECK = 'const PRIOR = ' + JSON.stringify(PRIOR) + ';\n' + `
const iso = (s) => /^\\d{4}-\\d{2}-\\d{2}/.test(String(s || ''));
const st = { total: 0, actual: 0, derived: 0, rawKept: 0, stillBroken: 0, noPpt: 0, missingFromBackup: 0 };
const violations = [];
for (const i of $input.all()) {
  const r = i.json; st.total++;
  const id = String(r._id);
  const now = String(r.lastPremiumPayingDate == null ? '' : r.lastPremiumPayingDate).trim();
  if (!(id in PRIOR)) { st.missingFromBackup++; continue; }
  const was = PRIOR[id].trim();
  const wasReal = iso(was);

  if (r.premiumDateSource === 'derived') {
    st.derived++;
    if (r.premiumDateRaw !== undefined && r.premiumDateRaw !== null) st.rawKept++;
    if (wasReal) violations.push({ _id: id, was: was, now: now, why: 'OVERWROTE A REAL DATE' });
    if (!iso(now)) violations.push({ _id: id, now: now, why: 'marked derived but not a date' });
  } else {
    if (iso(now)) st.actual++;
    else {
      st.stillBroken++;
      const ppt = parseInt(String(r.ppt == null ? '' : r.ppt).replace(/[^0-9]/g, ''), 10);
      if (!(ppt > 0)) st.noPpt++;
    }
    if (was !== now) violations.push({ _id: id, was: was, now: now, why: 'CHANGED BUT NOT MARKED' });
  }
}
return [{ json: { stats: st, violationCount: violations.length, violations: violations.slice(0, 10) } }];`;

const PATH = 'cgpe-tmp-premdate-verify';
const WF = {
  name: 'TMP premdate verify', settings: { executionOrder: 'v1' },
  nodes: [
    { parameters: { httpMethod: 'POST', path: PATH, responseMode: 'responseNode', options: {} }, id: 'e1', name: 'Start', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: 'premdate-verify-hook' },
    { parameters: { operation: 'find', collection: 'clients', query: '={}', options: { projection: '{"lastPremiumPayingDate":1,"premiumDateSource":1,"premiumDateRaw":1,"ppt":1}' } },
      id: 'e2', name: 'Fetch', type: 'n8n-nodes-base.mongoDb', typeVersion: 1.1, position: [220, 0], credentials: { mongoDb: { id: 'WZ2iSk9j0aJMoLDk', name: 'MongoDB account' } } },
    { parameters: { jsCode: CHECK }, id: 'e3', name: 'Check', type: 'n8n-nodes-base.code', typeVersion: 2, position: [440, 0] },
    { parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json) }}', options: {} }, id: 'e4', name: 'Respond', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1, position: [660, 0] },
  ],
  connections: { Start: { main: [[{ node: 'Fetch', type: 'main', index: 0 }]] }, Fetch: { main: [[{ node: 'Check', type: 'main', index: 0 }]] }, Check: { main: [[{ node: 'Respond', type: 'main', index: 0 }]] } },
};

(async () => {
  const c = await api('POST', '/api/v1/workflows', WF);
  if (c.status !== 200) { console.error('create failed', c.status, c.body.slice(0, 300)); process.exit(1); }
  const id = JSON.parse(c.body).id;
  try {
    const a = await api('POST', '/api/v1/workflows/' + id + '/activate');
    if (a.status !== 200) { console.error('activate failed', a.status, a.body.slice(0, 300)); return; }
    const r = await hit('/webhook/' + PATH);
    if (r.status !== 200) { console.error('HTTP', r.status, r.body.slice(0, 400)); return; }
    const j = JSON.parse(r.body);
    console.log('=== POST-MIGRATION VERIFY (live DB vs pre-write backup) ===');
    console.log('  total rows             : ' + j.stats.total);
    console.log('  real dates, untouched  : ' + j.stats.actual);
    console.log('  derived by us          : ' + j.stats.derived);
    console.log('  raw value preserved    : ' + j.stats.rawKept);
    console.log('  still unusable         : ' + j.stats.stillBroken + '  (no ppt: ' + j.stats.noPpt + ')');
    console.log('  not in backup          : ' + j.stats.missingFromBackup);
    console.log('');
    console.log('  VIOLATIONS             : ' + j.violationCount + (j.violationCount === 0 ? '  ✅ none' : '  ❌'));
    if (j.violationCount) console.log(JSON.stringify(j.violations, null, 1));
  } finally {
    await api('POST', '/api/v1/workflows/' + id + '/deactivate');
    await api('DELETE', '/api/v1/workflows/' + id);
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
