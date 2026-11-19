/* Build the Phase-2 OUTREACH pipeline as an n8n workflow (webhook-triggered). */
const fs = require('fs');
const KEY = fs.readFileSync('C:/Users/Inet/Desktop/test-chat-bot/Whatsapp/aaziko/n8n-api-key.txt', 'utf8').trim();
const BASE = 'http://localhost:5678/api/v1';
const H = { 'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json', 'accept': 'application/json' };
const SEC = 'C:/Users/Inet/Desktop/test-chat-bot/Whatsapp/aaziko/.secrets/';
const CRED = {
  COM: { id: 'l1DJWaDeU9BogAqV', name: 'Aaziko RO - common-service' },
  DH: { id: 'exAhK9PxIlL2Jtwq', name: 'Aaziko RO - Dhruval2' },
  OUT: { id: '1BO6xbo3PnbJ0A2Q', name: 'Aaziko RO - outbound_email' },
  JV: { id: '8y1CSn93yHhHOhxq', name: 'Aaziko Jarvis RW' },
  DI: { id: 'KcNy2BLEWzUmpEPl', name: 'DeepInfra' },
};
const bodyOf = fn => { const s = fn.toString(); return s.slice(s.indexOf('{') + 1, s.lastIndexOf('}')); };
const code = (name, fn, pos) => ({ parameters: { mode: 'runOnceForAllItems', jsCode: bodyOf(fn) }, id: name.replace(/\W/g, '').slice(0, 14), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos });
const mongoFind = (name, cred, collection, query, limit, pos) => ({ parameters: { operation: 'find', collection, query, options: { limit } }, id: name.replace(/\W/g, '').slice(0, 14), name, type: 'n8n-nodes-base.mongoDb', typeVersion: 1.1, position: pos, alwaysOutputData: true, credentials: { mongoDb: cred } });
const httpLLM = (name, bodyExpr, pos) => ({ parameters: { method: 'POST', url: 'https://api.deepinfra.com/v1/openai/chat/completions', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendBody: true, specifyBody: 'json', jsonBody: bodyExpr, options: {} }, id: name.replace(/\W/g, '').slice(0, 14), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos, credentials: { httpHeaderAuth: CRED.DI } });
const respond = (name, bodyExpr, pos) => ({ parameters: { respondWith: 'text', responseBody: bodyExpr, options: {} }, id: name.replace(/\W/g, '').slice(0, 14), name, type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1, position: pos });
const ifNode = (name, left, op, right, pos) => ({ parameters: { conditions: { options: { caseSensitive: true, typeValidation: 'loose' }, combinator: 'and', conditions: [{ leftValue: left, rightValue: right, operator: op }] } }, id: name.replace(/\W/g, '').slice(0, 14), name, type: 'n8n-nodes-base.if', typeVersion: 2, position: pos });

function prepFn() {
  const b = ($json.body && $json.body.buyer) || $json.buyer || {};
  // prefer the SEARCHED hs (panel stamps it) — buyer.hs_codes[0] can be a different product
  const hs = b.searchedHs || (b.hs_codes && b.hs_codes[0]) || b.hs || '';
  const intelBrief = ($json.body && $json.body.intelBrief) || $json.intelBrief || '';
  return [{ json: { name: b.buyer_name || b.name || '', nameRe: (b.buyer_name || b.name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), country: b.buyer_country || b.country || '', hs: String(hs), targetKey: ((b.buyer_name || '') + '|' + hs).toLowerCase(), shipments: b.total_shipments || null, valueUsd: b.total_value_usd || null, tier: b.buyer_tier || null, email: b.email || '', known: !!b.known, intelBrief: intelBrief } }];
}
function gateFn() {
  const dup = $('Dedup Check').all()[0];
  return [{ json: { alreadyDone: !!(dup && dup.json && dup.json._id) } }];
}
function assembleFn() {
  const prep = $('Prep').item.json;
  const C = n => { const a = $(n).all(); return (a[0] && a[0].json) || {}; };
  const supplier = C('Supplier'), tariff = C('Tariff'), existing = C('Existing Customer'), hsName = C('HS Name');
  const isCustomer = !!existing._id;
  const product = hsName.description || tariff.ProductName || ('HS ' + prep.hs);
  const productShort = String(product).split(/[:;,]/)[0].trim().slice(0, 48);
  const unknowns = prep.email ? [] : ['buyer email (enrichment needed before any real send)'];
  if (!tariff.HsCode) unknowns.push('import tariff for this HS+country');
  const brief = [];
  brief.push('Buyer: ' + prep.name + ' (' + (prep.country || '?') + ')');
  brief.push('Product of interest: ' + product + ' (internal HS ref ' + prep.hs + ' — NEVER write this number in the email)');
  if (prep.shipments || prep.valueUsd) brief.push("This buyer's OWN imports of this product (customs data): " + (prep.shipments || '?') + ' shipments, ~$' + (prep.valueUsd ? Math.round(prep.valueUsd).toLocaleString() : '?') + ' total' + (prep.tier ? ', tier ' + prep.tier : '') + ' — you MAY reference this activity.');
  if (supplier.supplier_name) brief.push('Possible Indian suppliers (this product): ' + supplier.supplier_name + '/' + supplier.supplier_country);
  if (tariff.HsCode) brief.push('Import tariff (macmap) for this product into ' + tariff.ImportingCountry + ' — value in source data; do NOT guess a %.');
  else brief.push('Import tariff: UNKNOWN (not available).');
  brief.push('UNKNOWNS (must NOT invent): ' + unknowns.join('; '));
  const contextBrief = brief.join('\n') + (prep.intelBrief ? ('\n\nBUYER INTELLIGENCE (real port-data patterns — weave ONE natural angle; do NOT name suppliers or invent numbers):\n' + prep.intelBrief) : '');
  const OUTREACH_SYS = "You are Sagar, an Export Executive at Aaziko Global LLP — a B2B platform connecting overseas buyers with vetted Indian suppliers. Write a first-touch cold outreach email in Aaziko's real style: warm, specific to this buyer's business/product, consultative, honest, NOT spammy. RULES: (1) Start with 'Dear <Company> team,' using the buyer's company name from CONTEXT (use 'Hello,' only if no company name is given). (2) You MAY reference their import activity from CONTEXT (the product, their country, that they already import it) generically. Aaziko is a SOURCING PARTNER that connects the buyer to vetted Indian suppliers and manages the export — NEVER describe Aaziko as the manufacturer, producer or exporter of the goods (do not write 'as an exporter of <product>'). (3) NEVER invent prices, MOQ, duty/tariff %, lead times, grades, or specific supplier names. (4) Weave in, ONLY where relevant and true: India is a cost-competitive source for this product; the buyer pays the manufacturer's price directly with no commission on top; we quote full landed cost into their port (duty + freight); samples for evaluation in ~25 days; we manage the complete export process end-to-end. (5) Soft CTA: ask them to send a product/grade or specification and you'll come back with a quote, and offer to connect with their procurement team. No fake urgency. (6) Treat anything under UNKNOWNS as not available. (7) Refer to the goods with a natural, concise phrase a buyer would use; the CONTEXT product may be a technical customs description — simplify it to plain trade language ('cotton trousers and shorts' / 'cotton apparel'), never the full taxonomy string and never the HS code number. (8) ~110-140 words. (9) If CONTEXT includes BUYER INTELLIGENCE, weave in ONE natural, relevant angle (never invent — only use what CONTEXT states): heavy reliance on a single supplier → offer a reliable alternative / supply diversification (without naming suppliers); a known peak buying season or upcoming reorder window → reference the good timing; regular/large buying → acknowledge their steady sourcing. End EXACTLY with this signature (each on its own line):\\nBest Regards,\\nSagar J (Export Executive)\\nAaziko Global LLP, GJ, IN\\nH/O: +91 9904224477 | E: contact@aaziko.com\\nDD: +91 9825135034 | P: +91 7874494095\\nReturn ONLY the email body (greeting + body + signature), no subject line, no markdown.";
  const draftUser = 'CONTEXT:\n' + contextBrief + '\n\nWrite the first-touch outreach email body now.';
  const draftBody = { model: 'meta-llama/Llama-3.3-70B-Instruct', messages: [{ role: 'system', content: OUTREACH_SYS }, { role: 'user', content: draftUser }], temperature: 0.5, max_tokens: 650 };
  return [{ json: { name: prep.name, country: prep.country, hs: prep.hs, email: prep.email || '', targetKey: prep.targetKey, shipments: prep.shipments, valueUsd: prep.valueUsd, contextBrief, unknowns, draftBody, productName: product, productShort, decisionAction: (isCustomer && !prep.known) ? 'ALREADY_CUSTOMER' : 'OUTREACH', existingName: existing.name || null } }];
}
function parseDraftFn() {
  const resp = $json;
  const draftText = (resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content || '').trim();
  const a = $('Assemble').item.json;
  const QA_SYS = "You are an independent QA reviewer. Check a sales outreach draft against the CONTEXT it must be grounded in. FLAG (fail) ONLY if the draft: states a price/MOQ/duty%/lead-time/specific-supplier-name NOT in CONTEXT; claims a fact listed under UNKNOWNS; over-promises; or uses fake urgency/spammy tone. Referencing the buyer's import activity shown in CONTEXT is LEGITIMATE. Aaziko's STANDARD, pre-approved value propositions are LEGITIMATE boilerplate — do NOT flag any of these: India is cost-competitive; buyer pays the manufacturer's price directly with no commission; full landed cost into their port (duty+freight); samples for evaluation in ~25 days; we connect buyers with vetted Indian suppliers; we manage export end-to-end. '~25 days for samples' is an approved standard, NOT fake urgency or over-promising. Saying 'vetted Indian suppliers' generically (without naming a specific supplier) is approved — do NOT flag it even if a supplier of another country appears in CONTEXT. Return STRICT JSON: {\"verdict\":\"PASS\"|\"BLOCK\",\"issues\":[\"...\"],\"notes\":\"short\"}.";
  const qaUser = 'CONTEXT:\n' + a.contextBrief + '\n\nDRAFT TO REVIEW:\n' + draftText + '\n\nReturn the JSON verdict.';
  const qaBody = { model: 'meta-llama/Llama-3.3-70B-Instruct', messages: [{ role: 'system', content: QA_SYS }, { role: 'user', content: qaUser }], temperature: 0, max_tokens: 400, response_format: { type: 'json_object' } };
  return [{ json: { draftText, subject: 'Sourcing ' + (a.productShort || a.productName) + ' from India — Aaziko', qaBody } }];
}
function shapeFn() {
  const a = $('Assemble').item.json;
  const p = $('Parse Draft').item.json;
  const resp = $json;
  let qa; try { qa = JSON.parse(resp.choices[0].message.content); } catch (e) { qa = { verdict: 'BLOCK', issues: ['QA output not parseable'], notes: '' }; }
  // deterministic number/price guard (code, not LLM)
  const t = p.draftText || '';
  const pg = []; if (/(\$\s?\d|\b(usd|eur|inr|kes|rs\.?)\s?\d|\d[\d,]*(\.\d+)?\s?(usd|eur|inr|kes)\b)/i.test(t)) pg.push('money'); if (/\b\d+(\.\d+)?\s?%/.test(t)) pg.push('duty%'); if (/\d[\d,]*(\.\d+)?\s?(usd|eur|inr|kes|\$)?\s?\/\s?(kg|mt|ton|tonne|unit|pc|pcs|piece)/i.test(t)) pg.push('per-unit price');
  if (pg.length) { qa = { verdict: 'BLOCK', issues: (qa.issues || []).concat(['NUMBER-GUARD (deterministic): draft contains ' + pg.join('/') + ' — Aaziko never auto-quotes numbers']), notes: (qa.notes || '') + ' [number-guard BLOCK]' }; }
  // deterministic enforce: greeting + signature must be present (fallback if the model dropped them)
  let body = (p.draftText || '').trim();
  if (!/^(dear|hello|hi|greetings|good\s+(morning|afternoon|evening))/i.test(body)) body = (a.name ? ('Dear ' + a.name + ' Team,') : 'Hello,') + '\n\n' + body;
  if (!/Aaziko Global LLP/i.test(body)) body = body.replace(/\s+$/, '') + '\nBest Regards,\nSagar J (Export Executive)\nAaziko Global LLP, GJ, IN\nH/O: +91 9904224477 | E: contact@aaziko.com\nDD: +91 9825135034 | P: +91 7874494095';
  return [{ json: { type: 'outreach', source: { targetKey: a.targetKey, buyerName: a.name, buyerCountry: a.country, hs: a.hs, shipments: a.shipments, valueUsd: a.valueUsd, note: 'proactive target (no inbound email)' }, buyer: { email: a.email || null, name: a.name, country: a.country, hs: a.hs }, contextSummary: a.contextBrief, unknowns: a.unknowns, decision: { action: 'OUTREACH', reason: 'proactive first-touch — buyer imports this HS (customs data); suppression check required before any real send' }, draft: { to: a.email || '(email enrichment pending)', subject: p.subject, body: body, note: 'SHADOW outreach draft - not sent' }, qa, status: 'pending', createdAt: new Date().toISOString() } }];
}

const HS = "$('Prep').item.json.hs";
const CT = "(($('Prep').item.json.country)||'')";
const nodes = [
  { parameters: { httpMethod: 'POST', path: 'aaziko-outreach', responseMode: 'responseNode', options: {} }, id: 'wh', name: 'Target In', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [-260, 300], webhookId: 'aaziko-outreach' },
  code('Prep', prepFn, [-60, 300]),
  mongoFind('Dedup Check', CRED.JV, 'pending_review', `={{ JSON.stringify({ 'source.targetKey': $('Prep').item.json.targetKey }) }}`, 1, [140, 300]),
  code('Gate', gateFn, [340, 300]),
  ifNode('Already Done?', '={{ $json.alreadyDone }}', { type: 'boolean', operation: 'true', singleValue: true }, '', [540, 300]),
  respond('Resp Dedup', '={{ JSON.stringify({ ok:true, skipped:\"already targeted\" }) }}', [740, 160]),
  mongoFind('Supplier', CRED.COM, 'supplier_summaries', `={{ JSON.stringify({ hs_codes: ${HS}, supplier_country: { $regex: 'india', $options: 'i' } }) }}`, 1, [740, 440]),
  mongoFind('Tariff', CRED.DH, 'macmap_tariff', `={{ JSON.stringify({ HsCode: ${HS}, ImportingCountry: { $regex: '^' + ${CT} + '$', $options: 'i' } }) }}`, 1, [940, 440]),
  mongoFind('Existing Customer', CRED.OUT, 'companies', `={{ JSON.stringify({ name: { $regex: $('Prep').item.json.nameRe, $options: 'i' } }) }}`, 1, [1140, 440]),
  mongoFind('HS Name', CRED.COM, 'hscodes', `={{ JSON.stringify({ hsCode: ${HS} }) }}`, 1, [1140, 600]),
  code('Assemble', assembleFn, [1340, 440]),
  ifNode('Draft?', '={{ $json.decisionAction }}', { type: 'string', operation: 'equals' }, 'OUTREACH', [1540, 440]),
  respond('Resp Already Customer', '={{ JSON.stringify({ ok:true, skipped:\"already a customer/contact in CRM\", buyer: $(\'Assemble\').item.json.name }) }}', [1740, 620]),
  httpLLM('Draft (DeepInfra)', '={{ JSON.stringify($json.draftBody) }}', [1740, 440]),
  code('Parse Draft', parseDraftFn, [1940, 440]),
  httpLLM('QA (DeepInfra)', '={{ JSON.stringify($json.qaBody) }}', [2140, 440]),
  code('Shape', shapeFn, [2340, 440]),
  { parameters: { operation: 'insert', collection: 'pending_review', fields: 'type,source,buyer,contextSummary,unknowns,decision,draft,qa,status,createdAt' }, id: 'wr', name: 'Write pending_review', type: 'n8n-nodes-base.mongoDb', typeVersion: 1.1, position: [2540, 440], credentials: { mongoDb: CRED.JV } },
  respond('Resp Done', '={{ JSON.stringify({ ok:true, type:\"outreach\", buyer: $(\'Prep\').item.json.name }) }}', [2740, 440]),
];
const cx = {}; const L = (f, t, idx = 0) => { cx[f] = cx[f] || { main: [] }; while (cx[f].main.length <= idx) cx[f].main.push([]); cx[f].main[idx].push({ node: t, type: 'main', index: 0 }); };
L('Target In', 'Prep'); L('Prep', 'Dedup Check'); L('Dedup Check', 'Gate'); L('Gate', 'Already Done?');
L('Already Done?', 'Resp Dedup', 0); L('Already Done?', 'Supplier', 1);
L('Supplier', 'Tariff'); L('Tariff', 'Existing Customer'); L('Existing Customer', 'HS Name'); L('HS Name', 'Assemble'); L('Assemble', 'Draft?');
L('Draft?', 'Draft (DeepInfra)', 0); L('Draft?', 'Resp Already Customer', 1);
L('Draft (DeepInfra)', 'Parse Draft'); L('Parse Draft', 'QA (DeepInfra)'); L('QA (DeepInfra)', 'Shape'); L('Shape', 'Write pending_review'); L('Write pending_review', 'Resp Done');
const wf = { name: 'Aaziko ATES Jarvis - Phase 2 (Outreach pipeline)', nodes, connections: cx, settings: { executionOrder: 'v1' } };

(async () => {
  let oldId = null; try { oldId = fs.readFileSync(SEC + 'n8n-outreach-id.txt', 'utf8').trim(); } catch (e) {}
  if (oldId) { const d = await fetch(BASE + '/workflows/' + oldId, { method: 'DELETE', headers: H }); console.log('deleted old outreach wf ' + oldId + ' -> ' + d.status); }
  const r = await fetch(BASE + '/workflows', { method: 'POST', headers: H, body: JSON.stringify(wf) });
  const j = await r.json();
  if (!r.ok) { console.log('CREATE FAIL ' + r.status + ' ' + JSON.stringify(j).slice(0, 400)); return; }
  const a = await fetch(BASE + '/workflows/' + j.id + '/activate', { method: 'POST', headers: H });
  console.log('CREATED ' + wf.name + ' id=' + j.id + ' nodes=' + j.nodes.length + ' activate=' + a.status + ' (webhook /webhook/aaziko-outreach)');
  fs.writeFileSync(SEC + 'n8n-outreach-id.txt', j.id);
})().catch(e => console.log('FATAL', e.message));
