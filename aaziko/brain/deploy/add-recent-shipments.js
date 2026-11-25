'use strict';
/*
 * add-recent-shipments.js
 * Tool: get_recent_shipments — actual shipment records from standard_port_data
 * Filter by buyer name, HS code prefix, or destination country.
 *
 * Usage:
 *   node aaziko/brain/deploy/add-recent-shipments.js          # dry-run
 *   node aaziko/brain/deploy/add-recent-shipments.js --write  # deploy
 */
require('dotenv').config();
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');
const https = require('https');

const WRITE     = process.argv.includes('--write');
const BRAIN_ID  = 'w7no6uCJkz7lfaah';
const TOOL_NAME = 'get_recent_shipments';
const CS_CRED   = { mongoDb: { id: 'vL0izSZrMHn4Ukgc', name: 'Aaziko - common-service' } };

const PARSE_CODE = `
let inp = {};
try {
  inp = typeof $input.first().json === 'string'
    ? JSON.parse($input.first().json)
    : $input.first().json;
} catch(e) {}

var buyer   = String(inp.buyer_name || inp.buyer || '').trim();
var hs      = String(inp.hs_code || inp.hs || '').trim();
var country = String(inp.country || inp.destination || '').trim();
var limit   = Math.min(parseInt(inp.limit || 10, 10), 20);

if (!buyer && !hs && !country) {
  return [{ json: { pipelineStr: '[]', buyer, hs, country, error: 'buyer_name, hs_code, ya country mein se koi ek zaroori hai' } }];
}

var matchFilter = {};
if (buyer)   matchFilter['BUYER_NAME']           = { $regex: buyer, $options: 'i' };
if (hs)      matchFilter['HS_CODE']              = { $regex: '^' + hs.slice(0, 6) };
if (country) matchFilter['DESTINATION_COUNTRY']  = { $regex: country, $options: 'i' };

var pipeline = [
  { $match: matchFilter },
  { $sort: { uploaded_at: -1 } },
  { $limit: limit },
  { $project: {
    BUYER_NAME:           1,
    DATE:                 1,
    HS_CODE:              1,
    ORIGIN_COUNTRY:       1,
    DESTINATION_COUNTRY:  1,
    FOB_VALUE_USD:        1,
    PRODUCT_DESCRIPTION:  1,
    _id: 0
  }}
];

return [{ json: { pipelineStr: JSON.stringify(pipeline), buyer, hs, country, limit } }];
`.trim();

const FORMAT_CODE = `
var ctx  = $('Parse Input').first().json;
var rows = $input.all().map(function(i) { return i.json; });

if (ctx.error) {
  return [{ json: { output: 'buyer_name, hs_code, ya destination country mein se ek dena zaroori hai.' } }];
}

if (!rows.length) {
  var msg = 'Koi shipment record nahi mila';
  if (ctx.buyer)   msg += ' — buyer: ' + ctx.buyer;
  if (ctx.hs)      msg += ' — HS: ' + ctx.hs;
  if (ctx.country) msg += ' — country: ' + ctx.country;
  return [{ json: { output: msg + '.' } }];
}

var lines = rows.map(function(r, i) {
  var buyer  = (r.BUYER_NAME || '?').slice(0, 40);
  var date   = String(r.DATE || '').split(' ')[0] || '?';
  var hs     = r.HS_CODE || '?';
  var origin = r.ORIGIN_COUNTRY ? ' from ' + r.ORIGIN_COUNTRY : '';
  var dest   = r.DESTINATION_COUNTRY ? ' → ' + r.DESTINATION_COUNTRY : '';
  var val    = r.FOB_VALUE_USD > 0
    ? ' · $' + (r.FOB_VALUE_USD / 1000).toFixed(1) + 'K'
    : '';
  var prod   = r.PRODUCT_DESCRIPTION
    ? ' (' + String(r.PRODUCT_DESCRIPTION).slice(0, 35) + ')'
    : '';
  return (i + 1) + '. ' + buyer + ' · ' + date + ' · HS ' + hs + origin + dest + val + prod;
});

var header = 'Recent shipments';
if (ctx.buyer)   header += ' — buyer: ' + ctx.buyer;
if (ctx.hs)      header += ' — HS: ' + ctx.hs;
if (ctx.country) header += ' — to: ' + ctx.country;

return [{ json: {
  output: header + ' (standard_port_data):\\n' + lines.join('\\n') +
    '\\n\\nKisi specific shipment ya buyer ki zyada detail chahiye?'
} }];
`.trim();

const REPLY_CODE = `
var all = $input.all();
var out = '';
for (var i = 0; i < all.length; i++) {
  if (all[i].json && all[i].json.output) { out = all[i].json.output; break; }
}
return [{ json: { output: out || 'No shipment records found.' } }];
`.trim();

const SUB_WF = {
  name: 'Tool: get_recent_shipments',
  settings: { saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all' },
  nodes: [
    { id: 'rs-trig',  name: 'Execute Workflow Trigger', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1, position: [100, 300], parameters: {} },
    { id: 'rs-parse', name: 'Parse Input',   type: 'n8n-nodes-base.code',    typeVersion: 2, position: [340, 300],  parameters: { jsCode: PARSE_CODE } },
    { id: 'rs-find',  name: 'Find Shipments',type: 'n8n-nodes-base.mongoDb', typeVersion: 1, position: [580, 300],
      credentials: CS_CRED,
      parameters: { operation: 'aggregate', collection: 'standard_port_data', query: '={{ $json.pipelineStr }}' }
    },
    { id: 'rs-fmt',   name: 'Format Results',type: 'n8n-nodes-base.code',    typeVersion: 2, position: [820, 300],  parameters: { jsCode: FORMAT_CODE } },
    { id: 'rs-ok',    name: 'Reply OK',       type: 'n8n-nodes-base.code',    typeVersion: 2, position: [1060, 300], parameters: { jsCode: REPLY_CODE } }
  ],
  connections: {
    'Execute Workflow Trigger': { main: [[{ node: 'Parse Input',    type: 'main', index: 0 }]] },
    'Parse Input':              { main: [[{ node: 'Find Shipments', type: 'main', index: 0 }]] },
    'Find Shipments':           { main: [[{ node: 'Format Results', type: 'main', index: 0 }]] },
    'Format Results':           { main: [[{ node: 'Reply OK',       type: 'main', index: 0 }]] }
  }
};

function makeBrainNode(wfId) {
  return {
    id: 'az-rs-tool', name: TOOL_NAME,
    type: '@n8n/n8n-nodes-langchain.toolWorkflow', typeVersion: 2.2,
    position: [1340, 1620],
    parameters: {
      description:
        'Returns ACTUAL SHIPMENT RECORDS from trade data — real transactions showing buyer name, date, HS code, origin, destination, and value. ' +
        'Use when user wants to see REAL RECENT TRADE ACTIVITY: ' +
        '"IKEA ki recent shipments kya hain?", "Vietnam ko cotton ki latest shipments", ' +
        '"HS 5201 ke recent transactions", "kaun kaun ne recently bheja?", ' +
        '"latest trade records", "recent exports/imports", "shipment history", ' +
        '"recent deals", "trade activity". ' +
        'Requires at least one of: buyer_name, hs_code, or destination country.',
      workflowId: { __rl: true, mode: 'id', value: wfId, cachedResultName: 'Tool: get_recent_shipments' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          buyer_name:  "={{ $fromAI('buyer_name',  'Company/buyer name to search (partial match ok). Leave empty if filtering by HS or country.', 'string', '') }}",
          hs_code:     "={{ $fromAI('hs_code',     'HS code 4-10 digits to filter shipments. Optional.', 'string', '') }}",
          country:     "={{ $fromAI('country',     'Destination country name (e.g. VIETNAM, USA). Optional.', 'string', '') }}",
          limit:       "={{ $fromAI('limit',       'Max records to return (default 10, max 20)', 'number', 10) }}"
        },
        matchingColumns: [],
        schema: [
          { id: 'buyer_name', displayName: 'buyer_name', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'hs_code',    displayName: 'hs_code',    required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'country',    displayName: 'country',    required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'limit',      displayName: 'limit',      required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false }
        ]
      }
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
  console.log('\n=== Add Tool: get_recent_shipments ===');
  console.log(WRITE ? '[LIVE DEPLOY]' : '[DRY-RUN — pass --write to deploy]');
  if (!WRITE) { console.log('Run with --write to deploy.'); return; }

  const listR  = await apiReq('GET', '/workflows?limit=250');
  const allWfs = JSON.parse(listR.body).data || [];
  const exist  = allWfs.find(w => w.name === SUB_WF.name);

  let subWfId;
  if (exist) {
    const r = await putWf(exist.id, { name: SUB_WF.name, nodes: SUB_WF.nodes, connections: SUB_WF.connections, settings: SUB_WF.settings });
    if (r.status >= 300) { console.error('PUT failed:', r.body?.slice(0, 300)); return; }
    subWfId = exist.id;
    console.log('Updated sub-wf:', subWfId);
  } else {
    const r = await apiReq('POST', '/workflows', SUB_WF);
    const c = JSON.parse(r.body);
    if (!c.id) { console.error('Create failed:', r.body.slice(0, 300)); return; }
    subWfId = c.id;
    console.log('Created:', subWfId);
  }
  await activate(subWfId, false); await new Promise(r => setTimeout(r, 600)); await activate(subWfId, true);

  const brain = await getWf(BRAIN_ID);
  if (brain.nodes.find(n => n.name === TOOL_NAME)) {
    brain.nodes.find(n => n.name === TOOL_NAME).parameters = makeBrainNode(subWfId).parameters;
  } else {
    brain.nodes.push(makeBrainNode(subWfId));
    brain.connections[TOOL_NAME] = { ai_tool: [[{ node: 'Aaziko AI Brain', type: 'ai_tool', index: 0 }]] };
  }
  const br = await putWf(BRAIN_ID, { name: brain.name, nodes: brain.nodes, connections: brain.connections, settings: brain.settings });
  if (br.status >= 300) { console.error('Brain PUT failed:', br.body?.slice(0, 300)); return; }
  await activate(BRAIN_ID, false); await new Promise(r => setTimeout(r, 800)); await activate(BRAIN_ID, true);

  const rb = await getWf(BRAIN_ID); const rs = await getWf(subWfId);
  const ok1 = !!rs.nodes.find(n => n.name === 'Find Shipments');
  const ok2 = !!rb.nodes.find(n => n.name === TOOL_NAME);
  const ok3 = rb.connections[TOOL_NAME]?.ai_tool?.[0]?.[0]?.node === 'Aaziko AI Brain';
  console.log('Sub-wf node:', ok1 ? '✓' : '✗'); console.log('Brain node:', ok2 ? '✓' : '✗'); console.log('Wired:', ok3 ? '✓' : '✗');
  console.log('Brain nodes:', rb.nodes.length, '| Sub-wf:', subWfId);
  if (ok1 && ok2 && ok3) console.log('\n✅ DEPLOY SUCCESS');
})().catch(e => console.error('FATAL:', e.message));
