'use strict';
/* Smoke test: verify find_port + get_compliance are live with correct nodes.
 *   node aaziko/brain/deploy/smoke-tools-2.js
 */
const path = require('path');
const fs = require('fs');
const { req } = require('../../../scripts/lib/n8n-req');

const idsPath = path.resolve(__dirname, '..', '..', '.secrets', 'brain-n8n.json');
const ids = JSON.parse(fs.readFileSync(idsPath, 'utf8'));

let fails = 0;
function ck(label, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + label);
  if (!cond) fails++;
}

(async () => {
  // find_port
  const portWf = JSON.parse((await req('GET', '/api/v1/workflows/' + ids.portWfId)).body);
  const portNames = portWf.nodes.map(n => n.name);
  ck('find_port: active', portWf.active === true);
  ck('find_port: has Execute Workflow Trigger', portNames.includes('Execute Workflow Trigger'));
  ck('find_port: has Port Prep', portNames.includes('Port Prep'));
  ck('find_port: has Find Ports', portNames.includes('Find Ports'));
  ck('find_port: has Format Result', portNames.includes('Format Result'));
  ck('find_port: has Respond OK', portNames.includes('Respond OK'));
  ck('find_port: has Respond Error', portNames.includes('Respond Error'));
  ck('find_port: 7 nodes', portWf.nodes.length === 7);

  // get_compliance
  const compWf = JSON.parse((await req('GET', '/api/v1/workflows/' + ids.complianceWfId)).body);
  const compNames = compWf.nodes.map(n => n.name);
  ck('get_compliance: active', compWf.active === true);
  ck('get_compliance: has Execute Workflow Trigger', compNames.includes('Execute Workflow Trigger'));
  ck('get_compliance: has Compliance Prep', compNames.includes('Compliance Prep'));
  ck('get_compliance: has Find Compliance', compNames.includes('Find Compliance'));
  ck('get_compliance: has Format Result', compNames.includes('Format Result'));
  ck('get_compliance: has Respond OK', compNames.includes('Respond OK'));
  ck('get_compliance: has Respond Error', compNames.includes('Respond Error'));
  ck('get_compliance: 7 nodes', compWf.nodes.length === 7);

  console.log(fails ? ('\n' + fails + ' SMOKE CHECK(S) FAILED') : '\nALL SMOKE CHECKS PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
