'use strict';
/*
 * Fix: brain asks "what kind of animal?" when user types "sheep", "cow", etc.
 * Add rule to system prompt: animal names in trade = products derived from them.
 *
 * node aaziko/brain/deploy/fix-animal-product-rule.js         -- dry run
 * node aaziko/brain/deploy/fix-animal-product-rule.js --write -- deploy
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');
const WF_ID = 'w7no6uCJkz7lfaah';
const WRITE = process.argv.includes('--write');

const OLD_ANCHOR = '- For trade routes ("export X from Y to Z"), call search_tariff + get_compliance + find_port together.';

const NEW_BLOCK = OLD_ANCHOR + '\n' +
  '- Animal names in trade queries ALWAYS mean products derived from them — sheep = sheep leather/wool/skin, cow/bovine = leather/beef/hide, fish = seafood/fish meal, silkworm = silk, crocodile/alligator = exotic leather, goat = goat leather/mohair. NEVER ask "what kind of animal?" — treat it as a product query and call search_products directly.';

console.log('=== Fix: animal names → product queries ===\n');
console.log('Adding rule to ## RULES section in Build Context system prompt.\n');
console.log('New rule:\n"' + NEW_BLOCK.split('\n').pop() + '"\n');

if (!WRITE) { console.log('(dry run — pass --write to deploy)'); process.exit(0); }

(async () => {
  const wf = await getWf(WF_ID);
  const bc = wf.nodes.find(n => n.name === 'Build Context');
  if (!bc) { console.log('❌ Build Context not found'); process.exit(1); }

  const code = bc.parameters.jsCode;
  if (!code.includes(OLD_ANCHOR)) { console.log('❌ Anchor not found'); process.exit(1); }
  if (code.includes('Animal names in trade')) { console.log('Rule already present.'); process.exit(0); }

  fs.writeFileSync(path.join(BACKUP_DIR, WF_ID + '_before_animal_rule.json'), JSON.stringify(wf, null, 2), 'utf8');
  console.log('Backup saved.');

  bc.parameters.jsCode = code.replace(OLD_ANCHOR, NEW_BLOCK);

  const settings = Object.assign({}, wf.settings); delete settings.binaryMode;
  const r = await putWf(WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) { console.log('❌ PUT failed:', r.body.slice(0, 300)); process.exit(1); }
  await activate(WF_ID);

  const check = await getWf(WF_ID);
  const bc2 = check.nodes.find(n => n.name === 'Build Context');
  const ok = bc2.parameters.jsCode.includes('Animal names in trade');
  console.log((ok ? '✅' : '❌') + ' Animal-product rule deployed');
  if (ok) console.log('\nTest: "sheep" should now directly call search_products, no clarification question');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
