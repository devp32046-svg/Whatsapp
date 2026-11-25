'use strict';
/*
 * add-seasonal-trends.js
 * Creates Tool: seasonal_trends sub-workflow + wires into Aaziko Brain.
 *
 * Uses buyer_summaries.last_shipment_date to show:
 *   - Country active months:  "Germany buyers kab active hain?"
 *   - Product seasonal:       "Cotton (HS 5201) demand peak kab?"
 *   - Both combined:          "Germany leather buyers monthly pattern?"
 *
 * Usage:
 *   node aaziko/brain/deploy/add-seasonal-trends.js          # dry-run
 *   node aaziko/brain/deploy/add-seasonal-trends.js --write  # deploy live
 */
require('dotenv').config();
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');
const https = require('https');

const WRITE     = process.argv.includes('--write');
const BRAIN_ID  = 'w7no6uCJkz7lfaah';
const TOOL_NAME = 'get_seasonal_trends';
const CS_CRED   = { mongoDb: { id: 'vL0izSZrMHn4Ukgc', name: 'Aaziko - common-service' } };

// ── Code: Parse Input ─────────────────────────────────────────────────────────
const PARSE_CODE = `
let inp = {};
try {
  inp = typeof $input.first().json === 'string'
    ? JSON.parse($input.first().json)
    : $input.first().json;
} catch(e) {}

var country = String(inp.country || '').trim();
var hs      = String(inp.hs_code || inp.hs || inp.product || '').trim();
var limit   = 12; // all months

// Build match filter on buyer_summaries
var matchFilter = { has_recent_activity: true };
if (country) matchFilter['buyer_country'] = { $regex: country, $options: 'i' };
if (/^[0-9]{2,10}$/.test(hs)) {
  matchFilter['hs_codes'] = { $elemMatch: { $regex: '^' + hs.slice(0, 6) } };
}

// Use $dateFromString + $addFields to avoid $month(null) error
var pipeline = [
  { $match: matchFilter },
  { $addFields: {
    _d: { $dateFromString: {
      dateString: '$last_shipment_date',
      onError: null, onNull: null
    }}
  }},
  { $match: { _d: { $ne: null } } },
  { $project: { month: { $month: '$_d' } } },
  { $group: { _id: '$month', count: { $sum: 1 } } },
  { $sort: { count: -1 } },
  { $limit: 12 }
];

return [{ json: {
  pipelineStr: JSON.stringify(pipeline),
  country: country,
  hs: hs
}}];
`.trim();

// ── Code: Format Results ──────────────────────────────────────────────────────
const FORMAT_CODE = `
var ctx   = $('Parse Input').first().json;
var rows  = $input.all().map(function(i) { return i.json; });
var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

if (!rows.length) {
  var msg = 'Monthly activity data nahi mila';
  if (ctx.country) msg += ' — country: ' + ctx.country;
  if (ctx.hs)      msg += ' — HS: ' + ctx.hs;
  return [{ json: { output: msg + '. Koi specific country ya HS code try karein.' } }];
}

// Sort descending by count
var sorted = rows.slice().sort(function(a, b) { return (b.count || 0) - (a.count || 0); });

var lines = sorted.map(function(r, i) {
  var mIdx  = ((r._id || 1) - 1 + 12) % 12;
  var mName = MONTHS[mIdx] || ('Month-' + r._id);
  return (i + 1) + '. ' + mName + ' — ' + (r.count || 0) + ' active buyers';
});

var topThree = sorted.slice(0, 3).map(function(r) {
  var mIdx = ((r._id || 1) - 1 + 12) % 12;
  return MONTHS[mIdx] || ('Month-' + r._id);
});

var header = 'Monthly buyer activity';
if (ctx.country && ctx.hs) header = ctx.country + ' buyers (HS ' + ctx.hs + ') monthly pattern';
else if (ctx.country)      header = ctx.country + ' buyers ki monthly activity';
else if (ctx.hs)           header = 'HS ' + ctx.hs + ' ke buyers ki monthly pattern';

return [{ json: {
  output: header + ' (Aaziko data):\\n' + lines.join('\\n') +
    '\\n\\nPeak months: ' + topThree.join(', ') +
    '\\n(buyer_summaries last_shipment_date se — approximate seasonal signal)' +
    '\\n\\nKisi specific month ke active buyers dekhne hain? Country + HS code ke saath puchein.'
}}];
`.trim();

// ── Code: Reply OK ────────────────────────────────────────────────────────────
const REPLY_CODE = `
var all = $input.all();
var out = '';
for (var i = 0; i < all.length; i++) {
  if (all[i].json && all[i].json.output) { out = all[i].json.output; break; }
}
return [{ json: { output: out || 'No seasonal data available.' } }];
`.trim();

// ── Sub-workflow definition ───────────────────────────────────────────────────
const SUB_WF = {
  name: 'Tool: seasonal_trends',
  settings: { saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all' },
  nodes: [
    {
      id: 'st-trig', name: 'Execute Workflow Trigger',
      type: 'n8n-nodes-base.executeWorkflowTrigger',
      typeVersion: 1, position: [100, 300], parameters: {}
    },
    {
      id: 'st-parse', name: 'Parse Input',
      type: 'n8n-nodes-base.code',
      typeVersion: 2, position: [340, 300],
      parameters: { jsCode: PARSE_CODE }
    },
    {
      id: 'st-find', name: 'Find Monthly Trends',
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
      id: 'st-fmt', name: 'Format Results',
      type: 'n8n-nodes-base.code',
      typeVersion: 2, position: [820, 300],
      parameters: { jsCode: FORMAT_CODE }
    },
    {
      id: 'st-ok', name: 'Reply OK',
      type: 'n8n-nodes-base.code',
      typeVersion: 2, position: [1060, 300],
      parameters: { jsCode: REPLY_CODE }
    }
  ],
  connections: {
    'Execute Workflow Trigger': { main: [[{ node: 'Parse Input',          type: 'main', index: 0 }]] },
    'Parse Input':              { main: [[{ node: 'Find Monthly Trends',  type: 'main', index: 0 }]] },
    'Find Monthly Trends':      { main: [[{ node: 'Format Results',       type: 'main', index: 0 }]] },
    'Format Results':           { main: [[{ node: 'Reply OK',             type: 'main', index: 0 }]] }
  }
};

// ── Brain toolWorkflow node ───────────────────────────────────────────────────
function makeBrainNode(wfId) {
  return {
    id: 'az-st-tool',
    name: TOOL_NAME,
    type: '@n8n/n8n-nodes-langchain.toolWorkflow',
    typeVersion: 2.2,
    position: [1340, 1060],
    parameters: {
      description:
        'Returns a MONTH-BY-MONTH calendar breakdown (Jan through Dec) of buyer activity — ' +
        'answers WHEN buyers are active, not WHAT products or corridors exist. ' +
        'Use ONLY when the question is about TIMING or SEASONALITY: ' +
        '"kaunse mahine mein Germany buyers zyada hain?", ' +
        '"peak season kab hai?", "October mein buyers hain ya March mein?", ' +
        '"seasonal pattern", "monthly distribution", "kis quarter mein zyada demand?", ' +
        '"time interval activity", "which months are peak months", ' +
        '"cotton buyers ka peak month kab hai?", "year mein kab sabse zyada buyers hote hain?".',
      workflowId: {
        __rl: true, mode: 'id', value: wfId,
        cachedResultName: 'Tool: seasonal_trends'
      },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          country: "={{ $fromAI('country', 'Buyer country name (e.g. GERMANY, USA, VIETNAM). Leave empty for all countries.', 'string', '') }}",
          hs_code: "={{ $fromAI('hs_code', 'HS code 4-10 digits to filter by product. Leave empty for all products.', 'string', '') }}"
        },
        matchingColumns: [],
        schema: [
          { id: 'country', displayName: 'country', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'hs_code', displayName: 'hs_code', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false }
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
  console.log('\n=== Add Tool: get_seasonal_trends ===');
  console.log(WRITE ? '[LIVE DEPLOY]' : '[DRY-RUN — pass --write to deploy]');

  if (!WRITE) {
    console.log('\nSub-workflow:', SUB_WF.name);
    console.log('Nodes:', SUB_WF.nodes.map(n => n.name).join(' → '));
    console.log('DB: common-service.buyer_summaries');
    console.log('Credential: vL0izSZrMHn4Ukgc');
    console.log('\nSample queries:');
    console.log('  "Germany buyers kab active hain?"');
    console.log('  "Cotton (HS 5201) buyers peak month kab?"');
    console.log('  "Vietnam mein leather buyers (HS 4107) monthly pattern?"');
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
    console.log('Tool already in brain — updating node...');
    const existing = brain.nodes.find(n => n.name === TOOL_NAME);
    const fresh = makeBrainNode(subWfId);
    existing.parameters = fresh.parameters; // update description + wfId
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
  if (br.status >= 300) { console.error('Brain PUT failed:', br.body?.slice(0, 300)); return; }

  await activate(BRAIN_ID, false);
  await new Promise(r => setTimeout(r, 800));
  await activate(BRAIN_ID, true);

  // ── 3. Read-back verify ──────────────────────────────────────────────────────
  const rbBrain = await getWf(BRAIN_ID);
  const rbSub   = await getWf(subWfId);

  const subOk   = !!rbSub.nodes.find(n => n.name === 'Find Monthly Trends');
  const brainOk = !!rbBrain.nodes.find(n => n.name === TOOL_NAME);
  const wired   = rbBrain.connections[TOOL_NAME]?.ai_tool?.[0]?.[0]?.node === 'Aaziko AI Brain';

  console.log('\nRead-back:');
  console.log('  Sub-wf "Find Monthly Trends" node:', subOk   ? '✓' : '✗ MISSING');
  console.log('  Brain has tool node:',               brainOk ? '✓' : '✗ MISSING');
  console.log('  Tool wired to agent:',               wired   ? '✓' : '✗ MISSING');
  console.log('  Brain total nodes:', rbBrain.nodes.length);
  console.log('  Brain active:', rbBrain.active);
  console.log('  Sub-wf ID:', subWfId);

  if (subOk && brainOk && wired) {
    console.log('\n✅ DEPLOY SUCCESS');
    console.log('Test: "Germany buyers kab active hain?"');
    console.log('Test: "Cotton (HS 5201) buyers peak month kab?"');
  } else {
    console.log('\n✗ Deploy incomplete — check above');
  }
})().catch(e => console.error('FATAL:', e.message));
