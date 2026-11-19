'use strict';
/*
 * Fix session memory: Load History returned 0 items → Build Context never ran.
 *
 * Root cause: mongoDb aggregate without $facet returns 0 items for empty collection.
 * n8n then skips all downstream nodes.
 *
 * Fix: Use $facet in Prep History pipeline — $facet ALWAYS returns exactly 1 doc
 * with {rows: [...]} regardless of match count. Same pattern as other Aaziko tools.
 * Also update Build Context to read from histData.rows instead of all().
 *
 * node aaziko/brain/deploy/fix-session-memory-facet.js          -- dry run
 * node aaziko/brain/deploy/fix-session-memory-facet.js --write  -- apply
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const WRITE      = process.argv.includes('--write');
const BRAIN_ID   = 'w7no6uCJkz7lfaah';
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');

// ── Fixed Prep History: use $facet so aggregate always returns 1 doc ─────────
const FIXED_PREP_HISTORY = `const g = ($('Auth Gate').first() || { json: {} }).json;
const sessionKey = g.sessionKey || 'az-anon';
// $facet always returns exactly 1 doc even when match = 0
// This prevents n8n from stopping the flow on empty history
const pipeline = JSON.stringify([
  {"$match": {"sessionKey": sessionKey}},
  {"$sort": {"ts": 1}},
  {"$limit": 12},
  {"$facet": {"rows": [{"$project": {"_id": 0, "role": 1, "content": 1, "ts": 1}}]}}
]);
return [{ json: { sessionKey, pipeline } }];`;

// ── Fixed Build Context: reads from histData.rows (from $facet) ──────────────
const FIXED_BUILD_CONTEXT = `const g = ($('Auth Gate').first() || { json: {} }).json;
const cfg = ($('Load Config').first() || { json: {} }).json;

// Load conversation history — $facet returns {rows:[...]} always (even empty)
var histItems = [];
try {
  var histData = $('Load History').first().json;
  histItems = histData.rows || [];
} catch(e) { histItems = []; }

var histBlock = '';
if (histItems.length > 0) {
  var lines = histItems.map(function(h) {
    var role = h.role === 'human' ? 'User' : 'Assistant';
    return role + ': ' + String(h.content || '').slice(0, 500);
  });
  histBlock = '\\n\\n## CONVERSATION HISTORY (recent turns — use for explicit follow-ups)\\n' + lines.join('\\n') + '\\n---\\n';
}

const BASE_PROMPT = \`You are Aaziko AI — the intelligent trade assistant for Aaziko, a B2B international trade platform.

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

## MEMORY RULE
- Use conversation history for explicit follow-ups: "pehle wale buyers", "jo tariff mila tha", "us HS code ki compliance".
- For fresh questions (new product, new country, new topic), ALWAYS call the tool — do not reuse previous results.
- If the user asks "kaun sabse zyada tha" or "average kya tha", refer to the CONVERSATION HISTORY above.

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
\`;

const systemPrompt = BASE_PROMPT + histBlock + (cfg.extraPrompt ? '\\n\\n' + cfg.extraPrompt : '');

return [{ json: {
  chatInput: g.chatInput,
  sessionKey: g.sessionKey,
  systemPrompt: systemPrompt,
  channel: g.channel,
  sessionId: g.sessionId,
  ts: g.ts
} }];`;

(async () => {
  console.log('=== Fix: Session Memory $facet ===');
  console.log('Problem: Load History (0 items) → Build Context NEVER RAN');
  console.log('Fix: $facet in pipeline so Load History always returns 1 doc with rows:[]\n');

  const wf = await getWf(BRAIN_ID);
  const prepHistory = wf.nodes.find(n => n.name === 'Prep History');
  const buildCtx    = wf.nodes.find(n => n.name === 'Build Context');

  if (!prepHistory) { console.log('❌ Prep History not found — run implement-session-memory first'); process.exit(1); }
  if (!buildCtx)    { console.log('❌ Build Context not found'); process.exit(1); }

  const hasOldPipeline = prepHistory.parameters.jsCode.includes('"$sort":{"ts":1}},{"$limit"');
  const hasOldBcRead   = buildCtx.parameters.jsCode.includes(".all()");
  console.log('Prep History has non-facet pipeline:', hasOldPipeline ? 'YES (needs fix)' : 'already fixed');
  console.log('Build Context reads all():', buildCtx.parameters.jsCode.includes('.all()') ? 'YES (needs fix)' : 'already fixed');

  if (!WRITE) {
    console.log('\n(dry run — pass --write to apply)');
    return;
  }

  const bk = path.join(BACKUP_DIR, BRAIN_ID + '_before_session-memory-facet.json');
  fs.writeFileSync(bk, JSON.stringify(wf, null, 2), 'utf8');
  console.log('\nBackup:', bk);

  prepHistory.parameters.jsCode = FIXED_PREP_HISTORY;
  buildCtx.parameters.jsCode = FIXED_BUILD_CONTEXT;

  const settings = Object.assign({}, wf.settings);
  delete settings.binaryMode;

  const r = await putWf(BRAIN_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) {
    console.log('❌ PUT failed (' + r.status + '):', JSON.stringify(r.body).slice(0, 200));
    process.exit(1);
  }
  await activate(BRAIN_ID);

  const check = await getWf(BRAIN_ID);
  const ph = check.nodes.find(n => n.name === 'Prep History');
  const bc = check.nodes.find(n => n.name === 'Build Context');

  const c1 = ph.parameters.jsCode.includes('$facet');
  const c2 = bc.parameters.jsCode.includes('histData.rows');
  const c3 = !bc.parameters.jsCode.includes('Each question is independent');

  console.log(c1 ? '✅ Prep History uses $facet' : '❌ Prep History verify FAILED');
  console.log(c2 ? '✅ Build Context reads histData.rows' : '❌ Build Context verify FAILED');
  console.log(c3 ? '✅ "independent" rule still removed' : '❌ "independent" rule came back!');

  if (c1 && c2 && c3) {
    console.log('\n✅ Fix applied — empty history now returns {rows:[]} and Build Context always runs');
  } else {
    process.exit(1);
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
