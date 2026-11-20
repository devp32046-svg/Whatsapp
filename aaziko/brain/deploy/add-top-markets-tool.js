'use strict';
/*
 * Add get_top_markets tool to Aaziko Brain:
 *   1. Create sub-workflow that queries trademapsheet.india_share for top export countries
 *   2. Wire it to Aaziko AI Brain as a new tool node
 *   3. Update Build Context prompt: auto-call after HS code found
 *
 * Data source: trademapsheet.india_share — 662K docs, 130 country rows per HS code
 *   with India's 2025 export values, growth rates per destination.
 *
 * node aaziko/brain/deploy/add-top-markets-tool.js         -- dry run (shows plan)
 * node aaziko/brain/deploy/add-top-markets-tool.js --write -- deploy
 */
const path = require('path');
const fs   = require('fs');
const { req, getWf, putWf, activate, RROOT } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(RROOT, 'backups');
const BRAIN_ID   = 'w7no6uCJkz7lfaah';
const WRITE = process.argv.includes('--write');

// ── Sub-workflow nodes ─────────────────────────────────────────────────────────
const MARKETS_PREP_CODE = `
let inp = {};
try { inp = typeof $input.first().json === 'string' ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}

var hs_code = String(inp.hs_code || '').trim().replace(/[^0-9]/g, '');
if (!hs_code) return [{ json: { _error: 'hs_code required (6-digit, e.g. 420310)' } }];
if (hs_code.length > 6) hs_code = hs_code.slice(0, 6);
if (hs_code.length < 4) return [{ json: { _error: 'hs_code must be at least 4 digits' } }];

// Sort by export value desc, limit 10 to allow dedup in Format step
var pipeline = JSON.stringify([
  { '$match': { 'ProductCode': hs_code, 'tradedescription1.Valuein2025,USDthousand': { '$gt': 0 } } },
  { '$sort':  { 'tradedescription1.Valuein2025,USDthousand': -1 } },
  { '$limit': 10 }
]);
return [{ json: { hs_code: hs_code, pipeline: pipeline } }];
`.trim();

const FORMAT_MARKETS_CODE = `
var docs = $input.all().map(function(d) { return d.json; });
if (!docs.length) {
  return [{ json: { output: 'Is HS code ke liye export market data nahi mila.' } }];
}
var PREFIX = "India's exports to ";
var seen = {};
var markets = [];
for (var i = 0; i < docs.length; i++) {
  var d = docs[i];
  var td = d.tradedescription1 || {};
  var title = String(td.title || '');
  if (title.indexOf(PREFIX) !== 0) continue;
  var country = title.slice(PREFIX.length);
  if (seen[country]) continue;
  seen[country] = true;
  var valK = Number(td['Valuein2025,USDthousand'] || 0);
  var growth = (td['Annualgrowthinvaluebetween2021-2025,%,p.a.'] !== undefined && td['Annualgrowthinvaluebetween2021-2025,%,p.a.'] !== null)
    ? Number(td['Annualgrowthinvaluebetween2021-2025,%,p.a.']) : null;
  markets.push({ country: country, value_usd_mn: +(valK / 1000).toFixed(1), growth_pct_pa: growth });
}

var top5 = markets.slice(0, 5);
var hs_code = docs[0] ? String(docs[0].ProductCode || '') : '';

if (!top5.length) {
  return [{ json: { output: 'Is HS code ke liye significant export market data nahi mila.' } }];
}

var lines = top5.map(function(m, i) {
  var growthStr = '';
  if (m.growth_pct_pa !== null) {
    growthStr = ' (' + (m.growth_pct_pa > 0 ? '+' : '') + m.growth_pct_pa + '% p.a.)';
  }
  return (i + 1) + '. ' + m.country + ': $' + m.value_usd_mn + 'M' + growthStr;
});

var output = 'Top export markets (India → world, 2025):\\n' + lines.join('\\n')
  + '\\n\\nIn mein se kisi ke liye tariff, compliance ya port chahiye?';

return [{ json: { hs_code: hs_code, top_markets: top5, output: output } }];
`.trim();

// ── Sub-workflow definition ────────────────────────────────────────────────────
const SUB_WF = {
  name: 'Aaziko — Get Top Markets',
  nodes: [
    {
      id: 'gtm-1', name: 'Execute Workflow Trigger',
      type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1,
      position: [240, 300], parameters: {}
    },
    {
      id: 'gtm-2', name: 'Markets Prep',
      type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [460, 300],
      parameters: { jsCode: MARKETS_PREP_CODE }
    },
    {
      id: 'gtm-3', name: 'Gate: Error?',
      type: 'n8n-nodes-base.if', typeVersion: 2.2,
      position: [680, 300],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
          conditions: [{ id: 'g1', leftValue: '={{ $json._error }}', rightValue: '',
            operator: { type: 'string', operation: 'notEmpty' } }],
          combinator: 'and'
        }
      }
    },
    {
      id: 'gtm-4', name: 'Respond Error',
      type: 'n8n-nodes-base.set', typeVersion: 3.4,
      position: [900, 200],
      parameters: {
        assignments: {
          assignments: [{ id: 'e1', name: 'output', value: '={{ $json._error }}', type: 'string' }]
        }
      }
    },
    {
      id: 'gtm-5', name: 'Find Top Markets',
      type: 'n8n-nodes-base.mongoDb', typeVersion: 1.3,
      position: [900, 400],
      parameters: {
        operation: 'aggregate',
        database: 'trademapsheet',
        collection: 'india_share',
        query: '={{ $json.pipeline }}'
      },
      credentials: {
        mongoDb: { id: '3lzVlfXxWT73tkXl', name: 'Aaziko - Dhruval (buyers)' }
      }
    },
    {
      id: 'gtm-6', name: 'Format Markets',
      type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [1120, 400],
      parameters: { jsCode: FORMAT_MARKETS_CODE }
    },
    {
      id: 'gtm-7', name: 'Respond OK',
      type: 'n8n-nodes-base.set', typeVersion: 3.4,
      position: [1340, 400],
      parameters: {
        assignments: {
          assignments: [{ id: 'o1', name: 'output', value: '={{ $json.output }}', type: 'string' }]
        }
      }
    }
  ],
  connections: {
    'Execute Workflow Trigger': { main: [[{ node: 'Markets Prep', type: 'main', index: 0 }]] },
    'Markets Prep':             { main: [[{ node: 'Gate: Error?', type: 'main', index: 0 }]] },
    'Gate: Error?':             { main: [[{ node: 'Respond Error', type: 'main', index: 0 }],
                                          [{ node: 'Find Top Markets', type: 'main', index: 0 }]] },
    'Find Top Markets':         { main: [[{ node: 'Format Markets', type: 'main', index: 0 }]] },
    'Format Markets':           { main: [[{ node: 'Respond OK', type: 'main', index: 0 }]] }
  },
  settings: {
    saveDataSuccessExecution: 'none',
    saveDataErrorExecution: 'all',
    executionOrder: 'v1'
  }
};

// ── Brain prompt update ────────────────────────────────────────────────────────
// Anchor: insert AFTER the lookup_hs_code usage rule (actual text from Build Context line 82)
const PROMPT_ANCHOR = '- lookup_hs_code: call with hs_code (6-digit) for description, OR product_name for reverse HS code lookup.';
const PROMPT_NEW_RULE =
`- get_top_markets: Jab bhi kisi product ka HS code milta hai, TURANT get_top_markets(hs_code) bhi call karo (ek hi response mein). Result mein top 3-4 markets ka naam aur export value batao. Example: "Leather jackets (HS 420310) ke liye Spain $66M, USA $75M, Italy $47M export hota hai. Kisi ke liye tariff ya compliance dekhna hai?" — Sirf tab skip karo jab user specifically ek country maange aur markets ka sawaal hi na ho.`;

// If sub-workflow was already created in a previous run, reuse it instead of creating again
const EXISTING_SUB_ID = '7Apiy29NMpFOackK';

// ── Dry-run verification ───────────────────────────────────────────────────────
console.log('=== Plan ===');
console.log('1. Create sub-workflow: "Aaziko — Get Top Markets"');
console.log('   - Nodes: Markets Prep → Gate → Find Top Markets (trademapsheet.india_share) → Format Markets');
console.log('   - Credential: Aaziko - Dhruval (buyers) | DB: trademapsheet | Collection: india_share');
console.log('2. Wire as new tool in brain (w7no6uCJkz7lfaah)');
console.log('3. Update Build Context: auto-call get_top_markets after HS code found');
console.log('\nPrompt rule to add:');
console.log(PROMPT_NEW_RULE);

// Syntax check code nodes
try { new Function(MARKETS_PREP_CODE); console.log('\n✅ Markets Prep syntax OK'); }
catch(e) { console.log('\n❌ Markets Prep syntax error:', e.message); process.exit(1); }
try { new Function(FORMAT_MARKETS_CODE); console.log('✅ Format Markets syntax OK'); }
catch(e) { console.log('❌ Format Markets syntax error:', e.message); process.exit(1); }

if (!WRITE) { console.log('\n(dry run — pass --write to deploy)'); process.exit(0); }

// ── Deploy ─────────────────────────────────────────────────────────────────────
(async () => {
  // 1. Backup brain
  const brain = await getWf(BRAIN_ID);
  fs.writeFileSync(path.join(BACKUP_DIR, BRAIN_ID + '_before_top_markets_tool.json'),
    JSON.stringify(brain, null, 2), 'utf8');
  console.log('\nBrain backup saved.');

  // 2. Create sub-workflow (or reuse if already created)
  let SUB_ID = EXISTING_SUB_ID;
  if (EXISTING_SUB_ID) {
    console.log('Reusing existing sub-workflow id =', EXISTING_SUB_ID);
    SUB_ID = EXISTING_SUB_ID;
  } else {
    console.log('Creating sub-workflow...');
    const cr = await req('POST', '/api/v1/workflows', SUB_WF);
    if (cr.status !== 200 && cr.status !== 201) {
      console.log('❌ Create sub-wf failed:', cr.status, cr.body.slice(0, 400));
      process.exit(1);
    }
    const subWf = JSON.parse(cr.body);
    SUB_ID = subWf.id;
    console.log('✅ Sub-workflow created: id =', SUB_ID);
    await activate(SUB_ID);
    console.log('✅ Sub-workflow activated');
  }

  // 4. Add tool node to brain
  const BC = brain.nodes.find(n => n.name === 'Build Context');
  if (!BC) { console.log('❌ Build Context node not found'); process.exit(1); }

  // Check if already wired
  if (brain.nodes.find(n => n.name === 'Tool: get_top_markets')) {
    console.log('Tool: get_top_markets already in brain — skipping node add');
  } else {
    const toolNode = {
      id: 'gtm-tool-' + Date.now().toString(36),
      name: 'Tool: get_top_markets',
      type: '@n8n/n8n-nodes-langchain.toolWorkflow',
      typeVersion: 2.2,
      position: [2480, 608],
      parameters: {
        description: 'Get top export markets for an HS code — returns top 5 countries where India exports this product, with 2025 USD trade values and growth rates. Call this automatically after getting an HS code.',
        workflowId: { __rl: true, mode: 'id', value: SUB_ID, cachedResultName: 'Aaziko — Get Top Markets' },
        workflowInputs: {
          mappingMode: 'defineBelow',
          value: {
            hs_code: "={{ $fromAI('hs_code', '6-digit HS code (e.g. 420310)', 'string', '') }}"
          },
          matchingColumns: [],
          schema: [
            { id: 'hs_code', displayName: 'hs_code', required: true, defaultMatch: false,
              display: true, type: 'string', canBeUsedToMatch: false }
          ]
        }
      }
    };
    brain.nodes.push(toolNode);
    brain.connections['Tool: get_top_markets'] = {
      ai_tool: [[{ node: 'Aaziko AI Brain', type: 'ai_tool', index: 0 }]]
    };
    console.log('✅ Tool node added to brain');
  }

  // 5. Update Build Context prompt
  const curCode = BC.parameters.jsCode;
  if (curCode.includes('get_top_markets')) {
    console.log('get_top_markets rule already in Build Context — skipping');
  } else if (!curCode.includes(PROMPT_ANCHOR)) {
    console.log('❌ Prompt anchor not found in Build Context — cannot insert rule');
    process.exit(1);
  } else {
    BC.parameters.jsCode = curCode.replace(PROMPT_ANCHOR, PROMPT_NEW_RULE + '\n' + PROMPT_ANCHOR);
    console.log('✅ Build Context prompt updated');
  }

  // 6. PUT brain
  const settings = Object.assign({}, brain.settings); delete settings.binaryMode;
  const pr = await putWf(BRAIN_ID, { name: brain.name, nodes: brain.nodes, connections: brain.connections, settings });
  if (pr.status !== 200) {
    console.log('❌ Brain PUT failed:', pr.status, pr.body.slice(0, 400));
    process.exit(1);
  }
  await activate(BRAIN_ID);
  console.log('✅ Brain updated and re-activated');

  // 7. Read-back verify
  const check = await getWf(BRAIN_ID);
  const hasToolNode = check.nodes.find(n => n.name === 'Tool: get_top_markets');
  const hasPromptRule = check.nodes.find(n => n.name === 'Build Context')
    ?.parameters?.jsCode?.includes('get_top_markets');
  console.log((hasToolNode ? '✅' : '❌') + ' Tool node in brain');
  console.log((hasPromptRule ? '✅' : '❌') + ' Prompt rule in Build Context');
  console.log('\nSub-workflow ID:', SUB_ID);
  console.log('Test: ask "leather jackets export karna hai" — should get HS 420310 + top markets in one response');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
