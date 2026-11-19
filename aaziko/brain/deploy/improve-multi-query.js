'use strict';
/* Improvements:
 *  1. System prompt: explicit multi-query guidance + trade-flow framing
 *  2. maxIterations: 6 -> 10
 *  3. Products format: add product_url (IndiaMART link) + contact_details
 *  4. Tariff prep: add partner_name filter ("tariff from India to USA")
 *
 * node aaziko/brain/deploy/improve-multi-query.js          -- dry run
 * node aaziko/brain/deploy/improve-multi-query.js --write  -- apply
 */
const path = require('path'), fs = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const SEC_DIR = path.resolve(__dirname, '..', '..', '.secrets');
const ids = JSON.parse(fs.readFileSync(path.join(SEC_DIR, 'brain-n8n.json'), 'utf8'));
const WRITE = process.argv.includes('--write');
const BRAIN_ID = ids.brainWfId;
const BACKUP_DIR = path.resolve(__dirname, '..', '..', '..', 'backups');

// ─── NEW SYSTEM PROMPT ────────────────────────────────────────────────────────
const NEW_BASE_PROMPT = `You are Aaziko AI — the intelligent trade assistant for Aaziko, a B2B international trade platform.

## WHAT YOU DO
You help vendors, buyers, and trade teams with:
- Product search: finding suppliers, products, pricing by keyword or HS code
- Tariff search: import/export duties and rates by HS code and country pair
- Port search: port information, coordinates, facilities for logistics
- Trade compliance: import/export documentation requirements
- Buyer intelligence: finding potential buyers and importers for a product
- HS code lookup: forward (code → description) and reverse (product → code) lookup

## HOW YOU SPEAK
Detect language from user message and reply in SAME language:
- English → English
- Hindi/Hinglish → Hindi/Hinglish
- Gujarati/Gujlish → Gujlish
Default if unclear → English (B2B context, international users)
Keep responses SHORT and factual — this is a trade tool, not a chat.

## MULTI-QUERY RULE (IMPORTANT)
If the user asks about MULTIPLE things in ONE message, call ALL relevant tools and answer EVERY part.
Example: "cotton ka tariff aur buyers kaun hain?" → call search_tariff AND find_buyers, answer both.
Example: "export spices from India to USA — tariff, compliance, and best port?" → call search_tariff, get_compliance, AND find_port — all three.
Never ignore part of a question. If in doubt, call more tools, not fewer.

## TOOLS (ALWAYS use tools before answering factual questions)
- search_tariff: call with hs_code AND optionally importer_country + exporter_country. For "India to USA tariff" pass importer_country="United States" exporter_country="India".
- search_products: call with keyword. ALWAYS call for product/supplier questions.
- find_port: call with port_name or country. ALWAYS call for port/logistics questions.
- get_compliance: call with hs_code and country for import/export documentation requirements.
- find_buyers: call with keyword (product name) to find potential buyers/importers.
- lookup_hs_code: call with hs_code (6-digit) for description, OR product_name for reverse HS code lookup.

## RULES
- NEVER invent tariff rates, product details, or port data — always call the tool first.
- If a tool returns 0 results, say so plainly and suggest a broader search.
- Format numbers clearly: rates as "30%", prices as "USD X.XX/kg".
- For HS codes: accept 4, 6, or 8 digit inputs — search with the first 6 digits.
- When showing products, always include the supplier link if available.
- For trade routes ("export X from Y to Z"), call search_tariff + get_compliance + find_port together.
`;

// ─── NEW PRODUCTS FORMAT CODE ─────────────────────────────────────────────────
const NEW_PRODUCTS_FORMAT = [
  'const data = $input.first().json;',
  'const prep = $("Product Prep").first().json;',
  'const rows = data.rows || [];',
  'if (prep._error) return [{ json: { ok: false, error: prep._error } }];',
  'if (!rows.length) return [{ json: { ok: false, error: "No products found for: " + prep.keyword } }];',
  '',
  'const lines = rows.slice(0, 5).map(function(r, i) {',
  '  var name = r.product_name || "Unknown";',
  '  var company = r.company_name || r.seller_name || "";',
  '  var city = (r.seller_address && r.seller_address.city) ? r.seller_address.city : "";',
  '  var state = (r.seller_address && r.seller_address.state) ? r.seller_address.state : "";',
  '  var loc = [city, state].filter(Boolean).join(", ");',
  '  var link = r.product_url ? "\\n   Link: " + r.product_url : "";',
  '  var contact = "";',
  '  if (r.contact_details && r.contact_details.phone) {',
  '    contact = "\\n   Contact: " + r.contact_details.phone;',
  '  }',
  '  return (i+1) + ". *" + name + "*" +',
  '    "\\n   " + company + (loc ? ", " + loc : "") +',
  '    link + contact;',
  '});',
  '',
  'var summary = "Products matching \\"" + prep.keyword + "\\" (" + rows.length + " found):\\n" + lines.join("\\n");',
  'return [{ json: { ok: true, summary: summary, rowCount: rows.length } }];'
].join('\n');

// ─── NEW TARIFF PREP CODE (adds exporter_country / partner filter) ─────────────
const NEW_TARIFF_PREP = [
  'let inp = {};',
  'try { inp = typeof $input.first().json === "string" ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}',
  'const raw = String(inp.hs_code || inp.hsCode || inp.hs || "").replace(/\\D/g, "").slice(0, 6);',
  'const importer = String(inp.importer_country || inp.reporter || inp.country || "").trim();',
  'const exporter = String(inp.exporter_country || inp.partner || "").trim();',
  '',
  'if (!raw || raw.length < 4) {',
  '  return [{ json: { _error: "hs_code required (4-6 digits)", hs_code: raw } }];',
  '}',
  'const hs6 = raw.padEnd(6, "0").slice(0, 6);',
  '',
  '// Build match: hs6 required; importer (reporter_name) + exporter (partner_name) optional',
  'var matchQuery = { hs6: hs6 };',
  'if (importer) matchQuery.reporter_name = { "$regex": importer, "$options": "i" };',
  'if (exporter) matchQuery.partner_name = { "$regex": exporter, "$options": "i" };',
  '',
  'var label = hs6;',
  'if (importer && exporter) label += " (" + exporter + " → " + importer + ")";',
  'else if (importer) label += " (importer: " + importer + ")";',
  'else if (exporter) label += " (exporter: " + exporter + ")";',
  '',
  'return [{ json: { hs6: hs6, importer: importer || null, exporter: exporter || null, label: label, matchQuery: JSON.stringify(matchQuery) } }];'
].join('\n');

// Update tariff format to use new label
const NEW_TARIFF_FORMAT = [
  'const data = $input.first().json;',
  'const prep = $("Tariff Prep").first().json;',
  'const rows = data.rows || [];',
  'if (prep._error) return [{ json: { ok: false, error: prep._error } }];',
  'if (!rows.length) return [{ json: { ok: false, error: "No tariff data found for HS " + prep.hs6 + (prep.importer ? " in " + prep.importer : "") } }];',
  '',
  'const lines = rows.slice(0, 8).map(function(r) {',
  '  var partner = (r.partner_name && r.partner_name !== "World") ? " [partner: " + r.partner_name + "]" : "";',
  '  var rate = (r.simple_avg_rate !== null && r.simple_avg_rate !== undefined) ? r.simple_avg_rate + "% avg" : "-";',
  '  var range = (r.min_rate !== r.max_rate) ? " (min " + r.min_rate + "% / max " + r.max_rate + "%)" : "";',
  '  var yr = r.year ? " [" + r.year + "]" : "";',
  '  return "\\u2022 " + r.reporter_name + partner + " | " + (r.tariff_type || "MFN") + ": " + rate + range + yr;',
  '});',
  '',
  'var summary = "Tariff rates for HS " + prep.label + ":\\n" + lines.join("\\n");',
  'return [{ json: { ok: true, summary: summary, rowCount: rows.length } }];'
].join('\n');

(async () => {
  // ── 1. Brain changes ────────────────────────────────────────────────────
  const brain = await getWf(BRAIN_ID);

  const ctxIdx = brain.nodes.findIndex(n => n.name === 'Build Context');
  if (ctxIdx === -1) throw new Error('Build Context not found');
  const agentIdx = brain.nodes.findIndex(n => n.name === 'Aaziko AI Brain');
  if (agentIdx === -1) throw new Error('Aaziko AI Brain not found');

  // Extract current BASE_PROMPT from Build Context
  const ctxCode = brain.nodes[ctxIdx].parameters.jsCode;
  const bpStart = ctxCode.indexOf('BASE_PROMPT = `');
  const bpEnd = ctxCode.indexOf('`;\n\nconst systemPrompt');
  if (bpStart === -1 || bpEnd === -1) throw new Error('Could not find BASE_PROMPT boundaries in Build Context');

  console.log('Build Context: found BASE_PROMPT at chars', bpStart, '-', bpEnd);
  console.log('Agent maxIterations (before):', brain.nodes[agentIdx].parameters.options && brain.nodes[agentIdx].parameters.options.maxIterations);

  if (!WRITE) {
    console.log('\nDRY RUN — would change:');
    console.log('  1. BASE_PROMPT → multi-query guidance + partner tariff + link instruction');
    console.log('  2. Agent maxIterations: 6 → 10');
    console.log('  3. Products format: add product_url + contact_details');
    console.log('  4. Tariff prep: add exporter_country / partner filter');
    console.log('  5. Tariff format: show partner_name in results');
    console.log('\n(pass --write to apply)');
    return;
  }

  fs.writeFileSync(path.join(BACKUP_DIR, BRAIN_ID + '_before_multi_query_improve.json'), JSON.stringify(brain, null, 2));

  // Update BASE_PROMPT
  const newCtxCode = ctxCode.slice(0, bpStart) + 'BASE_PROMPT = `' + NEW_BASE_PROMPT + '`;\n\nconst systemPrompt' + ctxCode.slice(bpEnd + '`;\n\nconst systemPrompt'.length);
  brain.nodes[ctxIdx].parameters.jsCode = newCtxCode;

  // Update maxIterations
  if (brain.nodes[agentIdx].parameters.options) {
    brain.nodes[agentIdx].parameters.options.maxIterations = 10;
  } else {
    brain.nodes[agentIdx].parameters.options = { maxIterations: 10, enableStreaming: false, returnIntermediateSteps: true };
  }

  await putWf(BRAIN_ID, { name: brain.name, nodes: brain.nodes, connections: brain.connections, settings: brain.settings });
  await activate(BRAIN_ID);
  console.log('✅ Brain updated: system prompt + maxIterations=10');

  // ── 2. Products sub-workflow ────────────────────────────────────────────
  const prodWf = await getWf(ids.productWfId);
  fs.writeFileSync(path.join(BACKUP_DIR, ids.productWfId + '_before_format_improve.json'), JSON.stringify(prodWf, null, 2));

  const prodFmtIdx = prodWf.nodes.findIndex(n => n.name === 'Format Result');
  if (prodFmtIdx === -1) throw new Error('Products Format Result not found');
  prodWf.nodes[prodFmtIdx].parameters.jsCode = NEW_PRODUCTS_FORMAT;

  await putWf(ids.productWfId, { name: prodWf.name, nodes: prodWf.nodes, connections: prodWf.connections, settings: prodWf.settings });
  await activate(ids.productWfId);
  console.log('✅ Products format: added product_url + contact_details');

  // ── 3. Tariff sub-workflow ──────────────────────────────────────────────
  const tariffWf = await getWf(ids.tariffWfId);
  fs.writeFileSync(path.join(BACKUP_DIR, ids.tariffWfId + '_before_partner_improve.json'), JSON.stringify(tariffWf, null, 2));

  const tPrepIdx = tariffWf.nodes.findIndex(n => n.name === 'Tariff Prep');
  const tFmtIdx = tariffWf.nodes.findIndex(n => n.name === 'Format Result');
  if (tPrepIdx === -1) throw new Error('Tariff Prep not found');
  if (tFmtIdx === -1) throw new Error('Tariff Format Result not found');

  tariffWf.nodes[tPrepIdx].parameters.jsCode = NEW_TARIFF_PREP;
  tariffWf.nodes[tFmtIdx].parameters.jsCode = NEW_TARIFF_FORMAT;

  await putWf(ids.tariffWfId, { name: tariffWf.name, nodes: tariffWf.nodes, connections: tariffWf.connections, settings: tariffWf.settings });
  await activate(ids.tariffWfId);
  console.log('✅ Tariff: added partner/exporter filter + updated format');

  // ── Verify ──────────────────────────────────────────────────────────────
  const liveBrain = await getWf(BRAIN_ID);
  const lAgent = liveBrain.nodes.find(n => n.name === 'Aaziko AI Brain');
  const lCtx = liveBrain.nodes.find(n => n.name === 'Build Context');

  const maxIter = lAgent.parameters.options && lAgent.parameters.options.maxIterations;
  const hasMultiQuery = lCtx.parameters.jsCode.includes('MULTI-QUERY RULE');
  const hasTradeFlow = lCtx.parameters.jsCode.includes('export X from Y to Z');

  console.log('\n=== VERIFY ===');
  console.log('maxIterations:', maxIter, maxIter === 10 ? '✅' : '❌ expected 10');
  console.log('MULTI-QUERY RULE in prompt:', hasMultiQuery ? '✅' : '❌');
  console.log('trade-route instruction:', hasTradeFlow ? '✅' : '❌');
  console.log('Brain active:', liveBrain.active, '| nodes:', liveBrain.nodes.length);

  if (maxIter === 10 && hasMultiQuery) {
    console.log('\n✅ All improvements applied');
  } else {
    console.error('\n❌ Verification failed');
    process.exit(1);
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
