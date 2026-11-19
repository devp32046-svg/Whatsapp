'use strict';
/* Proves the exact loop the UI page uses, server-side: POST create (JSON body + secret, like the page's
 * compose) -> GET feed -> the reminder shows up under "pending". Then cleans up. (Fire->inbox is proven
 * separately by verify-tick.js.)
 *   node aaziko/reminders/deploy/ui-e2e.js
 */
const https = require('https'), path = require('path'), fs = require('fs');
const { HOST } = require('../../../scripts/lib/n8n-req');
const { withDb, COLL } = require('../lib/db');
const env = {}; try { fs.readFileSync(path.join(__dirname, '..', '..', '.secrets', 'reminders.env'), 'utf8').split(/\r?\n/).forEach(l => { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2]; }); } catch (e) {}
const K = env.REMINDERS_CREATE_SECRET;
function z(n) { return (n < 10 ? '0' : '') + n; }
function istWall(plusMin) { const d = new Date(Date.now() + plusMin * 60000 + 5.5 * 3600000); return d.getUTCFullYear() + '-' + z(d.getUTCMonth() + 1) + '-' + z(d.getUTCDate()) + ' ' + z(d.getUTCHours()) + ':' + z(d.getUTCMinutes()); }
function hit(method, p, body) {
  const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
  return new Promise((res, rej) => {
    const r = https.request({ hostname: HOST, path: p, method, timeout: 30000, headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} },
      x => { const c = []; x.on('data', d => c.push(d)); x.on('end', () => res({ s: x.statusCode, b: Buffer.concat(c).toString('utf8') })); });
    r.on('error', rej); r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); });
    if (data) r.write(data); r.end();
  });
}
(async () => {
  const ist = istWall(3);
  const c = await hit('POST', '/webhook/aaziko-reminder-create', { text: 'FEED E2E', recipientPhone: '910000000000', nextFireAt: ist, secret: K, source: 'ui-e2e' });
  console.log('create (JSON+secret) ->', c.s, c.b.slice(0, 120));
  const f = await hit('GET', '/webhook/aaziko-reminders-feed?k=' + encodeURIComponent(K));
  let fj = {}; try { fj = JSON.parse(f.b); } catch (e) {}
  const found = (fj.pending || []).find(r => r.text === 'FEED E2E');
  console.log('feed pending shows it? ', !!found, found ? ('| dueIST ' + found.dueIST) : '');
  await withDb(async (cl, db) => { const d = await db.collection(COLL).deleteMany({ source: 'ui-e2e' }); console.log('cleaned', d.deletedCount, 'reminder(s)'); });
  console.log(c.s === 200 && found ? '\n✅ create -> feed(pending) loop works (this is what the UI does on compose + poll).' : '\n❌ loop not proven — inspect above.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
