'use strict';
/*
 * add-news-opportunities.js
 * Creates Tool: news_opportunities sub-workflow + wires into Aaziko Brain.
 *
 * Purpose: "News se" buyer finder (Flow 3) — find hot trade corridors from
 * active buyer data in common-service.buyer_summaries.
 * Groups by HS code + buyer_country, sorts by shipment volume.
 *
 * Usage:
 *   node aaziko/brain/deploy/add-news-opportunities.js          # dry-run / verify
 *   node aaziko/brain/deploy/add-news-opportunities.js --write  # deploy live
 */
require('dotenv').config();
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');
const https = require('https');

const WRITE     = process.argv.includes('--write');
const BRAIN_ID  = 'w7no6uCJkz7lfaah';
const TOOL_NAME = 'get_trade_opportunities';
const CS_CRED   = { mongoDb: { id: 'vL0izSZrMHn4Ukgc', name: 'Aaziko - common-service' } };

// ── Code: Parse Input ─────────────────────────────────────────────────────────
const PARSE_CODE = `
let inp = {};
try {
  inp = typeof $input.first().json === 'string'
    ? JSON.parse($input.first().json)
    : $input.first().json;
} catch(e) {}

var query   = String(inp.query || inp.product || inp.hs_code || inp.hs || '').trim();
var country = String(inp.country || '').trim();
var limit   = Math.min(parseInt(inp.limit || 10, 10), 20);

var pipeline = [];

// Always filter to recent-activity buyers first (reduces 5.6M → manageable set)
var matchFilter = { has_recent_activity: true };
if (/^[0-9]{2,10}$/.test(query)) {
  // HS code filter
  matchFilter['hs_codes'] = { $elemMatch: { $regex: '^' + query.slice(0, 6) } };
} else if (query.length > 2) {
  // Keyword: try buyer_name first (faster — indexed), not product_descriptions
  matchFilter['buyer_name'] = { $regex: query, $options: 'i' };
}
if (country) {
  matchFilter['buyer_country'] = { $regex: country, $options: 'i' };
}
pipeline.push({ $match: matchFilter });

// Unwind hs_codes to group per corridor
pipeline.push({ $unwind: '$hs_codes' });

// Group by HS + country → corridor stats
pipeline.push({
  $group: {
    _id: { hs: '$hs_codes', country: '$buyer_country' },
    buyerCount:    { $sum: 1 },
    totalShipments:{ $sum: { $ifNull: ['$total_shipments', 0] } },
    totalValueUsd: { $sum: { $ifNull: ['$total_value_usd',  0] } }
  }
});

// Sort by shipment volume (most active corridors first)
pipeline.push({ $sort: { totalShipments: -1, buyerCount: -1 } });
pipeline.push({ $limit: limit });

return [{ json: { pipelineStr: JSON.stringify(pipeline), query, country, limit } }];
`.trim();

// ── Code: Format Results ──────────────────────────────────────────────────────
const FORMAT_CODE = `
var ctx  = $('Parse Input').first().json;
var rows = $input.all().map(function(i) { return i.json; });

if (!rows.length) {
  var noMsg = 'Koi active trade corridor nahi mila';
  if (ctx.query)   noMsg += ' "' + ctx.query + '" ke liye';
  if (ctx.country) noMsg += ', ' + ctx.country + ' mein';
  return [{ json: { output: noMsg + '. Koi specific HS code ya country dena chahein?' } }];
}

var lines = rows.map(function(r, i) {
  var hs    = (r._id && r._id.hs)      || '?';
  var ctry  = (r._id && r._id.country) || '?';
  var ships = r.totalShipments || 0;
  var buyers= r.buyerCount     || 0;
  var val   = r.totalValueUsd > 0
    ? ' · $' + (r.totalValueUsd / 1000000).toFixed(1) + 'M'
    : '';
  return (i + 1) + '. HS ' + hs + ' → ' + ctry +
    ' — ' + ships + ' shipments, ' + buyers + ' active buyers' + val;
});

var header = 'Top active trade corridors (Aaziko buyer data)';
if (ctx.query)   header += ' — HS/product: ' + ctx.query;
if (ctx.country) header += ', country: ' + ctx.country;

return [{ json: {
  output: header + ':\\n' + lines.join('\\n') +
    '\\n\\nIn corridors ke buyers ya opportunities ke baare mein jaanna chahein? ' +
    'Specific HS code aur desh ke saath puchein.'
} }];
`.trim();

// ── Code: Reply ───────────────────────────────────────────────────────────────
const REPLY_CODE = `
var all = $input.all();
var out = '';
for (var i = 0; i < all.length; i++) {
  if (all[i].json && all[i].json.output) { out = all[i].json.output; break; }
}
return [{ json: { output: out || 'No results.' } }];
`.trim();

// ── Sub-workflow definition ───────────────────────────────────────────────────
const SUB_WF = {
  name: 'Tool: news_opportunities',
  settings: { saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all' },
  nodes: [
    {
      id: 'no-trig', name: 'Execute Workflow Trigger',
      type: 'n8n-nodes-base.executeWorkflowTrigger',
      typeVersion: 1, position: [100, 300], parameters: {}
    },
    {
      id: 'no-parse', name: 'Parse Input',
      type: 'n8n-nodes-base.code',
      typeVersion: 2, position: [340, 300],
      parameters: { jsCode: PARSE_CODE }
    },
    {
      id: 'no-find', name: 'Find Corridors',
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
      id: 'no-fmt', name: 'Format Results',
      type: 'n8n-nodes-base.code',
      typeVersion: 2, position: [820, 300],
      parameters: { jsCode: FORMAT_CODE }
    },
    {
      id: 'no-ok', name: 'Reply OK',
      type: 'n8n-nodes-base.code',
      typeVersion: 2, position: [1060, 300],
      parameters: { jsCode: REPLY_CODE }
    }
  ],
  connections: {
    'Execute Workflow Trigger': { main: [[{ node: 'Parse Input',      type: 'main', index: 0 }]] },
    'Parse Input':              { main: [[{ node: 'Find Corridors',   type: 'main', index: 0 }]] },
    'Find Corridors':           { main: [[{ node: 'Format Results',   type: 'main', index: 0 }]] },
    'Format Results':           { main: [[{ node: 'Reply OK',         type: 'main', index: 0 }]] }
  }
};

// ── Brain toolWorkflow node ───────────────────────────────────────────────────
function makeBrainNode(wfId) {
  return {
    id: 'az-no-tool',
    name: TOOL_NAME,
    type: '@n8n/n8n-nodes-langchain.toolWorkflow',
    typeVersion: 2.2,
    position: [1340, 920],
    parameters: {
      description:
        'Find hot trade corridors and market opportunities from Aaziko buyer data. ' +
        'Returns top HS code + country combinations ranked by shipment volume and buyer count. ' +
        'Use when user asks: "koi naya mauka batao", "trade news kya hai", "kaunsa market active hai", ' +
        '"latest opportunities", "export ideas", "kahan demand hai", "hot corridors".',
      workflowId: {
        __rl: true, mode: 'id', value: wfId,
        cachedResultName: 'Tool: news_opportunities'
      },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          query:   "={{ $fromAI('query',   'HS code (4-10 digits) or product keyword. Leave empty for general top corridors.', 'string', '') }}",
          country: "={{ $fromAI('country', 'Buyer country name or ISO code. Leave empty for all countries.', 'string', '') }}",
          limit:   "={{ $fromAI('limit',   'Max corridors to return (default 10, max 20)', 'number', 10) }}"
        },
        matchingColumns: [],
        schema: [
          { id: 'query',   displayName: 'query',   required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'country', displayName: 'country', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'limit',   displayName: 'limit',   required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false }
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
  console.log('\n=== Add Tool: get_trade_opportunities (news_opportunities) ===');
  console.log(WRITE ? '[LIVE DEPLOY]' : '[DRY-RUN — pass --write to deploy]');

  if (!WRITE) {
    console.log('\nSub-workflow:', SUB_WF.name);
    console.log('Nodes:', SUB_WF.nodes.map(n => n.name).join(' → '));
    console.log('DB: common-service.buyer_summaries');
    console.log('Credential: vL0izSZrMHn4Ukgc (Aaziko - common-service)');
    console.log('Brain: add toolWorkflow at position [1340, 920]');
    console.log('\nRun with --write to deploy.');
    return;
  }

  // ── 1. Create / update sub-workflow ─────────────────────────────────────────
  const listR   = await apiReq('GET', '/workflows?limit=250');
  const allWfs  = JSON.parse(listR.body).data || [];
  const existing = allWfs.find(w => w.name === SUB_WF.name);

  let subWfId;
  if (existing) {
    console.log('Sub-workflow exists:', existing.id, '— updating...');
    const r = await putWf(existing.id, {
      name: SUB_WF.name, nodes: SUB_WF.nodes,
      connections: SUB_WF.connections, settings: SUB_WF.settings
    });
    console.log('PUT status:', r.status);
    if (r.status >= 300) { console.error('PUT failed:', r.body?.slice(0, 300)); return; }
    subWfId = existing.id;
  } else {
    console.log('Creating sub-workflow...');
    const r = await apiReq('POST', '/workflows', SUB_WF);
    console.log('POST status:', r.status);
    const created = JSON.parse(r.body);
    if (!created.id) { console.error('Create failed:', r.body.slice(0, 300)); return; }
    subWfId = created.id;
    console.log('Created:', subWfId);
  }

  await activate(subWfId, false);
  await new Promise(r => setTimeout(r, 600));
  await activate(subWfId, true);
  console.log('Sub-workflow LIVE:', subWfId);

  // ── 2. Wire into brain ───────────────────────────────────────────────────────
  console.log('\nWiring into brain...');
  const brain = await getWf(BRAIN_ID);
  console.log('Brain nodes before:', brain.nodes.length);

  if (brain.nodes.find(n => n.name === TOOL_NAME)) {
    console.log('Tool already in brain — updating wfId...');
    brain.nodes.find(n => n.name === TOOL_NAME).parameters.workflowId.value = subWfId;
  } else {
    brain.nodes.push(makeBrainNode(subWfId));
    brain.connections[TOOL_NAME] = {
      ai_tool: [[{ node: 'Aaziko AI Brain', type: 'ai_tool', index: 0 }]]
    };
    console.log('Added toolWorkflow node. Brain nodes now:', brain.nodes.length);
  }

  const br = await putWf(BRAIN_ID, {
    name: brain.name, nodes: brain.nodes,
    connections: brain.connections, settings: brain.settings
  });
  console.log('Brain PUT status:', br.status);
  if (br.status >= 300) {
    console.error('Brain PUT failed:', br.body?.slice(0, 300));
    return;
  }

  await activate(BRAIN_ID, false);
  await new Promise(r => setTimeout(r, 800));
  await activate(BRAIN_ID, true);

  // ── 3. Read-back verify ──────────────────────────────────────────────────────
  const rbBrain = await getWf(BRAIN_ID);
  const rbSub   = await getWf(subWfId);

  const subOk   = !!rbSub.nodes.find(n => n.name === 'Find Corridors');
  const brainOk = !!rbBrain.nodes.find(n => n.name === TOOL_NAME);
  const wired   = rbBrain.connections[TOOL_NAME]?.ai_tool?.[0]?.[0]?.node === 'Aaziko AI Brain';

  console.log('\nRead-back:');
  console.log('  Sub-wf "Find Corridors" node:', subOk   ? '✓' : '✗ MISSING');
  console.log('  Brain has tool node:',           brainOk ? '✓' : '✗ MISSING');
  console.log('  Tool wired to agent:',           wired   ? '✓' : '✗ MISSING');
  console.log('  Brain total nodes:', rbBrain.nodes.length);
  console.log('  Brain active:', rbBrain.active);
  console.log('  Sub-wf ID:', subWfId);

  if (subOk && brainOk && wired) {
    console.log('\n✅ DEPLOY SUCCESS');
    console.log('Test: "Aaziko mein koi active trade corridor batao" or "cotton ke liye koi mauka hai?"');
  } else {
    console.log('\n✗ Deploy incomplete — check above');
  }
})().catch(e => console.error('FATAL:', e.message));
