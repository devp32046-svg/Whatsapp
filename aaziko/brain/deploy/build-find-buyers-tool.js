'use strict';
/* Build & wire find_buyers tool to Aaziko Brain:
 *   1. Create sub-workflow: search Dhruval.buyer_intelligence by product keyword
 *   2. Add Tool: find_buyers node to brain
 *   3. Update Build Context system prompt to describe the tool
 *
 * node aaziko/brain/deploy/build-find-buyers-tool.js          -- dry run
 * node aaziko/brain/deploy/build-find-buyers-tool.js --write  -- create + wire
 */
const path = require('path'), fs = require('fs');
const { req, getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const SEC_DIR = path.resolve(__dirname, '..', '..', '.secrets');
const ids = JSON.parse(fs.readFileSync(path.join(SEC_DIR, 'brain-n8n.json'), 'utf8'));
const WRITE = process.argv.includes('--write');
const BRAIN_ID = ids.brainWfId;

const REMINDERS_CRED = { id: 'Hxh39r3Fnn77hr55', name: 'Aaziko Reminders Mongo (aaziko_reminders ONLY)' };
const rng = () => Math.random().toString(36).slice(2, 10);

// ---- Sub-workflow definition ----
const PREP_CODE = [
  'let inp = {};',
  'try { inp = typeof $input.first().json === "string" ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}',
  'const keyword = String(inp.keyword || inp.product || inp.query || "").trim();',
  'const minScore = parseInt(inp.min_score || inp.score || "0", 10) || 0;',
  'if (!keyword) return [{ json: { _error: "keyword required — describe the product you want buyers for" } }];',
  '',
  '// Build regex filter on suggested_product and buyer_name',
  'var kw = keyword.replace(/[.*+?^$()|[{}\\\\]/g, "\\\\$&");',
  'var filter = {',
  '  "$or": [',
  '    { "suggested_product": { "$regex": kw, "$options": "i" } },',
  '    { "buyer_name": { "$regex": kw, "$options": "i" } }',
  '  ]',
  '};',
  'if (minScore > 0) filter.score = { "$gte": minScore };',
  '',
  'return [{ json: { keyword: keyword, matchQuery: JSON.stringify(filter) } }];'
].join('\n');

const FORMAT_CODE = [
  'const data = $input.first().json;',
  'const prep = $("Buyer Prep").first().json;',
  'const rows = data.rows || [];',
  '',
  'if (prep._error) return [{ json: { ok: false, error: prep._error } }];',
  'if (!rows.length) return [{ json: { ok: false, error: "No buyers found for: " + prep.keyword } }];',
  '',
  'const lines = rows.slice(0, 6).map(function(r) {',
  '  var score = r.score || 0;',
  '  var conf = r.deal_confidence || 0;',
  '  var stage = r.category || "Unknown";',
  '  var insight = (r.insights && r.insights[0]) ? r.insights[0] : "";',
  '  var product = (r.suggested_product || "").slice(0, 80);',
  '  var value = r.avg_order_value ? "$" + Math.round(r.avg_order_value).toLocaleString() : "";',
  '  return "• " + (r.buyer_name || "Unknown") +',
  '    " [" + stage + ", score " + score + ", conf " + conf + "%]" +',
  '    (value ? " avg " + value : "") +',
  '    "\\n  Product: " + product +',
  '    (insight ? "\\n  Note: " + insight : "");',
  '});',
  '',
  'var summary = "Potential buyers for \\"" + prep.keyword + "\\" (" + rows.length + " found):\\n" + lines.join("\\n");',
  'return [{ json: { ok: true, summary: summary, rowCount: rows.length } }];'
].join('\n');

function buildSubWorkflow() {
  const ids_ = {
    trigger: rng(), prep: rng(), gate: rng(),
    errReply: rng(), findNode: rng(), fmt: rng(), reply: rng()
  };
  return {
    name: 'find_buyers workflow',
    nodes: [
      {
        id: ids_.trigger, name: 'Execute Workflow Trigger',
        type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1,
        position: [260, 460], parameters: {}
      },
      {
        id: ids_.prep, name: 'Buyer Prep',
        type: 'n8n-nodes-base.code', typeVersion: 2,
        position: [460, 460],
        parameters: { mode: 'runOnceForAllItems', jsCode: PREP_CODE }
      },
      {
        id: ids_.gate, name: 'Gate: Error?',
        type: 'n8n-nodes-base.if', typeVersion: 2,
        position: [660, 460],
        parameters: {
          conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
            conditions: [{ id: rng(), leftValue: '={{ $json._error }}', operator: { type: 'string', operation: 'notEmpty' }, rightValue: '' }] },
          combinator: 'and'
        }
      },
      {
        id: ids_.errReply, name: 'Error Reply',
        type: 'n8n-nodes-base.code', typeVersion: 2,
        position: [860, 360],
        parameters: {
          mode: 'runOnceForAllItems',
          jsCode: 'return [{ json: { ok: false, response: $("Buyer Prep").first().json._error } }];'
        }
      },
      {
        id: ids_.findNode, name: 'Find Buyers',
        type: 'n8n-nodes-base.mongoDb', typeVersion: 1.3,
        position: [860, 560],
        parameters: {
          operation: 'aggregate',
          collection: 'buyer_intelligence',
          databaseName: 'Dhruval',
          query: "={{ JSON.stringify([{\"$match\":JSON.parse($('Buyer Prep').first().json.matchQuery)},{\"$sort\":{\"score\":-1,\"deal_confidence\":-1}},{\"$facet\":{\"rows\":[{\"$limit\":10}]}}]) }}"
        },
        credentials: { mongoDb: REMINDERS_CRED }
      },
      {
        id: ids_.fmt, name: 'Format Result',
        type: 'n8n-nodes-base.code', typeVersion: 2,
        position: [1060, 560],
        parameters: { mode: 'runOnceForAllItems', jsCode: FORMAT_CODE }
      },
      {
        id: ids_.reply, name: 'Reply OK',
        type: 'n8n-nodes-base.code', typeVersion: 2,
        position: [1260, 460],
        parameters: {
          mode: 'runOnceForAllItems',
          jsCode: [
            'const r = $input.first().json;',
            'if (r.ok === false) return [{ json: { response: r.error || r.response } }];',
            'return [{ json: { response: r.summary } }];'
          ].join('\n')
        }
      }
    ],
    connections: {
      'Execute Workflow Trigger': { main: [[{ node: 'Buyer Prep', type: 'main', index: 0 }]] },
      'Buyer Prep': { main: [[{ node: 'Gate: Error?', type: 'main', index: 0 }]] },
      'Gate: Error?': {
        main: [
          [{ node: 'Error Reply', type: 'main', index: 0 }],
          [{ node: 'Find Buyers', type: 'main', index: 0 }]
        ]
      },
      'Error Reply': { main: [[{ node: 'Reply OK', type: 'main', index: 0 }]] },
      'Find Buyers': { main: [[{ node: 'Format Result', type: 'main', index: 0 }]] },
      'Format Result': { main: [[{ node: 'Reply OK', type: 'main', index: 0 }]] }
    },
    settings: { executionOrder: 'v1', saveDataSuccessExecution: 'none' }
  };
}

async function createWorkflow(body) {
  const r = await req('POST', '/api/v1/workflows', body);
  if (r.status !== 200) throw new Error('POST /workflows -> ' + r.status + ' ' + r.body.slice(0, 300));
  return JSON.parse(r.body);
}

async function activateWf(id) {
  const r = await req('POST', '/api/v1/workflows/' + id + '/activate');
  if (r.status >= 300) throw new Error('activate ' + id + ' -> ' + r.status);
}

(async () => {
  if (!WRITE) {
    console.log('DRY RUN — would:');
    console.log('  1. Create sub-workflow: find_buyers workflow');
    console.log('  2. Add Tool: find_buyers node to brain (position 2220, 800)');
    console.log('  3. Update Build Context — add find_buyers to tool list');
    console.log('\n(pass --write to apply)');
    return;
  }

  // Step 1: Create sub-workflow
  console.log('Creating find_buyers sub-workflow...');
  const created = await createWorkflow(buildSubWorkflow());
  const subWfId = created.id;
  console.log('Created:', subWfId);

  // Activate it
  await activateWf(subWfId);
  console.log('Activated');

  // Save ID to secrets file
  ids.buyersWfId = subWfId;
  fs.writeFileSync(path.join(SEC_DIR, 'brain-n8n.json'), JSON.stringify(ids, null, 2));
  console.log('ID saved to brain-n8n.json');

  // Step 2: Add toolWorkflow node to brain
  const backupDir = path.resolve(__dirname, '..', '..', '..', 'backups');
  const brain = await getWf(BRAIN_ID);
  fs.writeFileSync(path.join(backupDir, BRAIN_ID + '_before_add_find_buyers.json'), JSON.stringify(brain, null, 2));

  const newToolNode = {
    id: rng(),
    name: 'Tool: find_buyers',
    type: '@n8n/n8n-nodes-langchain.toolWorkflow',
    typeVersion: 2.2,
    position: [2220, 800],
    parameters: {
      description: 'Find potential buyers for a product. Returns buyer names, lead score, deal confidence, and insights. Call when user asks about buyers, customers, or export opportunities for a specific product.',
      workflowId: { __rl: true, mode: 'id', value: subWfId, cachedResultName: 'find_buyers workflow' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          keyword: "={{ $fromAI('keyword', 'Product name or description to find buyers for (e.g. cotton yarn, pharmaceutical drugs)', 'string', '') }}",
          min_score: "={{ $fromAI('min_score', 'Minimum buyer score filter 0-100 (optional, default 0)', 'number', 0) }}"
        },
        matchingColumns: [],
        schema: [
          { id: 'keyword', displayName: 'keyword', required: true, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'min_score', displayName: 'min_score', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false }
        ]
      }
    }
  };

  brain.nodes.push(newToolNode);

  // Add connection: Tool: find_buyers -> Aaziko AI Brain (ai_tool)
  brain.connections['Tool: find_buyers'] = {
    ai_tool: [[{ node: 'Aaziko AI Brain', type: 'ai_tool', index: 0 }]]
  };

  // Step 3: Update Build Context system prompt
  const ctxIdx = brain.nodes.findIndex(n => n.name === 'Build Context');
  if (ctxIdx === -1) throw new Error('Build Context node not found');

  const ctxCode = brain.nodes[ctxIdx].parameters.jsCode;
  const OLD_TOOLS_SECTION = '- get_compliance: call with hs_code and country for import/export documentation requirements.\n\n## RULES';
  const NEW_TOOLS_SECTION = '- get_compliance: call with hs_code and country for import/export documentation requirements.\n- find_buyers: call with keyword (product name) to find potential buyers/importers. Use for questions about who buys a product, export opportunities, customer leads.\n\n## RULES';

  if (!ctxCode.includes(OLD_TOOLS_SECTION)) {
    console.warn('WARNING: Could not find tools section to update. Proceeding without prompt update.');
  } else {
    brain.nodes[ctxIdx].parameters.jsCode = ctxCode.replace(OLD_TOOLS_SECTION, NEW_TOOLS_SECTION);
    console.log('Build Context updated with find_buyers description');
  }

  await putWf(BRAIN_ID, { name: brain.name, nodes: brain.nodes, connections: brain.connections, settings: brain.settings });
  await activate(BRAIN_ID);

  // Verify
  const live = await getWf(BRAIN_ID);
  const lTool = live.nodes.find(n => n.name === 'Tool: find_buyers');
  if (!lTool) throw new Error('Tool node not found in live brain!');
  console.log('\n=== LIVE ===');
  console.log('Tool: find_buyers wired | nodes:', live.nodes.length);
  console.log('sub-wf id:', lTool.parameters.workflowId.value);
  console.log('\n✅ find_buyers tool live');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
