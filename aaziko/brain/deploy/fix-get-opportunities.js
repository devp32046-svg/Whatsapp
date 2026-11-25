'use strict';
/*
 * fix-get-opportunities.js
 * Rewrites Tool: get_opportunities sub-wf to use market_trends (27,967 docs, wide HS coverage)
 * instead of stage1_opportunities (1,754 docs, only HS 6907xx ceramics).
 *
 * Usage:
 *   node aaziko/brain/deploy/fix-get-opportunities.js          # dry-run
 *   node aaziko/brain/deploy/fix-get-opportunities.js --write  # deploy
 */
require('dotenv').config();
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');
const https = require('https');

const WRITE     = process.argv.includes('--write');
const BRAIN_ID  = 'w7no6uCJkz7lfaah';
const TOOL_NAME = 'get_opportunities';
const CS_CRED   = { mongoDb: { id: 'vL0izSZrMHn4Ukgc', name: 'Aaziko - common-service' } };

// market_trends fields: country, hs_code_6, rank, buyer_count, total_value, computed_at
const PARSE_CODE = `
let inp = {};
try {
  inp = typeof $input.first().json === 'string'
    ? JSON.parse($input.first().json)
    : $input.first().json;
} catch(e) {}

var hs      = String(inp.hs_code || inp.hs || '').trim();
var country = String(inp.country || inp.destination || '').trim();
var limit   = Math.min(parseInt(inp.limit || 10, 10), 20);

if (!hs && !country) {
  return [{ json: { pipelineStr: '[]', hs, country, error: 'HS code ya country mein se ek zaroori hai' } }];
}

var matchFilter = {};
if (hs) {
  var hsPfx = hs.replace(/\\D/g, '').slice(0, 6);
  if (hsPfx) matchFilter['hs_code_6'] = { $regex: '^' + hsPfx };
}
if (country) matchFilter['country'] = { $regex: country, $options: 'i' };

var pipeline = [
  { $match: matchFilter },
  { $sort: { buyer_count: -1 } },
  { $limit: limit },
  { $project: {
    country:      1,
    hs_code_6:    1,
    buyer_count:  1,
    total_value:  1,
    rank:         1,
    _id: 0
  }}
];

return [{ json: { pipelineStr: JSON.stringify(pipeline), hs, country, limit } }];
`.trim();

const FORMAT_CODE = `
var ctx  = $('Parse Input').first().json;
var rows = $input.all().map(function(i) { return i.json; });

if (ctx.error) {
  return [{ json: { output: 'HS code (4-6 digits) ya destination country dena zaroori hai. Example: "5201 ke liye top countries" ya "Germany mein kya import hota hai".' } }];
}

if (!rows.length) {
  var msg = 'Koi market trend data nahi mila';
  if (ctx.hs)      msg += ' — HS: ' + ctx.hs;
  if (ctx.country) msg += ' — country: ' + ctx.country;
  return [{ json: { output: msg + '. Koi aur HS code try karein.' } }];
}

function fmt(v) {
  if (!v || isNaN(v)) return '';
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  return '$' + (v / 1e3).toFixed(0) + 'K';
}

var lines = rows.map(function(r, i) {
  var country  = r.country || '?';
  var buyers   = r.buyer_count != null ? ' · ' + r.buyer_count + ' buyers' : '';
  var val      = r.total_value ? ' · ' + fmt(r.total_value) : '';
  var hs       = r.hs_code_6 ? ' · HS ' + r.hs_code_6 : '';
  return (i + 1) + '. ' + country + buyers + val + hs;
});

var header = 'Top destination markets (market_trends)';
if (ctx.hs)      header += ' — HS ' + ctx.hs;
if (ctx.country) header += ' in ' + ctx.country;

return [{ json: {
  output: header + ':\\n' + lines.join('\\n') +
    '\\n\\nKisi specific country ke buyers ya shipment history ke liye puchein.'
} }];
`.trim();

const REPLY_CODE = `
var all = $input.all();
var out = '';
for (var i = 0; i < all.length; i++) {
  if (all[i].json && all[i].json.output) { out = all[i].json.output; break; }
}
return [{ json: { output: out || 'No market trend data available.' } }];
`.trim();

const SUB_WF_NODES = [
  { id: 'op-trig',  name: 'Execute Workflow Trigger', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1, position: [100, 300], parameters: {} },
  { id: 'op-parse', name: 'Parse Input',      type: 'n8n-nodes-base.code',    typeVersion: 2, position: [340, 300],  parameters: { jsCode: PARSE_CODE } },
  { id: 'op-find',  name: 'Find Trends',      type: 'n8n-nodes-base.mongoDb', typeVersion: 1, position: [580, 300],
    credentials: CS_CRED,
    parameters: { operation: 'aggregate', collection: 'market_trends', query: '={{ $json.pipelineStr }}' }
  },
  { id: 'op-fmt',   name: 'Format Results',   type: 'n8n-nodes-base.code',    typeVersion: 2, position: [820, 300],  parameters: { jsCode: FORMAT_CODE } },
  { id: 'op-ok',    name: 'Reply OK',          type: 'n8n-nodes-base.code',    typeVersion: 2, position: [1060, 300], parameters: { jsCode: REPLY_CODE } }
];

const SUB_WF_CONN = {
  'Execute Workflow Trigger': { main: [[{ node: 'Parse Input',    type: 'main', index: 0 }]] },
  'Parse Input':              { main: [[{ node: 'Find Trends',    type: 'main', index: 0 }]] },
  'Find Trends':              { main: [[{ node: 'Format Results', type: 'main', index: 0 }]] },
  'Format Results':           { main: [[{ node: 'Reply OK',       type: 'main', index: 0 }]] }
};

function makeBrainNodeParams(wfId) {
  return {
    description:
      'Returns TOP DESTINATION MARKETS for a product — which countries import the most, ranked by active buyer count and total value. ' +
      'Use when user asks about MARKET OPPORTUNITIES, top buyers, destination countries, or which markets to target: ' +
      '"cotton ke liye top market kaunsa hai?", "HS 5201 mein kaun kharidta hai?", ' +
      '"top importing countries for leather", "Germany mein kya import hota hai?", ' +
      '"best market for HS 420321", "trade opportunities for cotton", ' +
      '"kahan sell karein?", "top buyers by country", "market analysis". ' +
      'Requires HS code (4-6 digits) OR destination country.',
    workflowId: { __rl: true, mode: 'id', value: wfId, cachedResultName: 'Tool: get_opportunities' },
    workflowInputs: {
      mappingMode: 'defineBelow',
      value: {
        hs_code: "={{ $fromAI('hs_code', 'HS code 4-6 digits to find top markets (e.g. 5201 for cotton). Required if no country.', 'string', '') }}",
        country: "={{ $fromAI('country', 'Destination/buyer country name. Optional.', 'string', '') }}",
        limit:   "={{ $fromAI('limit',   'Max markets to return (default 10)', 'number', 10) }}"
      },
      matchingColumns: [],
      schema: [
        { id: 'hs_code', displayName: 'hs_code', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
        { id: 'country', displayName: 'country', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
        { id: 'limit',   displayName: 'limit',   required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false }
      ]
    }
  };
}

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
  console.log('\n=== Fix Tool: get_opportunities → market_trends ===');
  console.log(WRITE ? '[LIVE DEPLOY]' : '[DRY-RUN — pass --write to deploy]');
  if (!WRITE) { console.log('Run with --write to deploy.'); return; }

  // Find existing sub-wf
  const listR  = await apiReq('GET', '/workflows?limit=250');
  const allWfs = JSON.parse(listR.body).data || [];
  const exist  = allWfs.find(w => w.name === 'Tool: get_opportunities');
  if (!exist) { console.error('Sub-wf "Tool: get_opportunities" not found — run add-get-opportunities.js first'); return; }

  const r = await putWf(exist.id, {
    name: 'Tool: get_opportunities',
    nodes: SUB_WF_NODES,
    connections: SUB_WF_CONN,
    settings: { saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all' }
  });
  if (r.status >= 300) { console.error('Sub-wf PUT failed:', r.body?.slice(0, 300)); return; }
  console.log('Sub-wf updated:', exist.id);
  await activate(exist.id, false); await new Promise(r => setTimeout(r, 600)); await activate(exist.id, true);

  // Update brain node description + wfId
  const brain = await getWf(BRAIN_ID);
  const bn = brain.nodes.find(n => n.name === TOOL_NAME);
  if (!bn) { console.error('Brain node not found'); return; }
  bn.parameters = makeBrainNodeParams(exist.id);

  const br = await putWf(BRAIN_ID, { name: brain.name, nodes: brain.nodes, connections: brain.connections, settings: brain.settings });
  if (br.status >= 300) { console.error('Brain PUT failed:', br.body?.slice(0, 300)); return; }
  await activate(BRAIN_ID, false); await new Promise(r => setTimeout(r, 800)); await activate(BRAIN_ID, true);

  const rb = await getWf(BRAIN_ID); const rs = await getWf(exist.id);
  const ok1 = !!rs.nodes.find(n => n.name === 'Find Trends');
  const ok2 = !!rb.nodes.find(n => n.name === TOOL_NAME);
  console.log('market_trends node:', ok1 ? '✓' : '✗ (check sub-wf)');
  console.log('Brain node:', ok2 ? '✓' : '✗');
  if (ok1 && ok2) console.log('\n✅ DEPLOY SUCCESS — get_opportunities now queries market_trends (27k docs, wide HS coverage)');
})().catch(e => console.error('FATAL:', e.message));
