'use strict';
/*
 * Implement MongoDB-backed session memory for Aaziko AI Brain.
 *
 * Problem: Brain forgets tool results between turns.
 * Root cause 1: BASE_PROMPT says "Each question is independent" — kills memory use.
 * Root cause 2: memoryBufferWindow is RAM-only (lost on n8n restart).
 *
 * Fix:
 * 1. Add Prep History + Load History nodes (Load last 12 turns from az_chat_memory)
 * 2. Update Build Context — inject history into prompt + remove "Each question is independent"
 * 3. Add Prep Save + Save Turn nodes (save human + AI turn after each reply)
 * 4. Increase memoryBufferWindow contextWindowLength: 6 → 10
 *
 * Flow change:
 *   BEFORE: Load Config → Build Context → AI Brain → Parse Reply → Respond UI
 *   AFTER:  Load Config → Prep History → Load History → Build Context → AI Brain
 *                                                                       → Parse Reply → Respond UI
 *                                                                                    → Prep Save → Save Turn
 *
 * Collection: az_chat_memory in aaziko_organized DB
 * Credential: 9hyaSxc0saIzUgsX (Aaziko Brain - organized)
 *
 * node aaziko/brain/deploy/implement-session-memory.js          -- dry run
 * node aaziko/brain/deploy/implement-session-memory.js --write  -- apply
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const WRITE      = process.argv.includes('--write');
const BRAIN_ID   = 'w7no6uCJkz7lfaah';
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');

// Credential for az_chat_memory (aaziko_organized DB)
const MEM_CRED = { id: '9hyaSxc0saIzUgsX', name: 'Aaziko Brain - organized (compliance)' };

// ── Prep History Code node ───────────────────────────────────────────────────
const PREP_HISTORY_CODE = `const g = ($('Auth Gate').first() || { json: {} }).json;
const sessionKey = g.sessionKey || 'az-anon';
// Build aggregate pipeline: get last 12 turns, chronological order
const pipeline = JSON.stringify([
  {"$match": {"sessionKey": sessionKey}},
  {"$sort": {"ts": 1}},
  {"$limit": 12}
]);
return [{ json: { sessionKey, pipeline } }];`;

// ── Updated Build Context code ────────────────────────────────────────────────
// Changes: (1) reads history from Load History node, (2) removes "independent" rule,
// (3) injects conversation context block when history exists
const NEW_BUILD_CONTEXT_CODE = `const g = ($('Auth Gate').first() || { json: {} }).json;
const cfg = ($('Load Config').first() || { json: {} }).json;

// Load conversation history from MongoDB
var histItems = [];
try { histItems = $('Load History').all().map(function(it) { return it.json; }); } catch(e) {}

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

// ── Prep Save Code node (after Parse Reply) ────────────────────────────────────
const PREP_SAVE_CODE = `const g = ($('Auth Gate').first() || { json: {} }).json;
const reply = ($('Parse Reply').first() || { json: {} }).json;
const now = Date.now();
const sessionKey = g.sessionKey || 'az-anon';
// Output 2 items: human turn first, then AI reply
// mongoDb Save Turn will insert each item separately
return [
  { json: {
    sessionKey: sessionKey,
    role: 'human',
    content: String(g.chatInput || '').slice(0, 2000),
    ts: new Date(now).toISOString()
  }},
  { json: {
    sessionKey: sessionKey,
    role: 'ai',
    content: String(reply.replyText || '').slice(0, 2000),
    ts: new Date(now + 1).toISOString()
  }}
];`;

// ── UUID helper ───────────────────────────────────────────────────────────────
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

(async () => {
  console.log('=== Aaziko Session Memory Implementation ===');
  console.log('Changes:');
  console.log('  1. Add Prep History + Load History nodes (az_chat_memory read)');
  console.log('  2. Update Build Context — inject history, remove "independent" rule');
  console.log('  3. Add Prep Save + Save Turn nodes (az_chat_memory write after reply)');
  console.log('  4. Chat Memory contextWindowLength: 6 → 10\n');

  const wf = await getWf(BRAIN_ID);
  console.log(`Brain: ${wf.name} (${BRAIN_ID})`);
  console.log(`Nodes before: ${wf.nodes.length}`);

  // ── Verify existing nodes ─────────────────────────────────────────────────
  const loadConfig  = wf.nodes.find(n => n.name === 'Load Config');
  const buildCtx    = wf.nodes.find(n => n.name === 'Build Context');
  const parseReply  = wf.nodes.find(n => n.name === 'Parse Reply');
  const respondUI   = wf.nodes.find(n => n.name === 'Respond UI');
  const chatMemory  = wf.nodes.find(n => n.name === 'Chat Memory');

  if (!loadConfig || !buildCtx || !parseReply || !respondUI || !chatMemory) {
    console.error('❌ Required nodes not found! Aborting.');
    process.exit(1);
  }

  // Check if already applied
  if (wf.nodes.find(n => n.name === 'Prep History')) {
    console.log('⚠️  "Prep History" node already exists — may have been applied before.');
    console.log('   Remove existing Prep History / Load History / Prep Save / Save Turn first if re-running.');
    process.exit(0);
  }

  console.log('\nNode positions:');
  console.log('  Load Config:', loadConfig.position);
  console.log('  Build Context:', buildCtx.position);
  console.log('  Parse Reply:', parseReply.position);
  console.log('  Respond UI:', respondUI.position);

  // Current BUILD CONTEXT code — check for the "independent" rule
  const hasIndepRule = buildCtx.parameters.jsCode.includes('Each question is independent');
  console.log('\nBuild Context "Each question is independent" rule:', hasIndepRule ? 'PRESENT (will remove)' : 'not found');

  if (!WRITE) {
    console.log('\n(dry run — pass --write to apply)');
    return;
  }

  // ── Backup ────────────────────────────────────────────────────────────────
  const bk = path.join(BACKUP_DIR, BRAIN_ID + '_before_session-memory.json');
  fs.writeFileSync(bk, JSON.stringify(wf, null, 2), 'utf8');
  console.log('\nBackup:', bk);

  // ── Build new nodes ───────────────────────────────────────────────────────
  // Position: insert between Load Config (1008,384) and Build Context (1232,384)
  // New nodes at x=1232 and x=1456; shift Build Context to x=1680
  const newPrepHistoryId = uuid();
  const newLoadHistoryId = uuid();
  const newPrepSaveId    = uuid();
  const newSaveTurnId    = uuid();

  // 1. Prep History (Code node)
  const prepHistoryNode = {
    id: newPrepHistoryId,
    name: 'Prep History',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1232, 384],
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: PREP_HISTORY_CODE
    }
  };

  // 2. Load History (mongoDb aggregate)
  const loadHistoryNode = {
    id: newLoadHistoryId,
    name: 'Load History',
    type: 'n8n-nodes-base.mongoDb',
    typeVersion: 1,
    position: [1456, 384],
    credentials: { mongoDb: MEM_CRED },
    parameters: {
      operation: 'aggregate',
      collection: 'az_chat_memory',
      query: "={{ $('Prep History').first().json.pipeline }}"
    }
  };

  // 3. Prep Save (Code node — runs after Parse Reply)
  const prepSaveNode = {
    id: newPrepSaveId,
    name: 'Prep Save',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [2560, 560],
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: PREP_SAVE_CODE
    }
  };

  // 4. Save Turn (mongoDb insert — inserts each item from Prep Save)
  const saveTurnNode = {
    id: newSaveTurnId,
    name: 'Save Turn',
    type: 'n8n-nodes-base.mongoDb',
    typeVersion: 1,
    position: [2784, 560],
    credentials: { mongoDb: MEM_CRED },
    parameters: {
      operation: 'insert',
      collection: 'az_chat_memory'
    }
  };

  // ── Update existing nodes ─────────────────────────────────────────────────
  // Build Context: move right + update code
  buildCtx.position = [1680, 384];
  buildCtx.parameters.jsCode = NEW_BUILD_CONTEXT_CODE;

  // Chat Memory: contextWindowLength 6 → 10
  chatMemory.parameters.contextWindowLength = 10;

  // ── Add new nodes ─────────────────────────────────────────────────────────
  wf.nodes.push(prepHistoryNode);
  wf.nodes.push(loadHistoryNode);
  wf.nodes.push(prepSaveNode);
  wf.nodes.push(saveTurnNode);
  console.log(`\nNodes after adding: ${wf.nodes.length} (added 4)`);

  // ── Update connections ────────────────────────────────────────────────────
  const conn = wf.connections;

  // Load Config: was → Build Context, now → Prep History
  conn['Load Config'] = { main: [[{ node: 'Prep History', type: 'main', index: 0 }]] };

  // Prep History → Load History (new)
  conn['Prep History'] = { main: [[{ node: 'Load History', type: 'main', index: 0 }]] };

  // Load History → Build Context (new)
  conn['Load History'] = { main: [[{ node: 'Build Context', type: 'main', index: 0 }]] };

  // Parse Reply: was → Respond UI only, now → Respond UI AND Prep Save (parallel)
  conn['Parse Reply'] = {
    main: [[
      { node: 'Respond UI', type: 'main', index: 0 },
      { node: 'Prep Save', type: 'main', index: 0 }
    ]]
  };

  // Prep Save → Save Turn (new)
  conn['Prep Save'] = { main: [[{ node: 'Save Turn', type: 'main', index: 0 }]] };

  // ── PUT ───────────────────────────────────────────────────────────────────
  const settings = Object.assign({}, wf.settings);
  delete settings.binaryMode;

  console.log('\nPUT workflow...');
  const r = await putWf(BRAIN_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });

  if (r.status !== 200) {
    console.log('❌ PUT failed (' + r.status + '):', JSON.stringify(r.body).slice(0, 300));
    process.exit(1);
  }
  console.log('PUT 200 ✓');

  // ── Deactivate + Activate (REQUIRED for new node wiring) ─────────────────
  console.log('Deactivate + Activate...');
  await activate(BRAIN_ID);
  console.log('Activated ✓');

  // ── Read-back verify ──────────────────────────────────────────────────────
  const check = await getWf(BRAIN_ID);
  const checks = [
    ['Prep History node added',       check.nodes.find(n => n.name === 'Prep History')],
    ['Load History node added',       check.nodes.find(n => n.name === 'Load History')],
    ['Prep Save node added',          check.nodes.find(n => n.name === 'Prep Save')],
    ['Save Turn node added',          check.nodes.find(n => n.name === 'Save Turn')],
    ['Build Context code updated',    check.nodes.find(n => n.name === 'Build Context')?.parameters?.jsCode?.includes('Load History')],
    ['"independent" rule removed',    !check.nodes.find(n => n.name === 'Build Context')?.parameters?.jsCode?.includes('Each question is independent')],
    ['Chat Memory window = 10',       check.nodes.find(n => n.name === 'Chat Memory')?.parameters?.contextWindowLength === 10],
    ['Load Config → Prep History',    check.connections['Load Config']?.main?.[0]?.[0]?.node === 'Prep History'],
    ['Load History → Build Context',  check.connections['Load History']?.main?.[0]?.[0]?.node === 'Build Context'],
    ['Parse Reply → Prep Save wired', check.connections['Parse Reply']?.main?.[0]?.some(e => e.node === 'Prep Save')],
    ['Parse Reply → Respond UI kept', check.connections['Parse Reply']?.main?.[0]?.some(e => e.node === 'Respond UI')],
  ];

  let allPass = true;
  for (const [label, ok] of checks) {
    console.log(ok ? '✅ ' + label : '❌ ' + label);
    if (!ok) allPass = false;
  }

  if (allPass) {
    console.log('\n✅ Session memory LIVE — brain now reads/writes az_chat_memory in aaziko_organized');
    console.log('   Follow-ups like "pehle wale buyers kaun the" will now work across turns.');
    console.log('   First insert will auto-create az_chat_memory collection.');
  } else {
    console.log('\n❌ Some checks FAILED — verify manually and fix before testing.');
    process.exit(1);
  }
})().catch(e => { console.error('FAILED:', e.message, e.stack); process.exit(1); });
