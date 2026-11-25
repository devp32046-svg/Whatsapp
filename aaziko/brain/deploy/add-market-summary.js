'use strict';
/*
 * add-market-summary.js
 * Creates Tool: get_market_summary sub-workflow + wires into Aaziko Brain.
 *
 * "HS 5201 cotton ka overall market kya hai?" — quick dashboard:
 *   total active buyers, top buyer countries, volume, value
 *
 * Usage:
 *   node aaziko/brain/deploy/add-market-summary.js          # dry-run
 *   node aaziko/brain/deploy/add-market-summary.js --write  # deploy live
 */
require('dotenv').config();
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');
const https = require('https');

const WRITE     = process.argv.includes('--write');
const BRAIN_ID  = 'w7no6uCJkz7lfaah';
const TOOL_NAME = 'get_market_summary';
const CS_CRED   = { mongoDb: { id: 'vL0izSZrMHn4Ukgc', name: 'Aaziko - common-service' } };

// ── Code: Parse Input ─────────────────────────────────────────────────────────
const PARSE_CODE = `
let inp = {};
try {
  inp = typeof $input.first().json === 'string'
    ? JSON.parse($input.first().json)
    : $input.first().json;
} catch(e) {}

var hs = String(inp.hs_code || inp.hs || inp.product || '').trim();

if (!/^[0-9]{2,10}$/.test(hs)) {
  return [{ json: { pipelineStr: '[]', hs: '', error: 'HS code zaroori hai (4-10 digits)' } }];
}

var hs6 = hs.slice(0, 6);
var matchFilter = {
  has_recent_activity: true,
  hs_codes: { $elemMatch: { $regex: '^' + hs6 } }
};

// Group by buyer_country to get per-country stats + totals
var pipeline = [
  { $match: matchFilter },
  { $group: {
    _id: '$buyer_country',
    buyerCount:     { $sum: 1 },
    totalShipments: { $sum: { $ifNull: ['$total_shipments', 0] } },
    totalValueUsd:  { $sum: { $ifNull: ['$total_value_usd',  0] } }
  }},
  { $sort: { buyerCount: -1 } },
  { $limit: 15 }
];

return [{ json: { pipelineStr: JSON.stringify(pipeline), hs: hs, hs6: hs6 } }];
`.trim();

// ── Code: Format Results ──────────────────────────────────────────────────────
const FORMAT_CODE = `
var ctx  = $('Parse Input').first().json;
var rows = $input.all().map(function(i) { return i.json; });

if (ctx.error) {
  return [{ json: { output: 'HS code dena zaroori hai. Example: "HS 5201 market summary" ya "cotton market overview".' } }];
}

if (!rows.length) {
  return [{ json: { output: 'HS ' + ctx.hs + ' ke liye koi active buyer data nahi mila.' } }];
}

// Aggregate totals from all country rows
var totalBuyers    = 0;
var totalShipments = 0;
var totalValueUsd  = 0;
for (var i = 0; i < rows.length; i++) {
  totalBuyers    += rows[i].buyerCount     || 0;
  totalShipments += rows[i].totalShipments || 0;
  totalValueUsd  += rows[i].totalValueUsd  || 0;
}

// Top 5 countries
var top5 = rows.slice(0, 5).map(function(r, i) {
  var pct = totalBuyers > 0 ? Math.round(100 * r.buyerCount / totalBuyers) : 0;
  var val = r.totalValueUsd > 0
    ? ' · $' + (r.totalValueUsd / 1000000).toFixed(0) + 'M'
    : '';
  return (i + 1) + '. ' + (r._id || 'Unknown') +
    ' — ' + r.buyerCount + ' buyers (' + pct + '%)' +
    ' · ' + (r.totalShipments || 0) + ' shipments' + val;
});

var totalValStr = totalValueUsd > 1000000000
  ? '$' + (totalValueUsd / 1000000000).toFixed(1) + 'B'
  : '$' + (totalValueUsd / 1000000).toFixed(0) + 'M';

return [{ json: {
  output: 'Market summary: HS ' + ctx.hs + ' (Aaziko active-buyer data)\\n' +
    '• Total active buyers: ' + totalBuyers.toLocaleString() + '\\n' +
    '• Total shipments:     ' + totalShipments.toLocaleString() + '\\n' +
    '• Total trade value:   ' + totalValStr + '\\n' +
    '• Countries active:    ' + rows.length + '\\n\\n' +
    'Top buyer countries:\\n' + top5.join('\\n') +
    '\\n\\nIs market ke actual buyers ya seasonal pattern ke liye puchein.'
} }];
`.trim();

// ── Code: Reply OK ────────────────────────────────────────────────────────────
const REPLY_CODE = `
var all = $input.all();
var out = '';
for (var i = 0; i < all.length; i++) {
  if (all[i].json && all[i].json.output) { out = all[i].json.output; break; }
}
return [{ json: { output: out || 'No market data available.' } }];
`.trim();

// ── Sub-workflow definition ───────────────────────────────────────────────────
const SUB_WF = {
  name: 'Tool: get_market_summary',
  settings: { saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all' },
  nodes: [
    {
      id: 'ms-trig', name: 'Execute Workflow Trigger',
      type: 'n8n-nodes-base.executeWorkflowTrigger',
      typeVersion: 1, position: [100, 300], parameters: {}
    },
    {
      id: 'ms-parse', name: 'Parse Input',
      type: 'n8n-nodes-base.code',
      typeVersion: 2, position: [340, 300],
      parameters: { jsCode: PARSE_CODE }
    },
    {
      id: 'ms-agg', name: 'Market Aggregate',
      type: 'n8n-nodes-base.mongoDb',
      typeVersion: 1, position: [580, 300],
      credentials: CS_CRED,
      parameters: {
        operation: 'aggregate',
        collection: 'buyer_summaries',
        query: '={{ $json.pipelineStr }}'
      }
    },
    {
      id: 'ms-fmt', name: 'Format Results',
      type: 'n8n-nodes-base.code',
      typeVersion: 2, position: [820, 300],
      parameters: { jsCode: FORMAT_CODE }
    },
    {
      id: 'ms-ok', name: 'Reply OK',
      type: 'n8n-nodes-base.code',
      typeVersion: 2, position: [1060, 300],
      parameters: { jsCode: REPLY_CODE }
    }
  ],
  connections: {
    'Execute Workflow Trigger': { main: [[{ node: 'Parse Input',       type: 'main', index: 0 }]] },
    'Parse Input':              { main: [[{ node: 'Market Aggregate',  type: 'main', index: 0 }]] },
    'Market Aggregate':         { main: [[{ node: 'Format Results',    type: 'main', index: 0 }]] },
    'Format Results':           { main: [[{ node: 'Reply OK',          type: 'main', index: 0 }]] }
  }
};

// ── Brain toolWorkflow node ───────────────────────────────────────────────────
function makeBrainNode(wfId) {
  return {
    id: 'az-ms-tool',
    name: TOOL_NAME,
    type: '@n8n/n8n-nodes-langchain.toolWorkflow',
    typeVersion: 2.2,
    position: [1340, 1340],
    parameters: {
      description:
        'Returns a quick MARKET OVERVIEW / DASHBOARD for a specific HS code — ' +
        'total active buyer count, total shipment volume, total trade value, ' +
        'and top buyer countries ranked by buyer count. ' +
        'Use when user asks: "HS 5201 market kaisa hai?", "cotton ka overall market overview", ' +
        '"kitne buyers hain globally?", "market size kya hai?", "top importing countries kaun hain?", ' +
        '"market summary", "market overview", "kitni demand hai?", "total buyers count". ' +
        'Requires an HS code (4-10 digits).',
      workflowId: {
        __rl: true, mode: 'id', value: wfId,
        cachedResultName: 'Tool: get_market_summary'
      },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          hs_code: "={{ $fromAI('hs_code', 'HS code 4-10 digits (e.g. 5201 for cotton, 4107 for leather). Required.', 'string', '') }}"
        },
        matchingColumns: [],
        schema: [
          { id: 'hs_code', displayName: 'hs_code', required: true, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false }
        ]
      }
    }
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function apiReq(method, ep, body) {
  return new Promise((res, rej) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = https.request({
      hostname: 'ai.cgpe.in', path: '/api/v1' + ep, method,
      headers: {
        'X-N8N-API-KEY': process.env.N8N_API_KEY,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': data.length } : {})
      }
    }, r => {
      const ch = []; r.on('data', c => ch.push(c));
      r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(ch).toString('utf8') }));
    });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  console.log('\n=== Add Tool: get_market_summary ===');
  console.log(WRITE ? '[LIVE DEPLOY]' : '[DRY-RUN — pass --write to deploy]');

  if (!WRITE) {
    console.log('\nSub-workflow:', SUB_WF.name);
    console.log('DB: common-service.buyer_summaries');
    console.log('\nSample queries:');
    console.log('  "HS 5201 cotton market overview"');
    console.log('  "leather (HS 4107) ka global market summary"');
    console.log('\nRun with --write to deploy.');
    return;
  }

  const listR  = await apiReq('GET', '/workflows?limit=250');
  const allWfs = JSON.parse(listR.body).data || [];
  const exist  = allWfs.find(w => w.name === SUB_WF.name);

  let subWfId;
  if (exist) {
    console.log('Sub-workflow exists:', exist.id, '— updating...');
    const r = await putWf(exist.id, {
      name: SUB_WF.name, nodes: SUB_WF.nodes,
      connections: SUB_WF.connections, settings: SUB_WF.settings
    });
    if (r.status >= 300) { console.error('PUT failed:', r.body?.slice(0, 300)); return; }
    subWfId = exist.id;
  } else {
    const r = await apiReq('POST', '/workflows', SUB_WF);
    const created = JSON.parse(r.body);
    if (!created.id) { console.error('Create failed:', r.body.slice(0, 300)); return; }
    subWfId = created.id;
    console.log('Created:', subWfId);
  }

  await activate(subWfId, false);
  await new Promise(r => setTimeout(r, 600));
  await activate(subWfId, true);
  console.log('Sub-workflow LIVE:', subWfId);

  console.log('Wiring into brain...');
  const brain = await getWf(BRAIN_ID);

  if (brain.nodes.find(n => n.name === TOOL_NAME)) {
    brain.nodes.find(n => n.name === TOOL_NAME).parameters = makeBrainNode(subWfId).parameters;
  } else {
    brain.nodes.push(makeBrainNode(subWfId));
    brain.connections[TOOL_NAME] = {
      ai_tool: [[{ node: 'Aaziko AI Brain', type: 'ai_tool', index: 0 }]]
    };
  }

  const br = await putWf(BRAIN_ID, {
    name: brain.name, nodes: brain.nodes,
    connections: brain.connections, settings: brain.settings
  });
  if (br.status >= 300) { console.error('Brain PUT failed:', br.body?.slice(0, 300)); return; }

  await activate(BRAIN_ID, false);
  await new Promise(r => setTimeout(r, 800));
  await activate(BRAIN_ID, true);

  const rbBrain = await getWf(BRAIN_ID);
  const rbSub   = await getWf(subWfId);

  const subOk   = !!rbSub.nodes.find(n => n.name === 'Market Aggregate');
  const brainOk = !!rbBrain.nodes.find(n => n.name === TOOL_NAME);
  const wired   = rbBrain.connections[TOOL_NAME]?.ai_tool?.[0]?.[0]?.node === 'Aaziko AI Brain';

  console.log('\nRead-back:');
  console.log('  Sub-wf "Market Aggregate" node:', subOk   ? '✓' : '✗ MISSING');
  console.log('  Brain has tool node:',            brainOk ? '✓' : '✗ MISSING');
  console.log('  Tool wired to agent:',            wired   ? '✓' : '✗ MISSING');
  console.log('  Brain total nodes:', rbBrain.nodes.length);
  console.log('  Sub-wf ID:', subWfId);

  if (subOk && brainOk && wired) {
    console.log('\n✅ DEPLOY SUCCESS');
    console.log('Test: "HS 5201 cotton market overview"');
  } else {
    console.log('\n✗ Deploy incomplete — check above');
  }
})().catch(e => console.error('FATAL:', e.message));
