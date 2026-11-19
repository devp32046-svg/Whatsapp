/* Phase 3.1 — Human-approved SEND workflow (GATED).
 * Panel "Approve & Send" -> this webhook -> allowlist guard -> SMTP send (ONLY allowlisted recipients).
 * Nothing reaches a real buyer unless their address is added to send-allowlist.json (deliberate). */
const fs = require('fs');
const KEY = fs.readFileSync('C:/Users/Inet/Desktop/test-chat-bot/Whatsapp/aaziko/n8n-api-key.txt', 'utf8').trim();
const SEC = 'C:/Users/Inet/Desktop/test-chat-bot/Whatsapp/aaziko/.secrets/';
const MAIL = JSON.parse(fs.readFileSync(SEC + 'demo-mail.json', 'utf8'));
const GATE = JSON.parse(fs.readFileSync(SEC + 'send-allowlist.json', 'utf8'));
const BASE = 'http://localhost:5678/api/v1';
const H = { 'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json', 'accept': 'application/json' };
const CRED = { SMTP: { id: 'Zgx7DuyzK7lVX7eT', name: 'Aaziko Demo Gmail SMTP' }, JV: { id: '8y1CSn93yHhHOhxq', name: 'Aaziko Jarvis RW' } };

// Guard code (allowlist + LIVE flag embedded at build time)
const guardCode =
  'const ALLOW = ' + JSON.stringify((GATE.allow || []).map(a => String(a).toLowerCase())) + ';\n' +
  'const LIVE = ' + (GATE.live === true) + ';\n' +
  'const b = $json.body || $json;\n' +
  "const to = String(b.to || '').toLowerCase().trim();\n" +
  "const realEmail = /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(to) && !/enrichment pending/i.test(to);\n" +
  'const allowed = LIVE && realEmail && ALLOW.includes(to);\n' +
  "const reason = allowed ? 'ok' : (!LIVE ? 'LIVE flag is OFF (all sends blocked)' : (!realEmail ? 'no valid recipient email' : 'recipient not in allowlist'));\n" +
  "return [{ json: { to, subject: b.subject || '', body: b.body || '', pendingId: b.pendingId || '', allowed, reason } }];";

const nodes = [
  { parameters: { httpMethod: 'POST', path: 'aaziko-send', responseMode: 'responseNode', options: {} }, id: 'wh', name: 'Send In', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [-260, 300], webhookId: 'aaziko-send' },
  { parameters: { mode: 'runOnceForAllItems', jsCode: guardCode }, id: 'guard', name: 'Allowlist Guard', type: 'n8n-nodes-base.code', typeVersion: 2, position: [-40, 300] },
  { parameters: { conditions: { options: { caseSensitive: true, typeValidation: 'loose' }, combinator: 'and', conditions: [{ leftValue: '={{ $json.allowed }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }] } }, id: 'if', name: 'Allowed?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [180, 300] },
  { parameters: { fromEmail: MAIL.email, toEmail: '={{ $json.to }}', subject: '={{ $json.subject }}', emailFormat: 'text', text: '={{ $json.body }}', options: {} }, id: 'send', name: 'Send Email (SMTP)', type: 'n8n-nodes-base.emailSend', typeVersion: 2.1, position: [400, 200], credentials: { smtp: CRED.SMTP } },
  { parameters: { respondWith: 'text', responseBody: '={{ JSON.stringify({ ok:true, sent:true, to: $(\'Allowlist Guard\').item.json.to }) }}', options: {} }, id: 'rok', name: 'Resp Sent', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1, position: [620, 200] },
  { parameters: { respondWith: 'text', responseBody: '={{ JSON.stringify({ ok:false, sent:false, blocked:true, reason: $json.reason, to: $json.to }) }}', options: {} }, id: 'rno', name: 'Resp Blocked', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1, position: [400, 420] },
];
const cx = {}; const L = (f, t, idx = 0) => { cx[f] = cx[f] || { main: [] }; while (cx[f].main.length <= idx) cx[f].main.push([]); cx[f].main[idx].push({ node: t, type: 'main', index: 0 }); };
L('Send In', 'Allowlist Guard'); L('Allowlist Guard', 'Allowed?');
L('Allowed?', 'Send Email (SMTP)', 0);  // true
L('Allowed?', 'Resp Blocked', 1);        // false
L('Send Email (SMTP)', 'Resp Sent');
const wf = { name: 'Aaziko ATES Jarvis - Phase 3 (Approve & Send, GATED)', nodes, connections: cx, settings: { executionOrder: 'v1' } };

(async () => {
  let oldId = null; try { oldId = fs.readFileSync(SEC + 'n8n-send-id.txt', 'utf8').trim(); } catch (e) {}
  if (oldId) { const d = await fetch(BASE + '/workflows/' + oldId, { method: 'DELETE', headers: H }); console.log('deleted old send wf ' + oldId + ' -> ' + d.status); }
  const r = await fetch(BASE + '/workflows', { method: 'POST', headers: H, body: JSON.stringify(wf) });
  const j = await r.json();
  if (!r.ok) { console.log('CREATE FAIL ' + r.status + ' ' + JSON.stringify(j).slice(0, 500)); return; }
  const a = await fetch(BASE + '/workflows/' + j.id + '/activate', { method: 'POST', headers: H });
  console.log('CREATED ' + wf.name + ' id=' + j.id + ' activate=' + a.status + ' (webhook /webhook/aaziko-send)');
  console.log('ALLOWLIST (' + (GATE.live ? 'LIVE' : 'OFF') + '): ' + (GATE.allow || []).join(', '));
  fs.writeFileSync(SEC + 'n8n-send-id.txt', j.id);
})().catch(e => console.log('FATAL', e.message));
