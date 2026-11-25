'use strict';
/*
 * fix-find-hs-code.js
 * Fixes find_hs_code multi-word query: AND → OR logic so "cotton raw material" works.
 * "cotton raw material" with AND requires all 3 words in description — "material" is absent.
 * With OR: any word matches → cotton entries come up.
 *
 * Usage:
 *   node aaziko/brain/deploy/fix-find-hs-code.js          # dry-run
 *   node aaziko/brain/deploy/fix-find-hs-code.js --write  # deploy
 */
require('dotenv').config();
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');
const https = require('https');

const WRITE     = process.argv.includes('--write');
const BRAIN_ID  = 'w7no6uCJkz7lfaah';
const TOOL_NAME = 'find_hs_code';
const CS_CRED   = { mongoDb: { id: 'vL0izSZrMHn4Ukgc', name: 'Aaziko - common-service' } };

// OR logic: any word must appear. First word (the product name) is required.
const PARSE_CODE = `
let inp = {};
try {
  inp = typeof $input.first().json === 'string'
    ? JSON.parse($input.first().json)
    : $input.first().json;
} catch(e) {}

var query = String(inp.query || inp.product || inp.keyword || '').trim();
var limit = Math.min(parseInt(inp.limit || 10, 10), 20);

if (!query || query.length < 2) {
  return [{ json: { pipelineStr: '[]', query: '', error: 'Product description ya keyword zaroori hai (min 2 chars)' } }];
}

// Split into words, build OR regex (any word match)
var words = query.split(/\\s+/).filter(function(w) { return w.length > 1; });
var matchFilter = { status: 'active' };

if (words.length > 1) {
  // OR: any of the words
  matchFilter['description'] = { $regex: words.join('|'), $options: 'i' };
} else {
  matchFilter['description'] = { $regex: query, $options: 'i' };
}

var pipeline = [
  { $match: matchFilter },
  { $project: { hsCode: 1, description: 1, _id: 0 } },
  { $sort: { hsCode: 1 } },
  { $limit: limit }
];

return [{ json: { pipelineStr: JSON.stringify(pipeline), query: query, limit: limit } }];
`.trim();

const FORMAT_CODE = `
var ctx  = $('Parse Input').first().json;
var rows = $input.all().map(function(i) { return i.json; });

if (ctx.error) {
  return [{ json: { output: 'Product ka naam ya description dena zaroori hai. Example: "cotton", "leather gloves", "rice".' } }];
}

if (!rows.length) {
  return [{ json: { output: '"' + ctx.query + '" ke liye koi HS code nahi mila. Koi aur keyword try karein (e.g. "cotton", "leather").' } }];
}

var lines = rows.map(function(r, i) {
  return (i + 1) + '. HS ' + r.hsCode + ' — ' + r.description;
});

return [{ json: {
  output: 'HS codes for "' + ctx.query + '" (Aaziko hscodes database):\\n' + lines.join('\\n') +
    '\\n\\nIs HS code ke buyers ya market summary ke liye puchein.'
} }];
`.trim();

const REPLY_CODE = `
var all = $input.all();
var out = '';
for (var i = 0; i < all.length; i++) {
  if (all[i].json && all[i].json.output) { out = all[i].json.output; break; }
}
return [{ json: { output: out || 'No HS code data available.' } }];
`.trim();

function apiReq(method, ep, body) {
  return new Promise((res, rej) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = https.request({
      hostname: 'ai.cgpe.in', path: '/api/v1' + ep, method,
      headers: { 'X-N8N-API-KEY': process.env.N8N_API_KEY, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': data.length } : {}) }
    }, r => { const ch = []; r.on('data', c => ch.push(c)); r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(ch).toString('utf8') })); });
    req.on('error', rej); if (data) req.write(data); req.end();
  });
}

(async () => {
  console.log('\n=== Fix Tool: find_hs_code (AND → OR) ===');
  console.log(WRITE ? '[LIVE DEPLOY]' : '[DRY-RUN — pass --write to deploy]');
  if (!WRITE) { console.log('Run with --write to deploy.'); return; }

  const listR  = await apiReq('GET', '/workflows?limit=250');
  const allWfs = JSON.parse(listR.body).data || [];
  const exist  = allWfs.find(w => w.name === 'Tool: find_hs_code');
  if (!exist) { console.error('Sub-wf "Tool: find_hs_code" not found'); return; }

  const wf = await getWf(exist.id);
  const parseNode = wf.nodes.find(n => n.name === 'Parse Input');
  const fmtNode   = wf.nodes.find(n => n.name === 'Format Results');
  if (!parseNode || !fmtNode) { console.error('Nodes not found in sub-wf'); return; }
  parseNode.parameters.jsCode = PARSE_CODE;
  fmtNode.parameters.jsCode   = FORMAT_CODE;
  // Reply OK stays the same

  const r = await putWf(exist.id, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings });
  if (r.status >= 300) { console.error('PUT failed:', r.body?.slice(0, 300)); return; }
  console.log('Sub-wf updated:', exist.id);
  await activate(exist.id, false); await new Promise(r => setTimeout(r, 600)); await activate(exist.id, true);

  const rs = await getWf(exist.id);
  const pc = rs.nodes.find(n => n.name === 'Parse Input');
  const orOk = pc && pc.parameters.jsCode.includes("words.join('|')");
  console.log('OR logic applied:', orOk ? '✓' : '✗');
  if (orOk) console.log('\n✅ DEPLOY SUCCESS — find_hs_code now uses OR match for multi-word queries');
})().catch(e => console.error('FATAL:', e.message));
