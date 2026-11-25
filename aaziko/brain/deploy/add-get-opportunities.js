'use strict';
/*
 * add-get-opportunities.js
 * Tool: get_opportunities — scored buyer opportunities from stage1_opportunities
 * Returns AI-scored trade leads: buyer name, country, HS, score, brief.
 *
 * Usage:
 *   node aaziko/brain/deploy/add-get-opportunities.js          # dry-run
 *   node aaziko/brain/deploy/add-get-opportunities.js --write  # deploy
 */
require('dotenv').config();
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');
const https = require('https');

const WRITE     = process.argv.includes('--write');
const BRAIN_ID  = 'w7no6uCJkz7lfaah';
const TOOL_NAME = 'get_opportunities';
const CS_CRED   = { mongoDb: { id: 'vL0izSZrMHn4Ukgc', name: 'Aaziko - common-service' } };

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

var matchFilter = { list_status: 'released', scored: true };
if (hs)      matchFilter['hs6']     = { $regex: '^' + hs.slice(0, 6) };
if (country) matchFilter['country'] = { $regex: country, $options: 'i' };

var pipeline = [
  { $match: matchFilter },
  { $sort: { score: -1 } },
  { $limit: limit },
  { $project: {
    buyer_name:  1,
    country:     1,
    hs6:         1,
    score_display: 1,
    tier_live:   1,
    segment:     1,
    brief:       1,
    _id: 0
  }}
];

return [{ json: { pipelineStr: JSON.stringify(pipeline), hs, country, limit } }];
`.trim();

const FORMAT_CODE = `
var ctx  = $('Parse Input').first().json;
var rows = $input.all().map(function(i) { return i.json; });

if (!rows.length) {
  var msg = 'Koi scored opportunity nahi mili';
  if (ctx.hs)      msg += ' — HS: ' + ctx.hs;
  if (ctx.country) msg += ' — country: ' + ctx.country;
  return [{ json: { output: msg + '. Koi specific HS code ya country try karein.' } }];
}

var lines = rows.map(function(r, i) {
  var name    = (r.buyer_name || '?').slice(0, 45);
  var score   = r.score_display != null ? ' · score ' + r.score_display : '';
  var tier    = r.tier_live  ? ' · ' + r.tier_live  : '';
  var seg     = r.segment    ? ' · seg-' + r.segment : '';
  var ctry    = r.country    ? ' · ' + r.country     : '';
  var hs      = r.hs6        ? ' · HS ' + r.hs6      : '';
  var brief   = r.brief      ? '\\n   → ' + String(r.brief).slice(0, 120) : '';
  return (i + 1) + '. ' + name + score + tier + seg + ctry + hs + brief;
});

var header = 'Top scored trade opportunities (stage1_opportunities)';
if (ctx.hs)      header += ' — HS ' + ctx.hs;
if (ctx.country) header += ' in ' + ctx.country;

return [{ json: {
  output: header + ':\\n' + lines.join('\\n') +
    '\\n\\nKisi specific buyer ki profile ya update chahiye?'
} }];
`.trim();

const REPLY_CODE = `
var all = $input.all();
var out = '';
for (var i = 0; i < all.length; i++) {
  if (all[i].json && all[i].json.output) { out = all[i].json.output; break; }
}
return [{ json: { output: out || 'No opportunity data available.' } }];
`.trim();

const SUB_WF = {
  name: 'Tool: get_opportunities',
  settings: { saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all' },
  nodes: [
    { id: 'op-trig',  name: 'Execute Workflow Trigger', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1, position: [100, 300], parameters: {} },
    { id: 'op-parse', name: 'Parse Input',      type: 'n8n-nodes-base.code',    typeVersion: 2, position: [340, 300],  parameters: { jsCode: PARSE_CODE } },
    { id: 'op-find',  name: 'Find Opportunities',type: 'n8n-nodes-base.mongoDb', typeVersion: 1, position: [580, 300],
      credentials: CS_CRED,
      parameters: { operation: 'aggregate', collection: 'stage1_opportunities', query: '={{ $json.pipelineStr }}' }
    },
    { id: 'op-fmt',   name: 'Format Results',   type: 'n8n-nodes-base.code',    typeVersion: 2, position: [820, 300],  parameters: { jsCode: FORMAT_CODE } },
    { id: 'op-ok',    name: 'Reply OK',          type: 'n8n-nodes-base.code',    typeVersion: 2, position: [1060, 300], parameters: { jsCode: REPLY_CODE } }
  ],
  connections: {
    'Execute Workflow Trigger': { main: [[{ node: 'Parse Input',       type: 'main', index: 0 }]] },
    'Parse Input':              { main: [[{ node: 'Find Opportunities',type: 'main', index: 0 }]] },
    'Find Opportunities':       { main: [[{ node: 'Format Results',    type: 'main', index: 0 }]] },
    'Format Results':           { main: [[{ node: 'Reply OK',          type: 'main', index: 0 }]] }
  }
};

function makeBrainNode(wfId) {
  return {
    id: 'az-op-tool', name: TOOL_NAME,
    type: '@n8n/n8n-nodes-langchain.toolWorkflow', typeVersion: 2.2,
    position: [1340, 1760],
    parameters: {
      description:
        'Returns AI-SCORED TRADE OPPORTUNITIES — pre-analyzed buyer leads ranked by opportunity score with AI brief. ' +
        'Use when user wants OPPORTUNITIES, LEADS, or INTELLIGENCE: ' +
        '"Cotton ke liye top trade opportunities batao", "koi naya business lead hai?", ' +
        '"scored leads chahiye", "AI ne kaun sa buyer recommend kiya?", ' +
        '"top opportunities in Germany", "best leads for HS 5201", ' +
        '"trade intelligence", "kahan invest karein?", "high score buyers kaun hain?". ' +
        'Returns buyer name, score, tier, country, HS code and AI brief.',
      workflowId: { __rl: true, mode: 'id', value: wfId, cachedResultName: 'Tool: get_opportunities' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          hs_code: "={{ $fromAI('hs_code',  'HS code 4-6 digits to filter opportunities. Optional.', 'string', '') }}",
          country: "={{ $fromAI('country',  'Destination/buyer country name. Optional.', 'string', '') }}",
          limit:   "={{ $fromAI('limit',    'Max opportunities to return (default 10)', 'number', 10) }}"
        },
        matchingColumns: [],
        schema: [
          { id: 'hs_code', displayName: 'hs_code', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'country', displayName: 'country', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'limit',   displayName: 'limit',   required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false }
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
  console.log('\n=== Add Tool: get_opportunities ===');
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
  const ok1 = !!rs.nodes.find(n => n.name === 'Find Opportunities');
  const ok2 = !!rb.nodes.find(n => n.name === TOOL_NAME);
  const ok3 = rb.connections[TOOL_NAME]?.ai_tool?.[0]?.[0]?.node === 'Aaziko AI Brain';
  console.log('Sub-wf node:', ok1 ? '✓' : '✗'); console.log('Brain node:', ok2 ? '✓' : '✗'); console.log('Wired:', ok3 ? '✓' : '✗');
  console.log('Brain nodes:', rb.nodes.length, '| Sub-wf:', subWfId);
  if (ok1 && ok2 && ok3) console.log('\n✅ DEPLOY SUCCESS');
})().catch(e => console.error('FATAL:', e.message));
