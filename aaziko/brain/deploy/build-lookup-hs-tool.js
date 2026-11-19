'use strict';
/* Build & wire lookup_hs_code tool to Aaziko Brain:
 *   1. Create sub-workflow: fast HS6 → product description lookup
 *      Uses aaziko_organized.map_products_organized indexed on applicability.product.hs6
 *   2. Add Tool: lookup_hs_code node to brain
 *   3. Update Build Context system prompt
 *
 * node aaziko/brain/deploy/build-lookup-hs-tool.js          -- dry run
 * node aaziko/brain/deploy/build-lookup-hs-tool.js --write  -- create + wire
 */
const path = require('path'), fs = require('fs');
const { req, getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const SEC_DIR = path.resolve(__dirname, '..', '..', '.secrets');
const ids = JSON.parse(fs.readFileSync(path.join(SEC_DIR, 'brain-n8n.json'), 'utf8'));
const WRITE = process.argv.includes('--write');
const BRAIN_ID = ids.brainWfId;

const REMINDERS_CRED = { id: 'Hxh39r3Fnn77hr55', name: 'Aaziko Reminders Mongo (aaziko_reminders ONLY)' };
const rng = () => Math.random().toString(36).slice(2, 10);

const PREP_CODE = [
  'let inp = {};',
  'try { inp = typeof $input.first().json === "string" ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}',
  '',
  '// Accept hs_code (6-digit) or product_name for reverse lookup',
  'const hsRaw = String(inp.hs_code || inp.hs || "").replace(/\\D/g, "").slice(0, 6);',
  'const productName = String(inp.product_name || inp.product || inp.keyword || "").trim();',
  '',
  'if (!hsRaw && !productName) {',
  '  return [{ json: { _error: "Provide hs_code (6-digit, e.g. 520100) or product_name" } }];',
  '}',
  '',
  'var filter = { kind: "market_stat" };',
  'if (hsRaw) {',
  '  // Exact hs6 lookup — indexed, fast',
  '  filter["applicability.product.hs6"] = hsRaw;',
  '} else {',
  '  // Keyword search on product_name — no text index, limit results',
  '  var kw = productName.replace(/[.*+?^$()|[{}\\\\]/g, "\\\\$&");',
  '  filter["structured.product_name"] = { "$regex": kw, "$options": "i" };',
  '}',
  '',
  'return [{ json: { hs: hsRaw, product_name: productName, matchQuery: JSON.stringify(filter) } }];'
].join('\n');

const FORMAT_CODE = [
  'const data = $input.first().json;',
  'const prep = $("HS Prep").first().json;',
  'const rows = data.rows || [];',
  '',
  'if (prep._error) return [{ json: { ok: false, error: prep._error } }];',
  'if (!rows.length) {',
  '  var notFound = prep.hs',
  '    ? "HS code " + prep.hs + " not found in database"',
  '    : "No HS codes found for product: " + prep.product_name;',
  '  return [{ json: { ok: false, error: notFound } }];',
  '}',
  '',
  '// Deduplicate by hs6',
  'var seen = {};',
  'var unique = rows.filter(function(r) {',
  '  var hs = (r.applicability && r.applicability.product && r.applicability.product.hs6) || "";',
  '  if (seen[hs]) return false;',
  '  seen[hs] = true;',
  '  return true;',
  '});',
  '',
  'var lines = unique.slice(0, 5).map(function(r) {',
  '  var hs6 = (r.applicability && r.applicability.product && r.applicability.product.hs6) || "?";',
  '  var pn = (r.structured && r.structured.product_name) || "?";',
  '  var ntm = (r.structured && r.structured.ntm_count) ? " | NTMs: " + r.structured.ntm_count : "";',
  '  var tariffYr = (r.structured && r.structured.tariff_year) ? " | Tariff year: " + r.structured.tariff_year : "";',
  '  return "• HS " + hs6 + ": " + pn + ntm + tariffYr;',
  '});',
  '',
  'var title = prep.hs',
  '  ? "HS code " + prep.hs + " description:"',
  '  : "HS codes matching \\"" + prep.product_name + "\\" (" + unique.length + " found):";',
  'var summary = title + "\\n" + lines.join("\\n");',
  'return [{ json: { ok: true, summary: summary, rowCount: unique.length } }];'
].join('\n');

function buildSubWorkflow() {
  const nids = {
    trigger: rng(), prep: rng(), gate: rng(),
    errReply: rng(), findNode: rng(), fmt: rng(), reply: rng()
  };
  return {
    name: 'lookup_hs_code workflow',
    nodes: [
      {
        id: nids.trigger, name: 'Execute Workflow Trigger',
        type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1,
        position: [260, 460], parameters: {}
      },
      {
        id: nids.prep, name: 'HS Prep',
        type: 'n8n-nodes-base.code', typeVersion: 2,
        position: [460, 460],
        parameters: { mode: 'runOnceForAllItems', jsCode: PREP_CODE }
      },
      {
        id: nids.gate, name: 'Gate: Error?',
        type: 'n8n-nodes-base.if', typeVersion: 2,
        position: [660, 460],
        parameters: {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
            conditions: [{ id: rng(), leftValue: '={{ $json._error }}', operator: { type: 'string', operation: 'notEmpty' }, rightValue: '' }]
          },
          combinator: 'and'
        }
      },
      {
        id: nids.errReply, name: 'Error Reply',
        type: 'n8n-nodes-base.code', typeVersion: 2,
        position: [860, 360],
        parameters: {
          mode: 'runOnceForAllItems',
          jsCode: 'return [{ json: { ok: false, response: $("HS Prep").first().json._error } }];'
        }
      },
      {
        id: nids.findNode, name: 'Find HS',
        type: 'n8n-nodes-base.mongoDb', typeVersion: 1.3,
        position: [860, 560],
        parameters: {
          operation: 'aggregate',
          collection: 'map_products_organized',
          databaseName: 'aaziko_organized',
          query: "={{ JSON.stringify([{\"$match\":JSON.parse($('HS Prep').first().json.matchQuery)},{\"$facet\":{\"rows\":[{\"$limit\":10}]}}]) }}"
        },
        credentials: { mongoDb: REMINDERS_CRED }
      },
      {
        id: nids.fmt, name: 'Format Result',
        type: 'n8n-nodes-base.code', typeVersion: 2,
        position: [1060, 560],
        parameters: { mode: 'runOnceForAllItems', jsCode: FORMAT_CODE }
      },
      {
        id: nids.reply, name: 'Reply OK',
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
      'Execute Workflow Trigger': { main: [[{ node: 'HS Prep', type: 'main', index: 0 }]] },
      'HS Prep': { main: [[{ node: 'Gate: Error?', type: 'main', index: 0 }]] },
      'Gate: Error?': {
        main: [
          [{ node: 'Error Reply', type: 'main', index: 0 }],
          [{ node: 'Find HS', type: 'main', index: 0 }]
        ]
      },
      'Error Reply': { main: [[{ node: 'Reply OK', type: 'main', index: 0 }]] },
      'Find HS': { main: [[{ node: 'Format Result', type: 'main', index: 0 }]] },
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
    console.log('  1. Create sub-workflow: lookup_hs_code workflow');
    console.log('  2. Add Tool: lookup_hs_code node to brain (position 2420, 800)');
    console.log('  3. Update Build Context — add lookup_hs_code to tool list');
    console.log('\n(pass --write to apply)');
    return;
  }

  // Step 1: Create sub-workflow
  console.log('Creating lookup_hs_code sub-workflow...');
  const created = await createWorkflow(buildSubWorkflow());
  const subWfId = created.id;
  console.log('Created:', subWfId);

  await activateWf(subWfId);
  console.log('Activated');

  ids.hsLookupWfId = subWfId;
  fs.writeFileSync(path.join(SEC_DIR, 'brain-n8n.json'), JSON.stringify(ids, null, 2));
  console.log('ID saved to brain-n8n.json');

  // Step 2: Wire to brain
  const backupDir = path.resolve(__dirname, '..', '..', '..', 'backups');
  const brain = await getWf(BRAIN_ID);
  fs.writeFileSync(path.join(backupDir, BRAIN_ID + '_before_add_lookup_hs.json'), JSON.stringify(brain, null, 2));

  const newToolNode = {
    id: rng(),
    name: 'Tool: lookup_hs_code',
    type: '@n8n/n8n-nodes-langchain.toolWorkflow',
    typeVersion: 2.2,
    position: [2420, 800],
    parameters: {
      description: 'Look up HS code description from code number, OR find HS codes for a product name. Call for: "what is HS 520100?", "what HS code is used for cotton?", "find HS code for spices".',
      workflowId: { __rl: true, mode: 'id', value: subWfId, cachedResultName: 'lookup_hs_code workflow' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          hs_code: "={{ $fromAI('hs_code', '6-digit HS code to look up (e.g. 520100). Leave empty if searching by product name.', 'string', '') }}",
          product_name: "={{ $fromAI('product_name', 'Product name to find HS code for (e.g. cotton yarn). Leave empty if providing hs_code.', 'string', '') }}"
        },
        matchingColumns: [],
        schema: [
          { id: 'hs_code', displayName: 'hs_code', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'product_name', displayName: 'product_name', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false }
        ]
      }
    }
  };

  brain.nodes.push(newToolNode);
  brain.connections['Tool: lookup_hs_code'] = {
    ai_tool: [[{ node: 'Aaziko AI Brain', type: 'ai_tool', index: 0 }]]
  };

  // Step 3: Update Build Context
  const ctxIdx = brain.nodes.findIndex(n => n.name === 'Build Context');
  if (ctxIdx === -1) throw new Error('Build Context node not found');

  const ctxCode = brain.nodes[ctxIdx].parameters.jsCode;
  // The buyers tool may have already been added, handle both cases
  const OLD_MARKER = '- find_buyers: call with keyword (product name) to find potential buyers/importers. Use for questions about who buys a product, export opportunities, customer leads.\n\n## RULES';
  const NEW_MARKER = '- find_buyers: call with keyword (product name) to find potential buyers/importers. Use for questions about who buys a product, export opportunities, customer leads.\n- lookup_hs_code: call with hs_code (6-digit) for description, OR product_name for reverse HS code lookup. Use for "what is HS XXXX" or "what HS code for cotton".\n\n## RULES';

  const OLD_MARKER2 = '- get_compliance: call with hs_code and country for import/export documentation requirements.\n\n## RULES';
  const NEW_MARKER2 = '- get_compliance: call with hs_code and country for import/export documentation requirements.\n- lookup_hs_code: call with hs_code (6-digit) for description, OR product_name for reverse HS code lookup. Use for "what is HS XXXX" or "what HS code for cotton".\n\n## RULES';

  let updated = ctxCode;
  if (ctxCode.includes(OLD_MARKER)) {
    updated = ctxCode.replace(OLD_MARKER, NEW_MARKER);
    console.log('Build Context updated (after find_buyers)');
  } else if (ctxCode.includes(OLD_MARKER2)) {
    updated = ctxCode.replace(OLD_MARKER2, NEW_MARKER2);
    console.log('Build Context updated (after get_compliance)');
  } else {
    console.warn('WARNING: Could not find insertion point in Build Context');
  }
  brain.nodes[ctxIdx].parameters.jsCode = updated;

  await putWf(BRAIN_ID, { name: brain.name, nodes: brain.nodes, connections: brain.connections, settings: brain.settings });
  await activate(BRAIN_ID);

  // Verify
  const live = await getWf(BRAIN_ID);
  const lTool = live.nodes.find(n => n.name === 'Tool: lookup_hs_code');
  if (!lTool) throw new Error('Tool node not found in live brain!');
  console.log('\n=== LIVE ===');
  console.log('Tool: lookup_hs_code wired | nodes:', live.nodes.length);
  console.log('sub-wf id:', lTool.parameters.workflowId.value);
  console.log('\n✅ lookup_hs_code tool live');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
