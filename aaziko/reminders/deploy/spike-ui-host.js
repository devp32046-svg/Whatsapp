'use strict';
/* Decisive spike: can an HTML page SERVED by this n8n call the reminder webhooks from the browser?
 * Deploys a tiny GET->HTML webhook, reads its response headers (CSP sandbox => opaque origin), and
 * probes CORS preflight on the create webhook. Deletes the spike after. Read-only to the reminder data.
 *   node aaziko/reminders/deploy/spike-ui-host.js
 */
const https = require('https');
const { req, HOST } = require('../../../scripts/lib/n8n-req');
function raw(method, p, headers) {
  return new Promise((res, rej) => {
    const r = https.request({ hostname: HOST, path: p, method, timeout: 30000, headers: headers || {} },
      x => { const c = []; x.on('data', d => c.push(d)); x.on('end', () => res({ status: x.statusCode, headers: x.headers, body: Buffer.concat(c).toString('utf8') })); });
    r.on('error', rej); r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); });
    r.end();
  });
}
const P = 'aaziko-spike-page';
const wf = {
  name: 'Aaziko Reminders — SPIKE (delete me)',
  nodes: [
    { id: 'h', name: 'Hook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0],
      parameters: { httpMethod: 'GET', path: P, responseMode: 'responseNode', options: {} } },
    { id: 'r', name: 'Serve', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1, position: [240, 0],
      parameters: { respondWith: 'text', responseBody: '<!DOCTYPE html><html><body><h1>spike</h1></body></html>',
        options: { responseHeaders: { entries: [{ name: 'content-type', value: 'text/html; charset=utf-8' }] } } } },
  ],
  connections: { 'Hook': { main: [[{ node: 'Serve', type: 'main', index: 0 }]] } },
  settings: { saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all' },
};
(async () => {
  const id = JSON.parse((await req('POST', '/api/v1/workflows', wf)).body).id;
  await req('POST', '/api/v1/workflows/' + id + '/activate');
  await new Promise(z => setTimeout(z, 1500));
  try {
    const page = await raw('GET', '/webhook/' + P);
    console.log('PAGE GET -> ' + page.status);
    console.log('  content-type           :', page.headers['content-type']);
    console.log('  content-security-policy :', page.headers['content-security-policy'] || '(none)');
    console.log('  x-frame-options        :', page.headers['x-frame-options'] || '(none)');
    console.log('  body starts            :', JSON.stringify(page.body.slice(0, 60)));
    const opt = await raw('OPTIONS', '/webhook/aaziko-reminder-create', { Origin: 'null', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' });
    console.log('CREATE OPTIONS -> ' + opt.status + ' | allow-origin: ' + (opt.headers['access-control-allow-origin'] || '(none)') + ' | allow-headers: ' + (opt.headers['access-control-allow-headers'] || '(none)'));
    const csp = String(page.headers['content-security-policy'] || '');
    console.log('\nVERDICT: CSP sandbox present? ' + (/sandbox/.test(csp) ? 'YES — page gets an opaque origin; its fetch to the webhooks is cross-origin(null), needs CORS' : 'NO — page keeps ai.cgpe.in origin; same-origin fetch to webhooks works'));
  } finally {
    await req('DELETE', '/api/v1/workflows/' + id);
    console.log('spike wf deleted', id);
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
