'use strict';
/*
 * Fix Find Tariff node — restore query from hardcoded $count back to expression.
 * node aaziko/brain/deploy/fix-tariff-query-expression.js          -- dry run
 * node aaziko/brain/deploy/fix-tariff-query-expression.js --write  -- apply
 */
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const WF_ID = 'k71O78yLV0v0TXZl';
const WRITE = process.argv.includes('--write');

// The correct expression — $('Tariff Prep').first().json.pipeline
const CORRECT_QUERY = "={{ $('Tariff Prep').first().json.pipeline }}";

(async () => {
  const wf = await getWf(WF_ID);
  const findNode = wf.nodes.find(n => n.name === 'Find Tariff');
  if (!findNode) { console.log('ERR: Find Tariff node not found'); return; }

  console.log('BEFORE query:', findNode.parameters.query);

  if (findNode.parameters.query === CORRECT_QUERY) {
    console.log('Already correct — no change needed ✅');
    return;
  }

  if (!WRITE) {
    console.log('DRY RUN — would set query to:', CORRECT_QUERY);
    console.log('\n(pass --write to apply)');
    return;
  }

  findNode.parameters.query = CORRECT_QUERY;

  await putWf(WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings });
  await activate(WF_ID);

  const check = await getWf(WF_ID);
  const checkNode = check.nodes.find(n => n.name === 'Find Tariff');
  const live = checkNode.parameters.query;
  console.log('Live query:', live);
  console.log(live === CORRECT_QUERY ? 'FIX OK ✅' : 'FIX FAILED ❌ got: ' + live);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
