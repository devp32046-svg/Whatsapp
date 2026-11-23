'use strict';
/*
 * Add Trade Trip Planner (Akinator-style intake) to brain prompt.
 * 4-question intake → full research chain → structured trip pack output.
 *
 * Questions:
 *   Q1: Kya export karte ho?
 *   Q2: Manufacturer ya trader?
 *   Q3: Pehli baar ya contacts hain?
 *   Q4: Expected order size?
 * → Then: lookup_hs_code → get_trade_agreements → find_buyers → get_compliance → get_top_markets
 *
 * node aaziko/brain/deploy/add-trip-planner.js          -- verify
 * node aaziko/brain/deploy/add-trip-planner.js --write  -- deploy
 */
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate, RROOT } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(RROOT, 'backups');
const WF_ID = 'w7no6uCJkz7lfaah';
const WRITE = process.argv.includes('--write');

const ANCHOR = '## RULES\n- NEVER invent tariff rates';

const TRIP_BLOCK = `## TRADE TRIP PLANNER — AKINATOR STYLE
Trigger: User mentions visiting / going to / trip to any country with a timeframe (month, days, week, next month, etc.)

INTAKE — 4 questions, ONE per turn, in sequence. NEVER ask all at once:
  Q1: "Trip plan banate hain! Aap kya export karte ho? (ek ya do products batao)"
  Q2: "Aap manufacturer ho ya trader?"
  Q3: "[Destination] mein pehli baar ja rahe ho, ya pehle bhi contacts hain wahan?"
  Q4: "Approximate expected order size kya hai? (e.g. $5K–$20K / $20K–$100K / $100K+)"

  Tracking rule: Check this conversation's history.
  - If Q1 not yet asked → ask Q1 now.
  - If Q1 answered but Q2 not asked → ask Q2.
  - If Q1+Q2 answered but Q3 not asked → ask Q3.
  - If Q1+Q2+Q3 answered but Q4 not asked → ask Q4.
  - If ALL 4 answered → proceed to RESEARCH immediately.
  Skip any question the user already answered upfront (e.g. they mentioned product in first message → skip Q1).

RESEARCH — call these tools after all 4 answers collected:
  1. lookup_hs_code(product_name=[user_product]) → get HS code
  2. get_trade_agreements(country1="India", country2=[destination]) → FTA/DTAA status
  3. find_buyers(product_name=[user_product], country=[destination]) → buyer leads
  4. get_compliance(hs_code=[from step 1], destination=[destination]) → document requirements
  5. get_top_markets(hs_code=[from step 1]) → confirm India's export potential to that market

OUTPUT FORMAT — after research, give this exact structure:

🌍 Trade Trip: [Country] | [Month] | [Days if mentioned]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 YOUR PRODUCT IN [COUNTRY]
[product] → HS [code]
India exports $[X]M/yr to [country] | Growth: [X]% p.a.
[Manufacturer/Trader] advantage: [1 line, e.g. "Direct factory pricing gives you 15–20% edge over traders"]

👥 BUYER LEADS ([N] found)
1. [Company Name] | [Product] | Score: [X] | Est. deal: $[X]
2. [Company Name] | [Product] | Score: [X] | Est. deal: $[X]
3. [Company Name] | [Product] | Score: [X] | Est. deal: $[X]
(show top 5 max)

📋 DOCUMENTS CHECKLIST
• [doc1]
• [doc2]
• [doc3]
(list all from get_compliance result)

🤝 TRADE AGREEMENT
India–[Country]: [FTA name / DTAA / No agreement]
Duty impact: [1 line — e.g. "No FTA — MFN rate applies, check tariff before quoting"]

💡 TRIP TIPS
• [Tip relevant to manufacturer or trader role]
• [Tip for first visit or returning visitor]
• [1 cultural/business etiquette tip if known]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

`;

(async () => {
  const wf = await getWf(WF_ID);
  fs.writeFileSync(path.join(BACKUP_DIR, WF_ID + '_before_trip-planner.json'), JSON.stringify(wf, null, 2), 'utf8');
  console.log('Backup saved. Nodes:', wf.nodes.length);

  const bc = wf.nodes.find(n => n.name === 'Build Context');
  if (!bc) { console.log('ERR: Build Context not found'); process.exit(1); }

  if (bc.parameters.jsCode.includes('TRADE TRIP PLANNER')) {
    console.log('OK: Already patched');
  } else if (bc.parameters.jsCode.includes(ANCHOR)) {
    bc.parameters.jsCode = bc.parameters.jsCode.replace(ANCHOR, TRIP_BLOCK + ANCHOR);
    console.log('OK: Trip Planner section added');
  } else {
    console.log('ERR: RULES anchor not found'); process.exit(1);
  }

  const ok = bc.parameters.jsCode.includes('TRADE TRIP PLANNER');
  console.log((ok ? '✅' : '❌') + ' Trip Planner in brain prompt');
  if (!ok) process.exit(1);

  // Sanity: all 4 questions present
  const q1 = bc.parameters.jsCode.includes('export karte ho');
  const q2 = bc.parameters.jsCode.includes('manufacturer ho ya trader');
  const q3 = bc.parameters.jsCode.includes('pehli baar');
  const q4 = bc.parameters.jsCode.includes('order size');
  console.log((q1?'✅':'❌')+' Q1 (product)');
  console.log((q2?'✅':'❌')+' Q2 (mfr/trader)');
  console.log((q3?'✅':'❌')+' Q3 (first visit)');
  console.log((q4?'✅':'❌')+' Q4 (order size)');
  if (!q1||!q2||!q3||!q4) process.exit(1);

  if (!WRITE) { console.log('\n✅ Verify OK — run --write to deploy'); process.exit(0); }

  const settings = Object.assign({}, wf.settings); delete settings.binaryMode;
  const r = await putWf(WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) { console.log('PUT failed:', r.status, r.body.slice(0, 300)); process.exit(1); }
  console.log('✅ PUT 200');
  await activate(WF_ID);
  console.log('✅ Activated');

  const check = await getWf(WF_ID);
  const bcC = check.nodes.find(n => n.name === 'Build Context');
  console.log((bcC.parameters.jsCode.includes('TRADE TRIP PLANNER') ? '✅' : '❌') + ' Read-back: Trip Planner live');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
