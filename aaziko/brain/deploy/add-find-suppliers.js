'use strict';
/*
 * add-find-suppliers.js
 * Creates Tool: find_suppliers sub-workflow + wires into Aaziko Brain.
 *
 * "India se cotton export karne wale top companies kaun hain?" —
 * Returns actual supplier/exporter company names from supplier_summaries.
 *
 * Usage:
 *   node aaziko/brain/deploy/add-find-suppliers.js          # dry-run
 *   node aaziko/brain/deploy/add-find-suppliers.js --write  # deploy live
 */
require('dotenv').config();
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');
const https = require('https');

const WRITE     = process.argv.includes('--write');
const BRAIN_ID  = 'w7no6uCJkz7lfaah';
const TOOL_NAME = 'find_suppliers';
const CS_CRED   = { mongoDb: { id: 'vL0izSZrMHn4Ukgc', name: 'Aaziko - common-service' } };

// ── Code: Parse Input ─────────────────────────────────────────────────────────
const PARSE_CODE = `
let inp = {};
try {
  inp = typeof $input.first().json === 'string'
    ? JSON.parse($input.first().json)
    : $input.first().json;
} catch(e) {}

var country = String(inp.country || inp.origin_country || '').trim();
var hs      = String(inp.hs_code || inp.hs || '').trim();
var limit   = Math.min(parseInt(inp.limit || 15, 10), 25);

if (!country && !hs) {
  return [{ json: { pipelineStr: '[]', country: '', hs: '', limit: 0, error: 'country ya hs_code zaroori hai' } }];
}

var matchFilter = { has_recent_activity: true };
if (country) matchFilter['supplier_country'] = { $regex: country, $options: 'i' };
if (/^[0-9]{2,10}$/.test(hs)) {
  matchFilter['hs_codes'] = { $elemMatch: { $regex: '^' + hs.slice(0, 6) } };
}

var pipeline = [
  { $match: matchFilter },
  { $sort: { total_shipments: -1 } },
  { $limit: limit },
  { $project: {
    supplier_name:      1,
    supplier_country:   1,
    supplier_tier:      1,
    supplier_status:    1,
    total_shipments:    1,
    total_value_usd:    1,
    last_shipment_date: 1,
    _id: 0
  }}
];

return [{ json: { pipelineStr: JSON.stringify(pipeline), country: country, hs: hs, limit: limit } }];
`.trim();

// ── Code: Format Results ──────────────────────────────────────────────────────
const FORMAT_CODE = `
var ctx  = $('Parse Input').first().json;
var rows = $input.all().map(function(i) { return i.json; });

if (ctx.error) {
  return [{ json: { output: 'Country ya HS code dena zaroori hai. Example: "India se cotton exporters" ya "HS 5201 Indian suppliers".' } }];
}

if (!rows.length) {
  var msg = 'Koi active supplier nahi mila';
  if (ctx.country) msg += ' — country: ' + ctx.country;
  if (ctx.hs)      msg += ' — HS: ' + ctx.hs;
  return [{ json: { output: msg + '. Country ka full naam try karein (jaise INDIA, CHINA, BANGLADESH).' } }];
}

var lines = rows.map(function(r, i) {
  var name  = (r.supplier_name || 'Unknown').slice(0, 50);
  var ships = r.total_shipments || 0;
  var tier  = r.supplier_tier ? ' · ' + r.supplier_tier : '';
  var val   = r.total_value_usd > 0
    ? ' · $' + (r.total_value_usd / 1000000).toFixed(1) + 'M'
    : '';
  var last  = r.last_shipment_date
    ? ' · last: ' + String(r.last_shipment_date).slice(0, 7)
    : '';
  return (i + 1) + '. ' + name + ' — ' + ships + ' shipments' + val + tier + last;
});

var header = 'Active suppliers/exporters';
if (ctx.hs && ctx.country) header = ctx.country + ' suppliers — HS ' + ctx.hs;
else if (ctx.country)      header = ctx.country + ' ke active suppliers/exporters';
else if (ctx.hs)           header = 'HS ' + ctx.hs + ' ke active suppliers (global)';

return [{ json: {
  output: header + ' (Aaziko data):\\n' + lines.join('\\n') +
    '\\n\\nKisi specific supplier ki profile ya intel chahiye? Supplier ka naam puchein.'
} }];
`.trim();

// ── Code: Reply OK ────────────────────────────────────────────────────────────
const REPLY_CODE = `
var all = $input.all();
var out = '';
for (var i = 0; i < all.length; i++) {
  if (all[i].json && all[i].json.output) { out = all[i].json.output; break; }
}
return [{ json: { output: out || 'No supplier data available.' } }];
`.trim();

// ── Sub-workflow definition ───────────────────────────────────────────────────
const SUB_WF = {
  name: 'Tool: find_suppliers',
  settings: { saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all' },
  nodes: [
    {
      id: 'fs-trig', name: 'Execute Workflow Trigger',
      type: 'n8n-nodes-base.executeWorkflowTrigger',
      typeVersion: 1, position: [100, 300], parameters: {}
    },
    {
      id: 'fs-parse', name: 'Parse Input',
      type: 'n8n-nodes-base.code',
      typeVersion: 2, position: [340, 300],
      parameters: { jsCode: PARSE_CODE }
    },
    {
      id: 'fs-find', name: 'Find Suppliers',
      type: 'n8n-nodes-base.mongoDb',
      typeVersion: 1, position: [580, 300],
      credentials: CS_CRED,
      parameters: {
        operation: 'aggregate',
        collection: 'supplier_summaries',
        query: '={{ $json.pipelineStr }}'
      }
    },
    {
      id: 'fs-fmt', name: 'Format Results',
      type: 'n8n-nodes-base.code',
      typeVersion: 2, position: [820, 300],
      parameters: { jsCode: FORMAT_CODE }
    },
    {
      id: 'fs-ok', name: 'Reply OK',
      type: 'n8n-nodes-base.code',
      typeVersion: 2, position: [1060, 300],
      parameters: { jsCode: REPLY_CODE }
    }
  ],
  connections: {
    'Execute Workflow Trigger': { main: [[{ node: 'Parse Input',    type: 'main', index: 0 }]] },
    'Parse Input':              { main: [[{ node: 'Find Suppliers', type: 'main', index: 0 }]] },
    'Find Suppliers':           { main: [[{ node: 'Format Results', type: 'main', index: 0 }]] },
    'Format Results':           { main: [[{ node: 'Reply OK',       type: 'main', index: 0 }]] }
  }
};

// ── Brain toolWorkflow node ───────────────────────────────────────────────────
function makeBrainNode(wfId) {
  return {
    id: 'az-fs-tool',
    name: TOOL_NAME,
    type: '@n8n/n8n-nodes-langchain.toolWorkflow',
    typeVersion: 2.2,
    position: [1340, 1480],
    parameters: {
      description:
        'Returns ACTUAL SUPPLIER / EXPORTER COMPANY NAMES — the specific companies that export/supply a product from a country. ' +
        'Use when user wants WHO SELLS or WHO EXPORTS: ' +
        '"India se cotton export karne wali companies kaun hain?", ' +
        '"China mein leather ke suppliers kaun hain?", ' +
        '"HS 5201 ke top Indian exporters list karo", ' +
        '"supplier names chahiye", "exporters list", "kaun bhejta hai", ' +
        '"which companies supply this product", "manufacturer list", "vendor list". ' +
        'Returns supplier company name, shipment count, value, tier and last activity date. ' +
        'Note: use find_buyers for IMPORTERS (who buys), find_suppliers for EXPORTERS (who sells).',
      workflowId: {
        __rl: true, mode: 'id', value: wfId,
        cachedResultName: 'Tool: find_suppliers'
      },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          country: "={{ $fromAI('country', 'Supplier/exporter country (e.g. INDIA, CHINA, BANGLADESH). Required if no hs_code.', 'string', '') }}",
          hs_code: "={{ $fromAI('hs_code', 'HS code 4-10 digits to filter by product (e.g. 5201 for cotton). Optional.', 'string', '') }}",
          limit:   "={{ $fromAI('limit', 'Max suppliers to return (default 15, max 25)', 'number', 15) }}"
        },
        matchingColumns: [],
        schema: [
          { id: 'country', displayName: 'country', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'hs_code', displayName: 'hs_code', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
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
  console.log('\n=== Add Tool: find_suppliers ===');
  console.log(WRITE ? '[LIVE DEPLOY]' : '[DRY-RUN — pass --write to deploy]');

  if (!WRITE) {
    console.log('\nSub-workflow:', SUB_WF.name);
    console.log('DB: common-service.supplier_summaries');
    console.log('\nSample queries:');
    console.log('  "India se cotton suppliers kaun hain?"');
    console.log('  "China leather exporters list karo"');
    console.log('  "HS 5201 Indian exporters top 15"');
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

  const subOk   = !!rbSub.nodes.find(n => n.name === 'Find Suppliers');
  const brainOk = !!rbBrain.nodes.find(n => n.name === TOOL_NAME);
  const wired   = rbBrain.connections[TOOL_NAME]?.ai_tool?.[0]?.[0]?.node === 'Aaziko AI Brain';

  console.log('\nRead-back:');
  console.log('  Sub-wf "Find Suppliers" node:', subOk   ? '✓' : '✗ MISSING');
  console.log('  Brain has tool node:',          brainOk ? '✓' : '✗ MISSING');
  console.log('  Tool wired to agent:',          wired   ? '✓' : '✗ MISSING');
  console.log('  Brain total nodes:', rbBrain.nodes.length);
  console.log('  Sub-wf ID:', subWfId);

  if (subOk && brainOk && wired) {
    console.log('\n✅ DEPLOY SUCCESS');
    console.log('Test: "India se cotton suppliers kaun hain?"');
    console.log('Test: "China leather exporters top 10"');
  } else {
    console.log('\n✗ Deploy incomplete — check above');
  }
})().catch(e => console.error('FATAL:', e.message));
