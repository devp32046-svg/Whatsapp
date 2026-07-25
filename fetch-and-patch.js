// fetch-and-patch.js — run from workspace root: node fetch-and-patch.js
// Reads N8N_API_KEY from .env, fetches kLs5gqFec13sWIfN, patches update_reminder, redeploys.

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── Read .env ──────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, '.env');
const envText = fs.readFileSync(envPath, 'utf8');
const keyLine = envText.split(/\r?\n/).find(l => l.startsWith('N8N_API_KEY='));
if (!keyLine) { console.error('N8N_API_KEY not found in .env'); process.exit(1); }
const API_KEY = keyLine.replace('N8N_API_KEY=', '').trim();

const API_HOST = 'ai.cgpe.in';
const WF_ID    = 'kLs5gqFec13sWIfN';

function apiReq(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: API_HOST, port: 443, path: apiPath, method,
      headers: {
        'X-N8N-API-KEY': API_KEY,
        'Content-Type':  'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const r = https.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(_) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// ── Normalization snippet (mirrors create_reminder IIFE, uses var for n8n compat) ──
const NORM_SNIPPET =
`if (k === 'nextFireAt') {
          var nfv = String(p[k] || '');
          if (nfv) {
            var nfHasTz = /[Zz]$|[+-][0-9][0-9]:?[0-9][0-9]$/.test(nfv);
            var nfWithSec = nfv.length === 16 ? nfv + ':00' : nfv;
            var nfIso = nfHasTz ? nfWithSec : nfWithSec + '+05:30';
            var nfD = new Date(nfIso);
            doc[k] = isNaN(nfD.getTime()) ? nfv : nfD.toISOString();
          } else { doc[k] = nfv; }
        } else { doc[k] = p[k]; }`;

(async () => {
  // ── 1. Fetch ──────────────────────────────────────────────────────────────
  console.log('[1/5] Fetching workflow', WF_ID, '...');
  const { status: s1, body: wf } = await apiReq('GET', `/api/v1/workflows/${WF_ID}`);
  if (s1 !== 200) {
    console.error('Fetch failed. Status:', s1, JSON.stringify(wf).slice(0, 400));
    process.exit(1);
  }
  console.log('      OK —', wf.name, '| active:', wf.active, '| nodes:', wf.nodes.length);

  // ── 2. Find Route Operation node ──────────────────────────────────────────
  const nodeIdx = wf.nodes.findIndex(n => n.name === 'Route Operation');
  if (nodeIdx === -1) {
    console.error('Route Operation node not found. Nodes present:');
    wf.nodes.forEach(n => console.error(' -', n.name));
    process.exit(1);
  }
  const origCode = wf.nodes[nodeIdx].parameters.jsCode;
  console.log('[2/5] Route Operation found (index', nodeIdx + '). Code length:', origCode.length, 'chars');

  // ── 3. Verify update_reminder exists ──────────────────────────────────────
  const urIdx = origCode.indexOf("op === 'update_reminder'");
  if (urIdx === -1) {
    console.error('\nupdate_reminder NOT FOUND in live code. All op checks:');
    (origCode.match(/op === ['"][^'"]+['"]/g) || []).forEach(m => console.error(' ', m));
    process.exit(1);
  }

  // ── 4. Already patched? ───────────────────────────────────────────────────
  if (origCode.includes("if (k === 'nextFireAt')")) {
    console.log('\n[OK] Already patched — nextFireAt normalization already present. No action needed.');
    process.exit(0);
  }

  // ── 5. Isolate update_reminder block & print BEFORE ───────────────────────
  const nextOpIdx = origCode.indexOf('\nif (op ===', urIdx + 30);
  const urBlock   = nextOpIdx !== -1 ? origCode.slice(urIdx, nextOpIdx) : origCode.slice(urIdx);
  console.log('\n[3/5] update_reminder block BEFORE patch:');
  console.log('─'.repeat(60));
  console.log(urBlock);
  console.log('─'.repeat(60));

  // ── 6. Apply patch ────────────────────────────────────────────────────────
  const beforeSeg = origCode.slice(0, urIdx);
  const urSeg     = nextOpIdx !== -1 ? origCode.slice(urIdx, nextOpIdx) : origCode.slice(urIdx);
  const afterSeg  = nextOpIdx !== -1 ? origCode.slice(nextOpIdx) : '';

  // Try multiple whitespace patterns for the raw copy line
  const tryPatterns = [
    [`doc[k] = p[k];\n      fields.push(k);`,  `\n      fields.push(k);`],
    [`doc[k] = p[k];\r\n      fields.push(k);`, `\r\n      fields.push(k);`],
    [`doc[k] = p[k];\n        fields.push(k);`, `\n        fields.push(k);`],
  ];

  let patchedUr = null;
  for (const [pat, fieldsSuffix] of tryPatterns) {
    if (urSeg.includes(pat)) {
      patchedUr = urSeg.replace(pat, NORM_SNIPPET + fieldsSuffix);
      console.log('      Pattern matched:', JSON.stringify(pat.slice(0, 40)));
      break;
    }
  }

  if (!patchedUr) {
    console.error('\nCould not match doc[k] = p[k] inside update_reminder. Raw block above.');
    process.exit(1);
  }

  const newCode = beforeSeg + patchedUr + afterSeg;

  // Print AFTER block
  const urIdxNew   = newCode.indexOf("op === 'update_reminder'");
  const nextOpNew  = newCode.indexOf('\nif (op ===', urIdxNew + 30);
  const urBlockNew = nextOpNew !== -1 ? newCode.slice(urIdxNew, nextOpNew) : newCode.slice(urIdxNew);
  console.log('\n      update_reminder block AFTER patch:');
  console.log('─'.repeat(60));
  console.log(urBlockNew);
  console.log('─'.repeat(60));

  // Save local backup
  const backupDir = path.join(__dirname, '.antigravity');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
  fs.writeFileSync(path.join(backupDir, 'tools_route_op_patched.js'), newCode, 'utf8');
  console.log('      Local backup saved: .antigravity/tools_route_op_patched.js');

  // ── 7. Deactivate ─────────────────────────────────────────────────────────
  console.log('\n[4/5] Deactivating workflow...');
  const { status: sd, body: deactBody } = await apiReq('POST', `/api/v1/workflows/${WF_ID}/deactivate`);
  console.log('      Status:', sd, '| active:', deactBody && deactBody.active);

  // ── 8. PUT ────────────────────────────────────────────────────────────────
  console.log('      PUTting updated workflow...');
  const putBody = {
    name:        wf.name,
    nodes:       wf.nodes.map((n, i) => i === nodeIdx
                   ? { ...n, parameters: { ...n.parameters, jsCode: newCode } }
                   : n),
    connections: wf.connections,
    settings:    wf.settings || {}
  };
  const { status: sp, body: putResp } = await apiReq('PUT', `/api/v1/workflows/${WF_ID}`, putBody);
  console.log('      PUT status:', sp);
  if (sp !== 200) {
    console.error('PUT failed:', JSON.stringify(putResp).slice(0, 500));
    await apiReq('POST', `/api/v1/workflows/${WF_ID}/activate`);
    console.error('Rolled back: workflow re-activated without changes.');
    process.exit(1);
  }
  console.log('      PUT OK. versionId:', putResp.versionId);

  // ── 9. Activate ───────────────────────────────────────────────────────────
  console.log('      Activating workflow...');
  const { status: sa, body: actBody } = await apiReq('POST', `/api/v1/workflows/${WF_ID}/activate`);
  console.log('      Status:', sa, '| active:', actBody && actBody.active);

  // ── 10. Done ──────────────────────────────────────────────────────────────
  console.log('\n[5/5] PATCH DEPLOYED SUCCESSFULLY');
  console.log('      Workflow:', wf.name, '(', WF_ID, ')');
  console.log('      Fix: update_reminder nextFireAt now normalizes to canonical UTC Z');
  console.log('      versionId:', putResp.versionId);
})().catch(e => { console.error('Fatal:', e.message || e); process.exit(1); });
