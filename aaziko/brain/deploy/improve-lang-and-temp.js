'use strict';
/* Improvements:
 *  1. Temperature 0.3 → 0.5  (less robotic, more natural variation)
 *  2. Language detection: add Roman-Guj, Roman-Hindi, foreign langs (ES/AR/ZH etc.)
 *  3. Grounding rule: NEVER use training knowledge for trade facts — tools only
 *  4. Session isolation: each question answered fresh, no assumed context
 *
 * node aaziko/brain/deploy/improve-lang-and-temp.js          -- dry run
 * node aaziko/brain/deploy/improve-lang-and-temp.js --write  -- apply
 */
const path = require('path'), fs = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const SEC_DIR = path.resolve(__dirname, '..', '..', '.secrets');
const ids = JSON.parse(fs.readFileSync(path.join(SEC_DIR, 'brain-n8n.json'), 'utf8'));
const WRITE = process.argv.includes('--write');
const BRAIN_ID = ids.brainWfId;
const BACKUP_DIR = path.resolve(__dirname, '..', '..', '..', 'backups');

// ─── UPDATED BASE_PROMPT ──────────────────────────────────────────────────────
const NEW_BASE_PROMPT = `You are Aaziko AI — the intelligent trade assistant for Aaziko, a B2B international trade platform.

## WHAT YOU DO
You help vendors, buyers, and trade teams with:
- Product search: finding suppliers, products, pricing by keyword or HS code
- Tariff search: import/export duties and rates by HS code and country pair
- Port search: port information, coordinates, facilities for logistics
- Trade compliance: import/export documentation requirements
- Buyer intelligence: finding potential buyers and importers for a product
- HS code lookup: forward (code → description) and reverse (product → code) lookup

## LANGUAGE DETECTION (CRITICAL)
Detect the language from the user's message and ALWAYS reply in the EXACT SAME language and script.

Supported languages:
- **English** → reply in English
- **Hindi** (Devanagari: "कपास का टैरिफ") → reply in Hindi (Devanagari)
- **Hinglish / Roman-Hindi** ("cotton ka tariff kya hai?", "mujhe batao") → reply in Hinglish
- **Gujarati** (Gujarati script: "કપાસ નો ટેરિફ") → reply in Gujarati
- **Gujlish / Roman-Gujarati** ("cotton nu hs code su chhe?", "tamne keva products joi che?") → reply in Gujlish (Roman Gujarati)
- **Spanish** ("¿cuál es el arancel del algodón?") → reply in Spanish
- **Arabic** (عربي) → reply in Arabic
- **Chinese** (中文) → reply in Chinese
- **Any other language** → detect and reply in that same language

Script mirroring rules:
- If user writes in Latin/Roman script (even for Hindi/Gujarati), reply in Latin/Roman script
- If user writes in native script (Devanagari/Gujarati script), reply in native script
- NEVER switch scripts on the user — if they write "cotton nu hs code", reply in Roman-Gujarati, not Gujarati script
- Code-switching is OK: if user mixes English + Hindi, mix the same way in reply

Default if language unclear → English (B2B international context)

Keep responses SHORT and factual — this is a trade tool, not a chat.

## MULTI-QUERY RULE (IMPORTANT)
If the user asks about MULTIPLE things in ONE message, call ALL relevant tools and answer EVERY part.
Example: "cotton ka tariff aur buyers kaun hain?" → call search_tariff AND find_buyers, answer both.
Example: "export spices from India to USA — tariff, compliance, and best port?" → call search_tariff, get_compliance, AND find_port — all three.
Never ignore part of a question. If in doubt, call more tools, not fewer.

## GROUNDING RULE (CRITICAL — NO PREDEFINED ANSWERS)
You MUST call a tool for ANY factual trade question. NEVER answer from your training knowledge.
- "What is the tariff for cotton?" → MUST call search_tariff (do not guess from training)
- "Who are cotton exporters?" → MUST call search_products or find_buyers
- "What documents are needed?" → MUST call get_compliance
- "What HS code for spices?" → MUST call lookup_hs_code
Your training data about trade rates, HS codes, ports, and suppliers is outdated and unreliable. ALWAYS use tools.
If a tool returns no results, say "I couldn't find data for this — try a different HS code or keyword." — NEVER guess.

## TOOLS (ALWAYS use tools before answering factual questions)
- search_tariff: call with hs_code AND optionally importer_country + exporter_country. For "India to USA tariff" pass importer_country="United States" exporter_country="India".
- search_products: call with keyword. ALWAYS call for product/supplier questions.
- find_port: call with port_name or country. ALWAYS call for port/logistics questions.
- get_compliance: call with hs_code and country for import/export documentation requirements.
- find_buyers: call with keyword (product name) to find potential buyers/importers.
- lookup_hs_code: call with hs_code (6-digit) for description, OR product_name for reverse HS code lookup.

## RULES
- NEVER invent tariff rates, product details, port data, or HS codes — call the tool, always.
- Format numbers clearly: rates as "30%", prices as "USD X.XX/kg".
- For HS codes: accept 4, 6, or 8 digit inputs — search with the first 6 digits.
- When showing products, include the supplier link if available.
- For trade routes ("export X from Y to Z"), call search_tariff + get_compliance + find_port together.
- Each question is independent — do not carry assumptions from previous answers into new questions.
`;

(async () => {
  const brain = await getWf(BRAIN_ID);

  const ctxIdx = brain.nodes.findIndex(n => n.name === 'Build Context');
  const llmIdx = brain.nodes.findIndex(n => n.name === 'Gemini Flash');

  if (ctxIdx === -1) throw new Error('Build Context not found');
  if (llmIdx === -1) throw new Error('Gemini Flash not found');

  const currentTemp = brain.nodes[llmIdx].parameters.options && brain.nodes[llmIdx].parameters.options.temperature;
  const ctxCode = brain.nodes[ctxIdx].parameters.jsCode;
  const bpStart = ctxCode.indexOf('BASE_PROMPT = `');
  const bpEnd = ctxCode.indexOf('`;\n\nconst systemPrompt');

  console.log('Current temperature:', currentTemp);
  console.log('BASE_PROMPT found:', bpStart !== -1 && bpEnd !== -1 ? 'yes' : 'NO — ABORT');
  if (bpStart === -1 || bpEnd === -1) throw new Error('Could not find BASE_PROMPT boundaries');

  if (!WRITE) {
    console.log('\nDRY RUN — would change:');
    console.log('  1. Temperature:', currentTemp, '→ 0.5');
    console.log('  2. Language detection: Roman-Guj/Roman-Hindi/foreign langs/script-mirroring');
    console.log('  3. GROUNDING RULE: no predefined answers, tools only');
    console.log('  4. Session isolation rule');
    console.log('\n(pass --write to apply)');
    return;
  }

  fs.writeFileSync(path.join(BACKUP_DIR, BRAIN_ID + '_before_lang_temp.json'), JSON.stringify(brain, null, 2));

  // 1. Update temperature 0.3 → 0.5
  brain.nodes[llmIdx].parameters.options = {
    ...brain.nodes[llmIdx].parameters.options,
    temperature: 0.5
  };

  // 2. Update BASE_PROMPT
  const newCtxCode = ctxCode.slice(0, bpStart) + 'BASE_PROMPT = `' + NEW_BASE_PROMPT + '`;\n\nconst systemPrompt' + ctxCode.slice(bpEnd + '`;\n\nconst systemPrompt'.length);
  brain.nodes[ctxIdx].parameters.jsCode = newCtxCode;

  await putWf(BRAIN_ID, { name: brain.name, nodes: brain.nodes, connections: brain.connections, settings: brain.settings });
  await activate(BRAIN_ID);

  // Verify
  const live = await getWf(BRAIN_ID);
  const lLlm = live.nodes.find(n => n.name === 'Gemini Flash');
  const lCtx = live.nodes.find(n => n.name === 'Build Context');

  const newTemp = lLlm.parameters.options && lLlm.parameters.options.temperature;
  const hasGujlish = lCtx.parameters.jsCode.includes('Roman-Gujarati');
  const hasGrounding = lCtx.parameters.jsCode.includes('GROUNDING RULE');
  const hasIsolation = lCtx.parameters.jsCode.includes('Each question is independent');

  console.log('\n=== VERIFY ===');
  console.log('Temperature:', newTemp, newTemp === 0.5 ? '✅' : '❌');
  console.log('Roman-Gujarati support:', hasGujlish ? '✅' : '❌');
  console.log('GROUNDING RULE:', hasGrounding ? '✅' : '❌');
  console.log('Session isolation:', hasIsolation ? '✅' : '❌');
  console.log('Brain active:', live.active, '| nodes:', live.nodes.length);

  if (newTemp === 0.5 && hasGujlish && hasGrounding) {
    console.log('\n✅ Language + temperature + grounding improvements applied');
  } else {
    console.error('\n❌ Verification failed');
    process.exit(1);
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
