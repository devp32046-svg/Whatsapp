'use strict';
/* Deploy Aaziko tool sub-workflows: search_tariff + search_products
 *   node aaziko/brain/deploy/build-tools.js          -- dry-run (shows plan)
 *   node aaziko/brain/deploy/build-tools.js --write  -- creates/activates on n8n
 */
const path = require('path'), fs = require('fs');
const { req, activate, RROOT } = require('../../../scripts/lib/n8n-req');
const NC = require('../lib/node-code');

const SEC_DIR = path.resolve(__dirname, '..', '..', '.secrets');
const IDS_FILE = path.join(SEC_DIR, 'brain-n8n.json');

const WRITE = process.argv.includes('--write');

// ── credential IDs (created 2026-11-18) ──────────────────────────────────────
const CRED_WITS      = 'wh4qdyGdVZCVuW1O';
const CRED_INDIAMART = 'g9NnHH7ocvb52kdM';

// ── uuid helper ───────────────────────────────────────────────────────────────
let _uid = 0;
const uid = () => 'az-' + (++_uid).toString(36) + '-' + Math.random().toString(36).slice(2, 8);

// ── build search_tariff workflow ──────────────────────────────────────────────
function buildTariffWf() {
  const nodes = [
    {
      id: uid(), name: 'Execute Workflow Trigger',
      type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1,
      position: [100, 300], parameters: {}
    },
    {
      id: uid(), name: 'Tariff Prep',
      type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [320, 300],
      parameters: { jsCode: NC.TOOL_TARIFF_PREP }
    },
    {
      id: uid(), name: 'Gate: Error?',
      type: 'n8n-nodes-base.if', typeVersion: 2,
      position: [540, 300],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 1 },
          conditions: [{
            leftValue: '={{ !!$json._error }}',
            operator: { type: 'boolean', operation: 'true', singleValue: true },
            rightValue: ''
          }],
          combinator: 'and'
        }
      }
    },
    {
      id: uid(), name: 'Error Reply',
      type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [760, 180],
      parameters: { jsCode: "return [{ json: { output: 'Error: ' + ($('Tariff Prep').first().json._error || 'unknown') } }];" }
    },
    {
      id: uid(), name: 'Find Tariff',
      type: 'n8n-nodes-base.mongoDb', typeVersion: 1.3,
      position: [760, 420],
      parameters: {
        operation: 'find',
        collection: 'tariff_trains',
        query: "={{ $('Tariff Prep').first().json.matchQuery }}",
        options: { limit: 10 }
      },
      credentials: { mongoDb: { id: CRED_WITS, name: 'Aaziko Brain - wits (tariff)' } }
    },
    {
      id: uid(), name: 'Format Result',
      type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [980, 420],
      parameters: { jsCode: NC.TOOL_TARIFF_FORMAT }
    },
    {
      id: uid(), name: 'Reply OK',
      type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [1200, 420],
      parameters: { jsCode: "return [{ json: { output: $input.first().json.summary || $input.first().json.error || '' } }];" }
    }
  ];

  const nmap = {};
  nodes.forEach(n => { nmap[n.name] = n.name; });

  const connections = {
    'Execute Workflow Trigger': { main: [[{ node: 'Tariff Prep', type: 'main', index: 0 }]] },
    'Tariff Prep':              { main: [[{ node: 'Gate: Error?', type: 'main', index: 0 }]] },
    'Gate: Error?': {
      main: [
        [{ node: 'Error Reply', type: 'main', index: 0 }],   // true branch
        [{ node: 'Find Tariff', type: 'main', index: 0 }]    // false branch
      ]
    },
    'Find Tariff':   { main: [[{ node: 'Format Result', type: 'main', index: 0 }]] },
    'Format Result': { main: [[{ node: 'Reply OK', type: 'main', index: 0 }]] }
  };

  return {
    name: 'Aaziko — Tool: search_tariff',
    nodes,
    connections,
    settings: { saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all' }
  };
}

// ── build search_products workflow ────────────────────────────────────────────
function buildProductWf() {
  const nodes = [
    {
      id: uid(), name: 'Execute Workflow Trigger',
      type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1,
      position: [100, 300], parameters: {}
    },
    {
      id: uid(), name: 'Product Prep',
      type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [320, 300],
      parameters: { jsCode: NC.TOOL_PRODUCT_PREP }
    },
    {
      id: uid(), name: 'Gate: Error?',
      type: 'n8n-nodes-base.if', typeVersion: 2,
      position: [540, 300],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 1 },
          conditions: [{
            leftValue: '={{ !!$json._error }}',
            operator: { type: 'boolean', operation: 'true', singleValue: true },
            rightValue: ''
          }],
          combinator: 'and'
        }
      }
    },
    {
      id: uid(), name: 'Error Reply',
      type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [760, 180],
      parameters: { jsCode: "return [{ json: { output: 'Error: ' + ($('Product Prep').first().json._error || 'unknown') } }];" }
    },
    {
      id: uid(), name: 'Find Products',
      type: 'n8n-nodes-base.mongoDb', typeVersion: 1.3,
      position: [760, 420],
      parameters: {
        operation: 'find',
        collection: 'products',
        query: "={{ $('Product Prep').first().json.matchQuery }}",
        options: { limit: 10 }
      },
      credentials: { mongoDb: { id: CRED_INDIAMART, name: 'Aaziko Brain - indiamart (products)' } }
    },
    {
      id: uid(), name: 'Format Result',
      type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [980, 420],
      parameters: { jsCode: NC.TOOL_PRODUCT_FORMAT }
    },
    {
      id: uid(), name: 'Reply OK',
      type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [1200, 420],
      parameters: { jsCode: "return [{ json: { output: $input.first().json.summary || $input.first().json.error || '' } }];" }
    }
  ];

  const connections = {
    'Execute Workflow Trigger': { main: [[{ node: 'Product Prep', type: 'main', index: 0 }]] },
    'Product Prep':             { main: [[{ node: 'Gate: Error?', type: 'main', index: 0 }]] },
    'Gate: Error?': {
      main: [
        [{ node: 'Error Reply', type: 'main', index: 0 }],
        [{ node: 'Find Products', type: 'main', index: 0 }]
      ]
    },
    'Find Products': { main: [[{ node: 'Format Result', type: 'main', index: 0 }]] },
    'Format Result': { main: [[{ node: 'Reply OK', type: 'main', index: 0 }]] }
  };

  return {
    name: 'Aaziko — Tool: search_products',
    nodes,
    connections,
    settings: { saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all' }
  };
}

// ── deploy helper ─────────────────────────────────────────────────────────────
async function deploy(wf) {
  const r = await req('POST', '/api/v1/workflows', wf);
  if (r.status !== 200) throw new Error('POST failed: ' + r.status + ' ' + r.body.slice(0, 300));
  const created = JSON.parse(r.body);
  const id = created.id;
  await activate(id);
  // read back
  const rb = await req('GET', '/api/v1/workflows/' + id);
  const live = JSON.parse(rb.body);
  return { id, active: live.active, nodeCount: live.nodes.length, name: live.name };
}

(async () => {
  console.log('Building search_tariff and search_products tool workflows...');
  const tariffWf  = buildTariffWf();
  const productWf = buildProductWf();

  console.log('search_tariff nodes:', tariffWf.nodes.map(n => n.name));
  console.log('search_products nodes:', productWf.nodes.map(n => n.name));

  if (!WRITE) {
    console.log('\nDry-run. Pass --write to deploy.');
    return;
  }

  console.log('\nDeploying search_tariff...');
  const t = await deploy(tariffWf);
  console.log('  ID:', t.id, '| active:', t.active, '| nodes:', t.nodeCount, '| name:', t.name);

  console.log('Deploying search_products...');
  const p = await deploy(productWf);
  console.log('  ID:', p.id, '| active:', p.active, '| nodes:', p.nodeCount, '| name:', p.name);

  // Write IDs to secrets file
  const ids = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8'));
  ids.tariffWfId  = t.id;
  ids.productWfId = p.id;
  fs.writeFileSync(IDS_FILE, JSON.stringify(ids, null, 2) + '\n', 'utf8');
  console.log('\nIDs written to brain-n8n.json');
  console.log('tariffWfId:', t.id);
  console.log('productWfId:', p.id);

  if (!t.active || !p.active) { console.error('One or both workflows NOT active!'); process.exit(1); }
  console.log('\nBoth workflows deployed and active.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
