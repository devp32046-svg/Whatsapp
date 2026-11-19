'use strict';
/*
 * Update tool descriptions in the Aaziko brain so the model calls them reliably.
 * Issues found in full conversation test:
 *   - search_products: brain said "no access to IndiaMart" (desc didn't mention it)
 *   - get_compliance: brain said "tools don't have that" for anti-dumping queries
 *
 * node aaziko/brain/deploy/fix-tool-descriptions.js          -- dry run
 * node aaziko/brain/deploy/fix-tool-descriptions.js --write  -- apply
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const WRITE = process.argv.includes('--write');
const BRAIN_ID = 'w7no6uCJkz7lfaah';

const NEW_DESCRIPTIONS = {
  'Tool: search_products': [
    'Search the IndiaMArt product catalog for suppliers and products by keyword.',
    'Returns product names, company names, and locations.',
    'Call for: "show me cotton products on IndiaMart", "find suppliers for rice",',
    '"textile manufacturers", "spice exporters list", "who sells raw cotton".',
  ].join(' '),

  'Tool: get_compliance': [
    'Get import/export compliance requirements, trade remedies, anti-dumping duties,',
    'NTM (non-tariff measures), and import restrictions by HS code and/or country.',
    'Call for: "anti-dumping on cotton from India", "import restrictions for HS 5201",',
    '"NTM measures", "trade barriers", "export compliance India to USA",',
    '"what documents needed to export cotton".',
  ].join(' '),
};

(async () => {
  const wf = await getWf(BRAIN_ID);

  const toolNodes = wf.nodes.filter(n =>
    n.type === '@n8n/n8n-nodes-langchain.toolWorkflow' ||
    n.type.includes('toolWorkflow')
  );

  console.log(`Brain: ${wf.name} (${BRAIN_ID})\n`);

  let changed = false;
  for (const node of toolNodes) {
    const newDesc = NEW_DESCRIPTIONS[node.name];
    if (!newDesc) continue;

    const oldDesc = node.parameters && node.parameters.description;
    console.log(`Node: ${node.name}`);
    console.log(`  OLD: ${oldDesc}`);
    console.log(`  NEW: ${newDesc}`);

    if (WRITE) {
      node.parameters.description = newDesc;
      changed = true;
    }
  }

  if (!WRITE) {
    console.log('\n(dry run — pass --write to apply)');
    return;
  }

  if (!changed) {
    console.log('\nNothing to change.');
    return;
  }

  // Backup
  const bk = path.join(path.resolve(__dirname, '../../../backups'), BRAIN_ID + '_before_tool-desc-fix.json');
  fs.writeFileSync(bk, JSON.stringify(wf, null, 2), 'utf8');
  console.log(`\nBackup: ${bk}`);

  const settings = Object.assign({}, wf.settings);
  delete settings.binaryMode;

  const r = await putWf(BRAIN_ID, {
    name: wf.name, nodes: wf.nodes, connections: wf.connections, settings,
  });

  if (r.status === 200) {
    await activate(BRAIN_ID);
    // Read-back verify
    const check = await getWf(BRAIN_ID);
    for (const nodeName of Object.keys(NEW_DESCRIPTIONS)) {
      const cn = check.nodes.find(n => n.name === nodeName);
      const liveDesc = cn && cn.parameters && cn.parameters.description;
      const ok = liveDesc === NEW_DESCRIPTIONS[nodeName];
      console.log(ok ? `✅ ${nodeName} — updated` : `❌ ${nodeName} — VERIFY FAILED`);
      if (!ok) console.log(`  Live: ${liveDesc}`);
    }
  } else {
    console.log(`❌ PUT failed (${r.status}): ${JSON.stringify(r.body).slice(0, 200)}`);
    process.exit(1);
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
