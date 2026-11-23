'use strict';
/*
 * Trip Planner v2 — 3 fixes:
 * 1. Market data: show India→destination specifically; if not in top 5, say so
 * 2. Documents: if get_compliance returns empty, list standard export docs
 * 3. Buyers: add note that leads are global, not guaranteed destination-specific
 *
 * node aaziko/brain/deploy/fix-trip-planner-v2.js          -- verify
 * node aaziko/brain/deploy/fix-trip-planner-v2.js --write  -- deploy
 */
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate, RROOT } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(RROOT, 'backups');
const WF_ID = 'w7no6uCJkz7lfaah';
const WRITE = process.argv.includes('--write');

// ── The full OLD trip planner block (extracted from live prompt) ──────────────
const OLD_BLOCK = `## TRADE TRIP PLANNER — AKINATOR STYLE
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

// ── The NEW fixed version ─────────────────────────────────────────────────────
const NEW_BLOCK = `## TRADE TRIP PLANNER — AKINATOR STYLE
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
  5. get_top_markets(hs_code=[from step 1]) → global export markets for context

OUTPUT FORMAT — after research, give this exact structure:

🌍 Trade Trip: [Country] | [Month] | [Days if mentioned]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 YOUR PRODUCT IN [COUNTRY]
[product] → HS [code]
FIX1 — Market data rules:
  - Check if [destination] appears in get_top_markets results.
  - If YES: "India exports $[X]M/yr to [destination] | Growth: [X]% p.a."
  - If NO: "India–[destination] direct trade volume is small. Top global market is [#1 country] ($[X]M). [Destination] = emerging opportunity."
  - NEVER show another country's export number as if it's the destination's number.
[Manufacturer/Trader] advantage: [1 line tip based on their role]

👥 BUYER LEADS ([N] found)
1. [Company Name] | [Product] | Score: [X] | Est. deal: $[X]
2. [Company Name] | [Product] | Score: [X] | Est. deal: $[X]
3. [Company Name] | [Product] | Score: [X] | Est. deal: $[X]
(show top 5 max)
FIX3 — Always add this line after buyer list: "Note: ye global buyer leads hain — in companies ko verify karo ki wo [destination] mein import karte hain ya wahan ke contacts de sakte hain."

📋 DOCUMENTS CHECKLIST
FIX2 — Documents rules:
  - If get_compliance returns active trade remedies / anti-dumping duties → list them first.
  - ALWAYS list these standard export documents (every shipment needs them):
    • Commercial Invoice (exporter se buyer ko)
    • Packing List
    • Bill of Lading / Airway Bill
    • Certificate of Origin (Form A — GSP ke liye)
    • Shipping Bill (Indian customs)
    • Export Declaration / ARE-1
  - If get_compliance returned specific restrictions for this product+country, list those too.

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
  fs.writeFileSync(path.join(BACKUP_DIR, WF_ID + '_before_trip-v2.json'), JSON.stringify(wf, null, 2), 'utf8');
  console.log('Backup saved. Nodes:', wf.nodes.length);

  const bc = wf.nodes.find(n => n.name === 'Build Context');
  if (!bc) { console.log('ERR: Build Context not found'); process.exit(1); }

  if (bc.parameters.jsCode.includes('FIX1 — Market data rules')) {
    console.log('OK: Already patched v2');
  } else if (bc.parameters.jsCode.includes(OLD_BLOCK)) {
    bc.parameters.jsCode = bc.parameters.jsCode.replace(OLD_BLOCK, NEW_BLOCK);
    console.log('OK: Trip Planner v2 applied (3 fixes)');
  } else {
    console.log('ERR: OLD_BLOCK not found — checking partial match...');
    const hasTrip = bc.parameters.jsCode.includes('TRADE TRIP PLANNER');
    console.log('Has trip planner:', hasTrip);
    if (hasTrip) {
      // Try to find what's different
      const idx = bc.parameters.jsCode.indexOf('TRADE TRIP PLANNER');
      console.log('First 200 chars of trip section:', JSON.stringify(bc.parameters.jsCode.slice(idx, idx+200)));
    }
    process.exit(1);
  }

  const ok1 = bc.parameters.jsCode.includes('FIX1 — Market data rules');
  const ok2 = bc.parameters.jsCode.includes('FIX2 — Documents rules');
  const ok3 = bc.parameters.jsCode.includes('FIX3 — Always add');
  console.log((ok1?'✅':'❌')+' FIX1: market data destination-specific');
  console.log((ok2?'✅':'❌')+' FIX2: standard export docs always listed');
  console.log((ok3?'✅':'❌')+' FIX3: global buyer leads disclaimer');
  if (!ok1||!ok2||!ok3) process.exit(1);

  if (!WRITE) { console.log('\n✅ Verify OK — run --write to deploy'); process.exit(0); }

  const settings = Object.assign({}, wf.settings); delete settings.binaryMode;
  const r = await putWf(WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) { console.log('PUT failed:', r.status, r.body.slice(0,300)); process.exit(1); }
  console.log('✅ PUT 200');
  await activate(WF_ID);
  console.log('✅ Activated');

  const check = await getWf(WF_ID);
  const bcC = check.nodes.find(n => n.name === 'Build Context');
  console.log((bcC.parameters.jsCode.includes('FIX1 — Market data rules')?'✅':'❌')+' Read-back: trip planner v2 live');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
