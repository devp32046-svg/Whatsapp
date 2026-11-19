'use strict';
/* Deploy find_port + get_compliance tool sub-workflows for Aaziko Brain.
 *   node aaziko/brain/deploy/build-tools-2.js
 */
const path = require('path');
const fs = require('fs');
const { req } = require('../../../scripts/lib/n8n-req');
const NC = require('../lib/node-code');

function uid() { return Math.random().toString(36).slice(2, 10); }

const SETTINGS = { saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all' };

function makeErrorIf(prevNode, trueTarget, falseTarget) {
  return {
    id: uid(), name: 'Gate: Error?',
    type: 'n8n-nodes-base.if', typeVersion: 2,
    position: [420, 300],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 1 },
        conditions: [{ leftValue: '={{ !!$json._error }}', operator: { type: 'boolean', operation: 'true', singleValue: true }, rightValue: '' }],
        combinator: 'and'
      },
      options: {}
    }
  };
}

function makeSet(name, value, x) {
  return {
    id: uid(), name,
    type: 'n8n-nodes-base.set', typeVersion: 3,
    position: [x, 300],
    parameters: {
      mode: 'manual',
      assignments: { assignments: [{ id: '1', name: 'output', value, type: 'string' }] }
    }
  };
}

function makeCode(name, jsCode, x) {
  return {
    id: uid(), name,
    type: 'n8n-nodes-base.code', typeVersion: 2,
    position: [x, 300],
    parameters: { jsCode }
  };
}

function makeMongo(name, collection, credId, credName, queryExpr, x, limit) {
  return {
    id: uid(), name,
    type: 'n8n-nodes-base.mongoDb', typeVersion: 1.3,
    position: [x, 420],
    parameters: {
      operation: 'find',
      collection,
      query: queryExpr,
      options: { limit: limit || 10 }
    },
    credentials: { mongoDb: { id: credId, name: credName } }
  };
}

function makeTrigger() {
  return {
    id: uid(), name: 'Execute Workflow Trigger',
    type: 'n8n-nodes-base.executeWorkflowTrigger',
    typeVersion: 1,
    position: [0, 300],
    parameters: {}
  };
}

(async () => {
  // ─── Workflow 1: find_port ─────────────────────────────────────────────────
  console.log('\n--- Building find_port ---');
  const portPrep = makeCode('Port Prep', NC.TOOL_PORT_PREP, 200);
  const portGate = makeErrorIf();
  const portErr = makeSet('Respond Error', "={{ $('Port Prep').first().json._error }}", 640);
  portErr.position = [640, 180];
  const portFind = makeMongo('Find Ports', 'detailed_ports', 'OXJ4UVacMY1qofx6', 'Aaziko Brain - searates (ports)',
    "={{ $('Port Prep').first().json.matchQuery }}", 640);
  const portFmt = makeCode('Format Result', NC.TOOL_PORT_FORMAT, 860);
  const portOK = makeSet('Respond OK', '={{ $json.summary || $json.error }}', 1080);

  const portNodes = [makeTrigger(), portPrep, portGate, portErr, portFind, portFmt, portOK];
  const portConnections = {
    'Execute Workflow Trigger': { main: [[{ node: 'Port Prep', type: 'main', index: 0 }]] },
    'Port Prep': { main: [[{ node: 'Gate: Error?', type: 'main', index: 0 }]] },
    'Gate: Error?': {
      main: [
        [{ node: 'Respond Error', type: 'main', index: 0 }],
        [{ node: 'Find Ports', type: 'main', index: 0 }]
      ]
    },
    'Find Ports': { main: [[{ node: 'Format Result', type: 'main', index: 0 }]] },
    'Format Result': { main: [[{ node: 'Respond OK', type: 'main', index: 0 }]] }
  };

  const portR = await req('POST', '/api/v1/workflows', {
    name: 'Aaziko — Tool: find_port',
    nodes: portNodes, connections: portConnections, settings: SETTINGS
  });
  const portCreated = JSON.parse(portR.body);
  if (!portCreated.id) { console.error('FAILED create port:', portR.body.slice(0, 300)); process.exit(1); }
  console.log('Created portWfId:', portCreated.id);
  await req('POST', '/api/v1/workflows/' + portCreated.id + '/activate');
  const portCheck = JSON.parse((await req('GET', '/api/v1/workflows/' + portCreated.id)).body);
  console.log('find_port active:', portCheck.active, '| nodes:', portCheck.nodes.length);

  // ─── Workflow 2: get_compliance ────────────────────────────────────────────
  console.log('\n--- Building get_compliance ---');
  const compPrep = makeCode('Compliance Prep', NC.TOOL_COMPLIANCE_PREP, 200);
  const compGate = makeErrorIf();
  const compErr = makeSet('Respond Error', "={{ $('Compliance Prep').first().json._error }}", 640);
  compErr.position = [640, 180];
  const compFind = makeMongo('Find Compliance', 'aaziko-import-export-1_organized',
    '9hyaSxc0saIzUgsX', 'Aaziko Brain - organized (compliance)',
    "={{ $('Compliance Prep').first().json.matchQuery }}", 640, 5);
  const compFmt = makeCode('Format Result', NC.TOOL_COMPLIANCE_FORMAT, 860);
  const compOK = makeSet('Respond OK', '={{ $json.summary || $json.error }}', 1080);

  const compNodes = [makeTrigger(), compPrep, compGate, compErr, compFind, compFmt, compOK];
  const compConnections = {
    'Execute Workflow Trigger': { main: [[{ node: 'Compliance Prep', type: 'main', index: 0 }]] },
    'Compliance Prep': { main: [[{ node: 'Gate: Error?', type: 'main', index: 0 }]] },
    'Gate: Error?': {
      main: [
        [{ node: 'Respond Error', type: 'main', index: 0 }],
        [{ node: 'Find Compliance', type: 'main', index: 0 }]
      ]
    },
    'Find Compliance': { main: [[{ node: 'Format Result', type: 'main', index: 0 }]] },
    'Format Result': { main: [[{ node: 'Respond OK', type: 'main', index: 0 }]] }
  };

  const compR = await req('POST', '/api/v1/workflows', {
    name: 'Aaziko — Tool: get_compliance',
    nodes: compNodes, connections: compConnections, settings: SETTINGS
  });
  const compCreated = JSON.parse(compR.body);
  if (!compCreated.id) { console.error('FAILED create compliance:', compR.body.slice(0, 300)); process.exit(1); }
  console.log('Created complianceWfId:', compCreated.id);
  await req('POST', '/api/v1/workflows/' + compCreated.id + '/activate');
  const compCheck = JSON.parse((await req('GET', '/api/v1/workflows/' + compCreated.id)).body);
  console.log('get_compliance active:', compCheck.active, '| nodes:', compCheck.nodes.length);

  // ─── Update brain-n8n.json ────────────────────────────────────────────────
  const idsPath = path.resolve(__dirname, '..', '..', '.secrets', 'brain-n8n.json');
  const ids = JSON.parse(fs.readFileSync(idsPath, 'utf8'));
  ids.portWfId = portCreated.id;
  ids.complianceWfId = compCreated.id;
  fs.writeFileSync(idsPath, JSON.stringify(ids, null, 2));
  console.log('\nbrain-n8n.json updated:');
  console.log('  portWfId:', portCreated.id);
  console.log('  complianceWfId:', compCreated.id);

  if (portCheck.active && portCheck.nodes.length === 7 && compCheck.active && compCheck.nodes.length === 7) {
    console.log('\n✅ Both workflows LIVE and correct');
  } else {
    console.log('\n⚠ Check node counts: port=' + portCheck.nodes.length + ' compliance=' + compCheck.nodes.length);
  }
})().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
