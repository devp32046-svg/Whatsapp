'use strict';
/* Single source of truth for ALL n8n Code-node strings in Aaziko Brain.
 * deploy scripts import from here; selftest.js runs these exact strings.
 * NEVER inline Code-node logic in deploy scripts — edit here, then redeploy.
 */

// ─── GATEWAY: Normalize incoming message ─────────────────────────────────────
// Used in: Brain Gateway webhook flow
// Input: POST body {message, sessionId, channel:'ui'} from UI
//        or future: WhatsApp inbound {text, senderPhone, ...}
const NORMALIZE_MSG = `
const body = ($input.first().json.body) || $input.first().json;
const channel = String(body.channel || 'ui');
const text = String(body.message || body.text || '').trim();
const sessionId = String(body.sessionId || body.phoneNumber || 'anon').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50) || ('anon-' + Date.now());
const secret = String(body.secret || body.k || '');

if (!text) return [{ json: { _skip: true, reason: 'empty_message' } }];

return [{ json: {
  channel,
  text,
  sessionId,
  chatInput: text,
  sessionKey: 'az-' + sessionId,
  secret,
  ts: String(Date.now())
} }];
`.trim();

// ─── GATEWAY: Auth gate ───────────────────────────────────────────────────────
// Used in: Brain Gateway — rejects wrong chat secret
// BRAIN_CHAT_SECRET injected at deploy time via buildAuthGate(secret)
function buildAuthGate(secret) {
  return `
const g = $input.first().json;
if (g._skip) return [{ json: g }];
const EXPECTED = ${JSON.stringify(secret)};
const given = g.secret || '';
if (given !== EXPECTED) return [{ json: { _skip: true, reason: 'bad_secret' } }];
return [{ json: g }];
`.trim();
}

// ─── GATEWAY: Build Context (systemPrompt + chatInput) ───────────────────────
// Used in: Brain Gateway — feeds the agent
const BUILD_CONTEXT = `
const g = ($('Auth Gate').first() || { json: {} }).json;
const cfg = ($('Load Config').first() || { json: {} }).json;

const BASE_PROMPT = \`You are Aaziko AI — the intelligent trade assistant for Aaziko, a B2B international trade platform.

## WHAT YOU DO
You help vendors, buyers, and trade teams with:
- Product search: finding suppliers, products, pricing by keyword or HS code
- Tariff search: import/export duties and rates by HS code and country
- Port search: port information, coordinates, facilities for logistics
- Trade compliance: import/export documentation requirements

## HOW YOU SPEAK
Detect language from user message and reply in SAME language:
- English -> English
- Hindi/Hinglish -> Hindi/Hinglish
- Gujarati/Gujlish -> Gujlish
Default if unclear -> English (B2B context, international users)
Keep responses SHORT and factual — this is a trade tool, not a chat.

## TOOLS (ALWAYS use tools before answering factual questions)
- search_tariff: call with hs_code (6-digit) and optionally country. ALWAYS call this for ANY tariff/duty/rate question.
- search_products: call with keyword. ALWAYS call for product/supplier questions.
- find_port: call with port_name or country. ALWAYS call for port/logistics questions.
- get_compliance: call with hs_code and country for import/export documentation requirements.

## RULES
- NEVER invent tariff rates, product details, or port data — always call the tool.
- If a tool returns 0 results, say so plainly and suggest a broader search.
- Format numbers clearly: rates as "30%", prices as "USD X.XX/kg".
- For HS codes: accept 4, 6, or 8 digit inputs — search with the first 6 digits.
\`;

const systemPrompt = BASE_PROMPT + (cfg.extraPrompt ? '\\n\\n' + cfg.extraPrompt : '');

return [{ json: {
  chatInput: g.chatInput,
  sessionKey: g.sessionKey,
  systemPrompt: systemPrompt,
  channel: g.channel,
  sessionId: g.sessionId,
  ts: g.ts
} }];
`.trim();

// ─── GATEWAY: Parse Reply ─────────────────────────────────────────────────────
// Used in: Brain Gateway — cleans agent output for UI/WhatsApp
const PARSE_REPLY = `
const out = $input.first().json;
let text = String(out.output || out.text || out.replyText || '').trim();

// Clean markdown -> plain text (WhatsApp/UI safe)
text = text
  .replace(/\\*\\*\\*([^*\\n]+?)\\*\\*\\*/g, '*$1*')
  .replace(/\\*\\*([^*\\n]+?)\\*\\*/g, '*$1*')
  .replace(/#{1,6}\\s+/g, '')
  .replace(/\\n{3,}/g, '\\n\\n')
  .trim();

const prevChannel = ($('Normalize Message').first() || { json: {} }).json.channel || 'ui';
return [{ json: { replyText: text, channel: prevChannel } }];
`.trim();

// ─── TOOL: search_tariff ─────────────────────────────────────────────────────
// Sub-workflow code: query wits.tariff_trains
// n8n receives tool input JSON; returns formatted tariff info
const TOOL_TARIFF_PREP = `
// Extract tool input (agent passes JSON string or object)
let inp = {};
try { inp = typeof $input.first().json === 'string' ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}
const raw = String(inp.hs_code || inp.hsCode || inp.hs || '').replace(/\\D/g, '').slice(0, 6);
const country = String(inp.country || inp.reporter || '').trim();

if (!raw || raw.length < 4) {
  return [{ json: { _error: 'hs_code required (4-6 digits)', hs_code: raw } }];
}
// Pad to 6 digits if only 4 given
const hs6 = raw.padEnd(6, '0').slice(0, 6);

const matchQuery = country
  ? { hs6, reporter_name: { $regex: country, $options: 'i' } }
  : { hs6 };

return [{ json: { hs6, country: country || null, matchQuery: JSON.stringify(matchQuery) } }];
`.trim();

const TOOL_TARIFF_FORMAT = `
const rows = $input.all().map(x => x.json);
const prep = $('Tariff Prep').first().json;
if (prep._error) return [{ json: { ok: false, error: prep._error } }];
if (!rows.length) return [{ json: { ok: false, error: 'No tariff data found for HS ' + prep.hs6 + (prep.country ? ' in ' + prep.country : '') } }];

const lines = rows.slice(0, 8).map(r =>
  '• ' + r.reporter_name + ' (' + r.tariff_type + '): ' + (r.simple_avg_rate ?? '-') + '% avg' +
  (r.min_rate !== r.max_rate ? ' (min ' + r.min_rate + '% / max ' + r.max_rate + '%)' : '') +
  ' — ' + (r.product_name || r.hs6)
).join('\\n');

const summary = 'Tariff for HS ' + prep.hs6 + (prep.country ? ' in ' + prep.country : ' (top results)') + ':\\n' + lines +
  (rows.length > 8 ? '\\n...and ' + (rows.length - 8) + ' more countries.' : '');

return [{ json: { ok: true, hs6: prep.hs6, country: prep.country, count: rows.length, summary } }];
`.trim();

// ─── TOOL: search_products ───────────────────────────────────────────────────
// Sub-workflow code: query indiamart.products by keyword
const TOOL_PRODUCT_PREP = `
let inp = {};
try { inp = typeof $input.first().json === 'string' ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}
const keyword = String(inp.keyword || inp.product || inp.query || '').trim();
if (!keyword) return [{ json: { _error: 'keyword required' } }];
// Use MongoDB $text search if index exists, otherwise regex on product_name
return [{ json: { keyword, matchQuery: JSON.stringify({ product_name: { $regex: keyword, $options: 'i' } }) } }];
`.trim();

const TOOL_PRODUCT_FORMAT = `
const rows = $input.all().map(x => x.json);
const prep = $('Product Prep').first().json;
if (prep._error) return [{ json: { ok: false, error: prep._error } }];
if (!rows.length) return [{ json: { ok: false, error: 'No products found for: ' + prep.keyword } }];

const lines = rows.slice(0, 5).map((r, i) =>
  (i+1) + '. *' + (r.product_name || 'Unknown') + '*' +
  '\\n   ' + (r.company_name || '') +
  (r.seller_address && r.seller_address.city ? ', ' + r.seller_address.city : '') +
  (r.seller_address && r.seller_address.state ? ', ' + r.seller_address.state : '')
).join('\\n\\n');

const summary = 'Products matching "' + prep.keyword + '" (' + rows.length + ' found, showing top 5):\\n\\n' + lines;
return [{ json: { ok: true, keyword: prep.keyword, count: rows.length, summary } }];
`.trim();

// ─── TOOL: find_port ─────────────────────────────────────────────────────────
// Sub-workflow: query searates-scraper.ports + detailed_ports
const TOOL_PORT_PREP = `
let inp = {};
try { inp = typeof $input.first().json === 'string' ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}
const portName = String(inp.port_name || inp.port || '').trim();
const country = String(inp.country || '').trim();
if (!portName && !country) return [{ json: { _error: 'port_name or country required' } }];
const filter = {};
if (portName) filter.port_name = { $regex: portName, $options: 'i' };
if (country) filter.country_name = { $regex: country, $options: 'i' };
return [{ json: { portName, country, matchQuery: JSON.stringify(filter) } }];
`.trim();

const TOOL_PORT_FORMAT = `
const rows = $input.all().map(x => x.json);
const prep = $('Port Prep').first().json;
if (prep._error) return [{ json: { ok: false, error: prep._error } }];
if (!rows.length) return [{ json: { ok: false, error: 'No ports found for: ' + (prep.portName || prep.country) } }];

const lines = rows.slice(0, 5).map(r => {
  const coords = r.coordinates ? r.coordinates.decimal || '' : '';
  return '• *' + r.port_name + '*, ' + r.country_name +
    (coords ? '  [' + coords + ']' : '') +
    (r.communications && r.communications.air === 'available' ? '  ✈ Air' : '') +
    (r.communications && r.communications.rail === 'available' ? '  🚂 Rail' : '');
}).join('\\n');

const summary = 'Ports matching "' + (prep.portName || prep.country) + '" (' + rows.length + ' found):\\n' + lines;
return [{ json: { ok: true, count: rows.length, summary } }];
`.trim();

// ─── TOOL: get_compliance ────────────────────────────────────────────────────
// Sub-workflow: query aaziko_organized import/export requirements
const TOOL_COMPLIANCE_PREP = `
let inp = {};
try { inp = typeof $input.first().json === 'string' ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}
const hs = String(inp.hs_code || inp.hs || '').replace(/\\D/g, '').slice(0, 6);
const country = String(inp.country || '').trim();
if (!hs && !country) return [{ json: { _error: 'hs_code or country required' } }];
const filter = { 'source.org': 'aaziko-import-export-1', domain: 'trade_rules' };
if (hs) filter['applicability.product.code'] = { $regex: '^' + hs };
if (country) {
  filter['$or'] = [
    { 'applicability.reporter': { $regex: country, $options: 'i' } },
    { 'applicability.partner_keys': { $regex: country, $options: 'i' } }
  ];
}
return [{ json: { hs, country, matchQuery: JSON.stringify(filter) } }];
`.trim();

const TOOL_COMPLIANCE_FORMAT = `
const rows = $input.all().map(x => x.json);
const prep = $('Compliance Prep').first().json;
if (prep._error) return [{ json: { ok: false, error: prep._error } }];
if (!rows.length) return [{ json: { ok: false, error: 'No compliance data found for HS ' + (prep.hs || '?') + ' / ' + (prep.country || 'any country') } }];

const lines = rows.slice(0, 5).map(r => {
  const kind = r.kind || r.domain || 'requirement';
  const body = r.authority && r.authority.body ? r.authority.body : '';
  return '• [' + kind + ']' + (body ? ' ' + body : '') + ': ' + JSON.stringify(r).slice(0, 120);
}).join('\\n');

const summary = 'Compliance requirements (' + rows.length + ' records):\\n' + lines;
return [{ json: { ok: true, count: rows.length, summary } }];
`.trim();

// ─── Exports ─────────────────────────────────────────────────────────────────
module.exports = {
  NORMALIZE_MSG,
  buildAuthGate,
  BUILD_CONTEXT,
  PARSE_REPLY,
  TOOL_TARIFF_PREP,
  TOOL_TARIFF_FORMAT,
  TOOL_PRODUCT_PREP,
  TOOL_PRODUCT_FORMAT,
  TOOL_PORT_PREP,
  TOOL_PORT_FORMAT,
  TOOL_COMPLIANCE_PREP,
  TOOL_COMPLIANCE_FORMAT,
};
