'use strict';
/*
 * Brain improvements:
 * 1. Explicit Roman-script guard (Hinglish input → never reply in Devanagari)
 * 2. Incentive query fallback (don't show tariff rates as substitute for RoDTEP)
 * 3. DIRECT_HS: 10 new products (dhania, ghee, mango, shrimp, sesame, groundnut,
 *    charger, steel rod, black pepper, aluminium sheet)
 *
 * node aaziko/brain/deploy/fix-brain-improvements.js          -- verify
 * node aaziko/brain/deploy/fix-brain-improvements.js --write  -- deploy
 */
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate, RROOT } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(RROOT, 'backups');
const BRAIN_ID  = 'w7no6uCJkz7lfaah';
const HS_WF_ID  = 'OqZH3AoC6yy8UIbz';
const WRITE = process.argv.includes('--write');

// ── Fix 1 & 2: Brain prompt patches ──────────────────────────────────────────

// Fix 1: Strengthen Roman-script guard after existing script mirroring rules
const LANG_ANCHOR = `- NEVER switch scripts on the user — if they write "cotton nu hs code", reply in Roman-Gujarati, not Gujarati script\n- Code-switching is OK: if user mixes English + Hindi, mix the same way in reply`;
const LANG_NEW    = `- NEVER switch scripts on the user — if they write "cotton nu hs code", reply in Roman-Gujarati, not Gujarati script\n- Code-switching is OK: if user mixes English + Hindi, mix the same way in reply\n- **CRITICAL: If user writes in Latin/Roman script (even Hindi words like "kya hota hai", "batao", "chahiye"), ALWAYS reply in Latin/Roman script — NEVER use Devanagari or Gujarati script. When in doubt, default to Roman/Hinglish.**`;

// Fix 2: Incentive fallback rule
const RULES_ANCHOR = `- NEVER invent tariff rates, product details, port data, or HS codes — call the tool, always.`;
const RULES_NEW    = `- NEVER invent tariff rates, product details, port data, or HS codes — call the tool, always.\n- Export incentives (RoDTEP/MEIS/DFIA): ye data Aaziko mein NAHI hai. Jab koi pooche, clearly bolo: "RoDTEP/MEIS rates ke liye DGFT.gov.in dekhein — Aaziko ke paas ye data abhi nahi hai." search_tariff ya get_compliance ka result KABHI incentive ki jagah mat dikhao — wo alag cheez hai.`;

// ── Fix 3: DIRECT_HS new entries ─────────────────────────────────────────────
const HS_OLD = `'copper':'740311','tamba':'740311','aluminium':'760110','zinc':'790111','lead':'780110'\n};`;
const HS_NEW = `'copper':'740311','tamba':'740311','aluminium':'760110','zinc':'790111','lead':'780110',
  'black pepper':'090411','kali mirch':'090411','kali mirchi':'090411',
  'coriander':'090920','coriander seeds':'090920','dhania':'090920','dhaniya':'090920',
  'ghee':'040510','clarified butter':'040510',
  'sesame seeds':'120740','sesame':'120740','til':'120740',
  'groundnut':'120242','peanut':'120242','peanuts':'120242','mungfali':'120242',
  'mango':'080450','aam':'080450','mangoes':'080450',
  'shrimp':'030613','prawn':'030613','prawns':'030613','jhinga':'030613',
  'charger':'850440','phone charger':'850440','adapter':'850440','adaptor':'850440',
  'steel rod':'721410','steel bar':'721410','iron rod':'721410',
  'aluminium sheet':'760612','aluminum sheet':'760612','aluminium patta':'760612'
};`;

async function patchBrain() {
  const wf = await getWf(BRAIN_ID);
  fs.writeFileSync(path.join(BACKUP_DIR, BRAIN_ID + '_before_improvements.json'), JSON.stringify(wf, null, 2), 'utf8');
  const bc = wf.nodes.find(n => n.name === 'Build Context');
  if (!bc) throw new Error('Build Context not found');

  let changed = 0;

  // Fix 1: Roman script guard
  if (bc.parameters.jsCode.includes('CRITICAL: If user writes in Latin')) {
    console.log('Fix1: already patched');
  } else if (bc.parameters.jsCode.includes(LANG_ANCHOR)) {
    bc.parameters.jsCode = bc.parameters.jsCode.replace(LANG_ANCHOR, LANG_NEW);
    console.log('Fix1 OK: Roman script guard added');
    changed++;
  } else {
    console.log('Fix1 ERR: lang anchor not found'); return false;
  }

  // Fix 2: Incentive fallback
  if (bc.parameters.jsCode.includes('RoDTEP/MEIS rates ke liye DGFT')) {
    console.log('Fix2: already patched');
  } else if (bc.parameters.jsCode.includes(RULES_ANCHOR)) {
    bc.parameters.jsCode = bc.parameters.jsCode.replace(RULES_ANCHOR, RULES_NEW);
    console.log('Fix2 OK: incentive fallback rule added');
    changed++;
  } else {
    console.log('Fix2 ERR: rules anchor not found'); return false;
  }

  const ok1 = bc.parameters.jsCode.includes('CRITICAL: If user writes in Latin');
  const ok2 = bc.parameters.jsCode.includes('RoDTEP/MEIS rates ke liye DGFT');
  console.log((ok1 ? '✅' : '❌') + ' Roman script guard');
  console.log((ok2 ? '✅' : '❌') + ' Incentive fallback rule');
  if (!ok1 || !ok2) return false;

  return { wf, changed };
}

async function patchHsWf() {
  const wf = await getWf(HS_WF_ID);
  fs.writeFileSync(path.join(BACKUP_DIR, HS_WF_ID + '_before_new-products.json'), JSON.stringify(wf, null, 2), 'utf8');
  const prep = wf.nodes.find(n => n.name === 'HS Prep');
  if (!prep) throw new Error('HS Prep not found');

  if (prep.parameters.jsCode.includes("'dhania':'090920'")) {
    console.log('Fix3: already patched');
  } else if (prep.parameters.jsCode.includes(HS_OLD)) {
    prep.parameters.jsCode = prep.parameters.jsCode.replace(HS_OLD, HS_NEW);
    console.log('Fix3 OK: 10 new DIRECT_HS entries added');
  } else {
    console.log('Fix3 ERR: HS anchor not found'); return false;
  }

  const ok3 = prep.parameters.jsCode.includes("'dhania':'090920'");
  console.log((ok3 ? '✅' : '❌') + ' New DIRECT_HS entries (dhania, ghee, mango, etc.)');
  return ok3 ? { wf } : false;
}

(async () => {
  console.log('=== Brain workflow ===');
  const brainResult = await patchBrain();
  if (!brainResult) process.exit(1);

  console.log('\n=== lookup_hs_code workflow ===');
  const hsResult = await patchHsWf();
  if (!hsResult) process.exit(1);

  if (!WRITE) { console.log('\n✅ Verify OK — run --write to deploy'); process.exit(0); }

  // Deploy brain
  const bs = Object.assign({}, brainResult.wf.settings); delete bs.binaryMode;
  const br = await putWf(BRAIN_ID, { name: brainResult.wf.name, nodes: brainResult.wf.nodes, connections: brainResult.wf.connections, settings: bs });
  if (br.status !== 200) { console.log('Brain PUT failed:', br.status, br.body.slice(0,300)); process.exit(1); }
  await activate(BRAIN_ID);
  console.log('✅ Brain deployed');

  // Deploy hs_wf
  const hs = Object.assign({}, hsResult.wf.settings); delete hs.binaryMode;
  const hr = await putWf(HS_WF_ID, { name: hsResult.wf.name, nodes: hsResult.wf.nodes, connections: hsResult.wf.connections, settings: hs });
  if (hr.status !== 200) { console.log('HS wf PUT failed:', hr.status, hr.body.slice(0,300)); process.exit(1); }
  await activate(HS_WF_ID);
  console.log('✅ lookup_hs_code deployed');

  // Read-back
  const bc2 = (await getWf(BRAIN_ID)).nodes.find(n => n.name === 'Build Context');
  const p2  = (await getWf(HS_WF_ID)).nodes.find(n => n.name === 'HS Prep');
  console.log((bc2.parameters.jsCode.includes('CRITICAL: If user writes in Latin') ? '✅' : '❌') + ' Read-back: Roman script guard');
  console.log((bc2.parameters.jsCode.includes('RoDTEP/MEIS rates ke liye DGFT') ? '✅' : '❌') + ' Read-back: incentive rule');
  console.log((p2.parameters.jsCode.includes("'dhania':'090920'") ? '✅' : '❌') + ' Read-back: new DIRECT_HS');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
