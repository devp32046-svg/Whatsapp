/**
 * One-click launcher for the PDF prep service.
 *
 * Starts the local service, opens a Cloudflare tunnel to it, and automatically points the
 * n8n "PDF Prep" node at the tunnel URL. When you close this window it puts the n8n node
 * back to a safe localhost URL so claims cleanly fall back to the normal path.
 *
 * Just double-click start-pdf-prep.bat - you do not have to touch n8n yourself.
 */
const { spawn } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const env = fs.readFileSync(path.join(DIR, '.env'), 'utf8');
const GEMINI_KEY = (env.match(/^GEMINI_API_KEY_CLAIMS=(.+)$/m) || env.match(/^GEMINI_API_KEY=(.+)$/m) || [])[1].trim();
const N8N_KEY = (env.match(/^N8N_API_KEY=(.+)$/m) || [])[1].trim();
const CLAIM_WF = 'BSgPV5vR701AmP4J';
const PORT = 3100;
// Left in n8n when this launcher exits. The service is now deployed on the n8n server itself,
// so hand n8n back to that rather than to a dead address. n8n runs in Docker there, so the
// host is the bridge gateway - 127.0.0.1 would be the container itself.
const SAFE_URL = 'http://172.18.0.1:3100/prepare';

function log(m) { console.log('[' + new Date().toTimeString().slice(0, 8) + '] ' + m); }

function n8n(method, p, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({ hostname: 'ai.cgpe.in', path: '/api/v1' + p, method,
      headers: { 'X-N8N-API-KEY': N8N_KEY, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      resp => { let s = ''; resp.on('data', d => s += d); resp.on('end', () => res({ code: resp.statusCode, body: s })); });
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}

async function setPrepUrl(url) {
  const w = JSON.parse((await n8n('GET', '/workflows/' + CLAIM_WF)).body);
  const node = w.nodes.find(n => n.name === 'PDF Prep');
  if (!node) { log('WARNING: PDF Prep node not found in n8n'); return false; }
  node.parameters.url = url;
  const p = await n8n('PUT', '/workflows/' + CLAIM_WF, { name: w.name, nodes: w.nodes, connections: w.connections, settings: { executionOrder: 'v1' } });
  if (p.code >= 300) { log('n8n update failed: ' + p.code); return false; }
  await n8n('POST', '/workflows/' + CLAIM_WF + '/deactivate');
  await n8n('POST', '/workflows/' + CLAIM_WF + '/activate');
  return true;
}

// 1. start the service
log('starting PDF prep service on port ' + PORT + ' ...');
const svc = spawn(process.execPath, [path.join(DIR, 'pdf-prep-service.js')],
  { env: Object.assign({}, process.env, { GEMINI_API_KEY: GEMINI_KEY, PDF_PREP_PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
svc.stdout.on('data', d => process.stdout.write('  [service] ' + d));
svc.stderr.on('data', d => process.stdout.write('  [service] ' + d));

// 2. start the tunnel and capture its URL
let tunnelUrl = '';
let wired = false;
log('opening Cloudflare tunnel ...');
const cf = spawn('cloudflared', ['tunnel', '--url', 'http://127.0.0.1:' + PORT], { stdio: ['ignore', 'pipe', 'pipe'] });
function onCf(buf) {
  const s = buf.toString();
  const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (m && !tunnelUrl) {
    tunnelUrl = m[0];
    log('tunnel is up: ' + tunnelUrl);
    setPrepUrl(tunnelUrl + '/prepare').then(ok => {
      wired = ok;
      if (ok) {
        log('✅ n8n is now using this service. Big/oversized claim PDFs will be split automatically.');
        log('   Leave this window OPEN. Closing it safely turns the feature off (claims keep working).');
      }
    });
  }
}
cf.stdout.on('data', onCf);
cf.stderr.on('data', onCf);

// 3. clean shutdown: point n8n back to the safe localhost url
let cleaning = false;
async function shutdown() {
  if (cleaning) return; cleaning = true;
  log('shutting down - restoring n8n to the safe fallback ...');
  try { if (wired) { await setPrepUrl(SAFE_URL); log('n8n restored. Oversized PDFs will show "review manually" until you start this again.'); } } catch (e) {}
  try { svc.kill(); } catch (e) {}
  try { cf.kill(); } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => { try { svc.kill(); cf.kill(); } catch (e) {} });
