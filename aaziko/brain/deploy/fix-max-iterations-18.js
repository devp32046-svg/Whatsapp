'use strict';
/*
 * Increase brain maxIterations 15 → 18 to handle compound multi-tool queries
 * (e.g. "leather jackets Germany export HS code + buyers + tariff" in one turn)
 *
 * node aaziko/brain/deploy/fix-max-iterations-18.js         -- dry run
 * node aaziko/brain/deploy/fix-max-iterations-18.js --write -- deploy
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');
const WF_ID = 'w7no6uCJkz7lfaah';
const WRITE = process.argv.includes('--write');

console.log('Change: maxIterations 15 → 18 on Aaziko AI Brain agent node');
if (!WRITE) { console.log('(dry run — pass --write to deploy)'); process.exit(0); }

(async () => {
  const wf = await getWf(WF_ID);
  const agent = wf.nodes.find(n => n.name === 'Aaziko AI Brain');
  if (!agent) { console.log('❌ Aaziko AI Brain node not found'); process.exit(1); }

  const cur = agent.parameters?.options?.maxIterations;
  console.log('Current maxIterations:', cur);
  if (cur >= 18) { console.log('Already >= 18 — done.'); process.exit(0); }

  fs.writeFileSync(path.join(BACKUP_DIR, WF_ID + '_before_maxiter18.json'), JSON.stringify(wf, null, 2), 'utf8');
  console.log('Backup saved.');

  agent.parameters.options.maxIterations = 18;

  const settings = Object.assign({}, wf.settings); delete settings.binaryMode;
  const r = await putWf(WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) { console.log('❌ PUT failed:', r.body.slice(0, 300)); process.exit(1); }
  await activate(WF_ID);

  const check = await getWf(WF_ID);
  const a2 = check.nodes.find(n => n.name === 'Aaziko AI Brain');
  const ok = a2.parameters?.options?.maxIterations === 18;
  console.log((ok?'✅':'❌') + ' maxIterations = ' + a2.parameters?.options?.maxIterations);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
