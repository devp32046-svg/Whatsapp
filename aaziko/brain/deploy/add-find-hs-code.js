'use strict';
/*
 * add-find-hs-code.js
 * Tool: find_hs_code — search HS codes by product description keyword
 * 426K docs in hscodes collection.
 *
 * Usage:
 *   node aaziko/brain/deploy/add-find-hs-code.js          # dry-run
 *   node aaziko/brain/deploy/add-find-hs-code.js --write  # deploy
 */
require('dotenv').config();
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');
const https = require('https');

const WRITE     = process.argv.includes('--write');
const BRAIN_ID  = 'w7no6uCJkz7lfaah';
const TOOL_NAME = 'find_hs_code';
const CS_CRED   = { mongoDb: { id: 'vL0izSZrMHn4Ukgc', name: 'Aaziko - common-service' } };

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

// Split into words, build AND regex
var words = query.split(/\\s+/).filter(function(w) { return w.length > 1; });
var matchFilter = { status: 'active' };
if (words.length > 1) {
  matchFilter['$and'] = words.map(function(w) {
    return { description: { $regex: w, $options: 'i' } };
  });
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
  return [{ json: { output: 'Product ka naam ya description dena zaroori hai. Example: "cotton raw material HS code" ya "leather HS code".' } }];
}

if (!rows.length) {
  return [{ json: { output: '"' + ctx.query + '" ke liye koi HS code nahi mila. Koi aur keyword try karein.' } }];
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

const SUB_WF = {
  name: 'Tool: find_hs_code',
  settings: { saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all' },
  nodes: [
    { id: 'hc-trig',  name: 'Execute Workflow Trigger', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1, position: [100, 300], parameters: {} },
    { id: 'hc-parse', name: 'Parse Input',   type: 'n8n-nodes-base.code',    typeVersion: 2, position: [340, 300],  parameters: { jsCode: PARSE_CODE } },
    { id: 'hc-find',  name: 'Find HS Codes', type: 'n8n-nodes-base.mongoDb', typeVersion: 1, position: [580, 300],
      credentials: CS_CRED,
      parameters: { operation: 'aggregate', collection: 'hscodes', query: '={{ $json.pipelineStr }}' }
    },
    { id: 'hc-fmt',   name: 'Format Results',type: 'n8n-nodes-base.code',    typeVersion: 2, position: [820, 300],  parameters: { jsCode: FORMAT_CODE } },
    { id: 'hc-ok',    name: 'Reply OK',       type: 'n8n-nodes-base.code',    typeVersion: 2, position: [1060, 300], parameters: { jsCode: REPLY_CODE } }
  ],
  connections: {
    'Execute Workflow Trigger': { main: [[{ node: 'Parse Input',   type: 'main', index: 0 }]] },
    'Parse Input':              { main: [[{ node: 'Find HS Codes', type: 'main', index: 0 }]] },
    'Find HS Codes':            { main: [[{ node: 'Format Results',type: 'main', index: 0 }]] },
    'Format Results':           { main: [[{ node: 'Reply OK',      type: 'main', index: 0 }]] }
  }
};

function makeBrainNode(wfId) {
  return {
    id: 'az-hc-tool', name: TOOL_NAME,
    type: '@n8n/n8n-nodes-langchain.toolWorkflow', typeVersion: 2.2,
    position: [1340, 1900],
    parameters: {
      description:
        'Finds HS CODES for a product — lookup the correct Harmonized System tariff code from a product description or keyword. ' +
        'Use when user wants HS CODE for a product: ' +
        '"cotton ka HS code kya hai?", "leather gloves ka HS code batao", ' +
        '"HS code dhundhna hai", "tariff code for rice", "product code kya hai?", ' +
        '"what is the HS code for X?", "classification code", "customs code". ' +
        'Returns list of matching HS codes with their official descriptions.',
      workflowId: { __rl: true, mode: 'id', value: wfId, cachedResultName: 'Tool: find_hs_code' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          query: "={{ $fromAI('query', 'Product name or description keywords to search HS codes (e.g. \"cotton raw\", \"leather gloves\", \"rice husked\")', 'string', '') }}",
          limit: "={{ $fromAI('limit', 'Max HS codes to return (default 10)', 'number', 10) }}"
        },
        matchingColumns: [],
        schema: [
          { id: 'query', displayName: 'query', required: true,  defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'limit', displayName: 'limit', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false }
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
  console.log('\n=== Add Tool: find_hs_code ===');
  console.log(WRITE ? '[LIVE DEPLOY]' : '[DRY-RUN — pass --write to deploy]');
  if (!WRITE) { console.log('Run with --write to deploy.'); return; }

  const listR  = await apiReq('GET', '/workflows?limit=250');
  const allWfs = JSON.parse(listR.body).data || [];
  const exist  = allWfs.find(w => w.name === SUB_WF.name);

  let subWfId;
  if (exist) {
    const r = await putWf(exist.id, { name: SUB_WF.name, nodes: SUB_WF.nodes, connections: SUB_WF.connections, settings: SUB_WF.settings });
    if (r.status >= 300) { console.error('PUT failed:', r.body?.slice(0, 300)); return; }
    subWfId = exist.id; console.log('Updated sub-wf:', subWfId);
  } else {
    const r = await apiReq('POST', '/workflows', SUB_WF);
    const c = JSON.parse(r.body);
    if (!c.id) { console.error('Create failed:', r.body.slice(0, 300)); return; }
    subWfId = c.id; console.log('Created:', subWfId);
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
  const ok1 = !!rs.nodes.find(n => n.name === 'Find HS Codes');
  const ok2 = !!rb.nodes.find(n => n.name === TOOL_NAME);
  const ok3 = rb.connections[TOOL_NAME]?.ai_tool?.[0]?.[0]?.node === 'Aaziko AI Brain';
  console.log('Sub-wf node:', ok1 ? '✓' : '✗'); console.log('Brain node:', ok2 ? '✓' : '✗'); console.log('Wired:', ok3 ? '✓' : '✗');
  console.log('Brain nodes:', rb.nodes.length, '| Sub-wf:', subWfId);
  if (ok1 && ok2 && ok3) console.log('\n✅ DEPLOY SUCCESS');
})().catch(e => console.error('FATAL:', e.message));
