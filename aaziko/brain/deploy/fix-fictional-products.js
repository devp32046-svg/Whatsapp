'use strict';
/*
 * Fix: brain timeouts on fictional/non-existent products (flying cars, etc.)
 * Add rule: detect fictional items and reply instantly without calling any tool.
 *
 * node aaziko/brain/deploy/fix-fictional-products.js         -- dry run
 * node aaziko/brain/deploy/fix-fictional-products.js --write -- deploy
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');
const WF_ID = 'w7no6uCJkz7lfaah';
const WRITE = process.argv.includes('--write');

const ANCHOR = '- Services (IT, software, consulting, tourism, education, finance) have NO HS code';
const NEW_RULE = '- Fictional, non-existent or science-fiction items (flying cars, teleporters, lightsabers, unicorns, etc.) do not exist in trade databases. Respond immediately: "Yeh product real trade mein exist nahi karta — HS code nahi milega." Do NOT call any tool for clearly fictional products.\n';

console.log('Rule to add:');
console.log(NEW_RULE);
if (!WRITE) { console.log('(dry run — pass --write to deploy)'); process.exit(0); }

(async () => {
  const wf = await getWf(WF_ID);
  const bc = wf.nodes.find(n => n.name === 'Build Context');
  if (!bc) { console.log('❌ Build Context not found'); process.exit(1); }

  const code = bc.parameters.jsCode;
  if (code.includes('Fictional, non-existent')) { console.log('Rule already present.'); process.exit(0); }
  if (!code.includes(ANCHOR)) { console.log('❌ Anchor (services rule) not found'); process.exit(1); }

  fs.writeFileSync(path.join(BACKUP_DIR, WF_ID + '_before_fictional_rule.json'), JSON.stringify(wf, null, 2), 'utf8');
  console.log('Backup saved.');

  bc.parameters.jsCode = code.replace(ANCHOR, NEW_RULE + ANCHOR);

  const settings = Object.assign({}, wf.settings); delete settings.binaryMode;
  const r = await putWf(WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) { console.log('❌ PUT failed:', r.body.slice(0, 300)); process.exit(1); }
  await activate(WF_ID);

  const check = await getWf(WF_ID);
  const bc2 = check.nodes.find(n => n.name === 'Build Context');
  const ok = bc2.parameters.jsCode.includes('Fictional, non-existent');
  console.log((ok ? '✅' : '❌') + ' Fictional products rule deployed');
  if (ok) console.log('\nTest: "flying cars export HS code kya hai?" should reply instantly, no timeout');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
