'use strict';
/* Aaziko Brain — selftest: runs exact shipped Code-node strings via new Function().
 * node aaziko/brain/selftest.js   → all pass or exits 1
 */
const NC = require('./lib/node-code');
let pass = 0, fail = 0;

// ── helpers ──────────────────────────────────────────────────────────────────
function ck(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
  if (!ok) { console.log('      got:', JSON.stringify(got)); console.log('      exp:', JSON.stringify(expected)); }
  ok ? pass++ : fail++;
}
function ckTruthy(label, got) {
  const ok = !!got;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
  if (!ok) console.log('      got:', JSON.stringify(got));
  ok ? pass++ : fail++;
}
function ckIncludes(label, got, substr) {
  const ok = typeof got === 'string' && got.includes(substr);
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
  if (!ok) console.log('      got:', JSON.stringify(got?.slice(0, 200)));
  ok ? pass++ : fail++;
}

// Run a Code-node string with stubbed n8n context
function runCode(code, inputItems, extraNodes) {
  const nodes = extraNodes || {};
  const $ = (name) => ({
    first: () => ({ json: (nodes[name] || {}) }),
    all: () => [{ json: (nodes[name] || {}) }]
  });
  const $input = {
    first: () => ({ json: inputItems[0] || {} }),
    all: () => inputItems.map(j => ({ json: j }))
  };
  const $json = inputItems[0] || {};
  return new Function('$input', '$json', '$', 'return (function(){\n' + code + '\n})()')(
    $input, $json, $
  );
}

// ── NORMALIZE_MSG ─────────────────────────────────────────────────────────────
console.log('\n--- NORMALIZE_MSG ---');
{
  const r = runCode(NC.NORMALIZE_MSG, [{ message: 'cotton yarn', sessionId: 'user123', channel: 'ui', secret: 'abc' }]);
  ck('text message extracted', r[0].json.text, 'cotton yarn');
  ck('chatInput same as text', r[0].json.chatInput, 'cotton yarn');
  ck('channel ui', r[0].json.channel, 'ui');
  ck('sessionKey prefix', r[0].json.sessionKey, 'az-user123');
  ck('secret passed', r[0].json.secret, 'abc');
}
{
  const r = runCode(NC.NORMALIZE_MSG, [{ message: '', sessionId: 'x', channel: 'ui' }]);
  ck('empty message skipped', r[0].json._skip, true);
}
{
  const r = runCode(NC.NORMALIZE_MSG, [{ text: 'hello', channel: 'ui' }]);
  ckTruthy('text field alternative', r[0].json.chatInput === 'hello');
  ckTruthy('anon sessionId generated', r[0].json.sessionKey.startsWith('az-anon'));
}

// ── buildAuthGate ─────────────────────────────────────────────────────────────
console.log('\n--- buildAuthGate ---');
{
  const gate = NC.buildAuthGate('mysecret');
  ckTruthy('code is a string', typeof gate === 'string');
  const r1 = runCode(gate, [{ text: 'hi', secret: 'mysecret', sessionId: 'x', channel: 'ui' }]);
  ck('correct secret passes', r1[0].json._skip, undefined);
  const r2 = runCode(gate, [{ text: 'hi', secret: 'wrong', sessionId: 'x', channel: 'ui' }]);
  ck('wrong secret skipped', r2[0].json._skip, true);
  const r3 = runCode(gate, [{ _skip: true, reason: 'empty_message' }]);
  ck('already-skipped passes through', r3[0].json._skip, true);
}

// ── BUILD_CONTEXT ─────────────────────────────────────────────────────────────
console.log('\n--- BUILD_CONTEXT ---');
{
  const r = runCode(NC.BUILD_CONTEXT,
    [{ botId: 'aaziko_brain_v1' }],
    { 'Auth Gate': { chatInput: 'show tariff', sessionKey: 'az-u1', channel: 'ui', sessionId: 'u1', ts: '123' }, 'Load Config': { extraPrompt: null } }
  );
  ckTruthy('returns chatInput', r[0].json.chatInput === 'show tariff');
  ckIncludes('systemPrompt has Aaziko AI', r[0].json.systemPrompt, 'Aaziko AI');
  ckIncludes('systemPrompt has search_tariff tool', r[0].json.systemPrompt, 'search_tariff');
  ckIncludes('systemPrompt has search_products', r[0].json.systemPrompt, 'search_products');
  ckIncludes('systemPrompt has find_port', r[0].json.systemPrompt, 'find_port');
  ckIncludes('systemPrompt has get_compliance', r[0].json.systemPrompt, 'get_compliance');
  ck('channel passed through', r[0].json.channel, 'ui');
}

// ── PARSE_REPLY ───────────────────────────────────────────────────────────────
console.log('\n--- PARSE_REPLY ---');
{
  const r = runCode(NC.PARSE_REPLY,
    [{ output: '**Bold** and ***italic***\n\n\n\ntext' }],
    { 'Normalize Message': { channel: 'ui' } }
  );
  ckIncludes('bold markdown cleaned', r[0].json.replyText, '*Bold*');
  ck('channel from Normalize', r[0].json.channel, 'ui');
  const noTripleNewline = !r[0].json.replyText.includes('\n\n\n');
  ck('triple newline collapsed', noTripleNewline, true);
}

// ── TOOL_TARIFF_PREP ──────────────────────────────────────────────────────────
console.log('\n--- TOOL_TARIFF_PREP ---');
{
  const r = runCode(NC.TOOL_TARIFF_PREP, [{ hs_code: '630110', country: 'India' }]);
  ck('hs6 extracted', r[0].json.hs6, '630110');
  ck('country passed', r[0].json.country, 'India');
  ckTruthy('matchQuery includes country regex', r[0].json.matchQuery.includes('India'));
}
{
  const r = runCode(NC.TOOL_TARIFF_PREP, [{ hs_code: '6301' }]);
  ck('4-digit HS padded to 6', r[0].json.hs6, '630100');
}
{
  const r = runCode(NC.TOOL_TARIFF_PREP, [{}]);
  ckTruthy('no hs_code returns error', !!r[0].json._error);
}

// ── TOOL_TARIFF_FORMAT ────────────────────────────────────────────────────────
console.log('\n--- TOOL_TARIFF_FORMAT ---');
{
  const rows = [
    { reporter_name: 'India', tariff_type: 'MFN', simple_avg_rate: 30, min_rate: 30, max_rate: 30, product_name: 'Blankets' },
    { reporter_name: 'UAE', tariff_type: 'MFN', simple_avg_rate: 5, min_rate: 0, max_rate: 10, product_name: 'Blankets' }
  ];
  const r = runCode(NC.TOOL_TARIFF_FORMAT, rows, { 'Tariff Prep': { hs6: '630110', country: 'India' } });
  ck('ok true', r[0].json.ok, true);
  ckIncludes('summary has India', r[0].json.summary, 'India');
  ckIncludes('summary has rate', r[0].json.summary, '30%');
}
{
  const r = runCode(NC.TOOL_TARIFF_FORMAT, [], { 'Tariff Prep': { hs6: '999999', country: null } });
  ck('no rows returns error', r[0].json.ok, false);
}
{
  const r = runCode(NC.TOOL_TARIFF_FORMAT, [], { 'Tariff Prep': { _error: 'hs_code required' } });
  ck('prep error propagated', r[0].json.ok, false);
}

// ── TOOL_PRODUCT_PREP ─────────────────────────────────────────────────────────
console.log('\n--- TOOL_PRODUCT_PREP ---');
{
  const r = runCode(NC.TOOL_PRODUCT_PREP, [{ keyword: 'marble tiles' }]);
  ck('keyword extracted', r[0].json.keyword, 'marble tiles');
  ckTruthy('matchQuery has regex', r[0].json.matchQuery.includes('regex'));
}
{
  const r = runCode(NC.TOOL_PRODUCT_PREP, [{}]);
  ckTruthy('no keyword returns error', !!r[0].json._error);
}

// ── TOOL_PRODUCT_FORMAT ───────────────────────────────────────────────────────
console.log('\n--- TOOL_PRODUCT_FORMAT ---');
{
  const rows = [
    { product_name: 'White Marble Tile', company_name: 'ABC Stones', seller_address: { city: 'Ahmedabad', state: 'Gujarat' } },
    { product_name: 'Marble Floor Tile', company_name: 'XYZ Marbles', seller_address: { city: 'Surat', state: 'Gujarat' } }
  ];
  const r = runCode(NC.TOOL_PRODUCT_FORMAT, rows, { 'Product Prep': { keyword: 'marble' } });
  ck('ok true', r[0].json.ok, true);
  ckIncludes('summary has product name', r[0].json.summary, 'White Marble Tile');
  ckIncludes('summary has city', r[0].json.summary, 'Ahmedabad');
}

// ── TOOL_PORT_PREP ────────────────────────────────────────────────────────────
console.log('\n--- TOOL_PORT_PREP ---');
{
  const r = runCode(NC.TOOL_PORT_PREP, [{ port_name: 'Mumbai', country: 'India' }]);
  ck('port name extracted', r[0].json.portName, 'Mumbai');
  ckTruthy('matchQuery has port regex', r[0].json.matchQuery.includes('Mumbai'));
}
{
  const r = runCode(NC.TOOL_PORT_PREP, [{}]);
  ckTruthy('no args returns error', !!r[0].json._error);
}

// ── TOOL_PORT_FORMAT ──────────────────────────────────────────────────────────
console.log('\n--- TOOL_PORT_FORMAT ---');
{
  const rows = [
    { port_name: 'Mumbai', country_name: 'India', coordinates: { decimal: '18.9333, 72.8333' }, communications: { air: 'available', rail: 'available' } }
  ];
  const r = runCode(NC.TOOL_PORT_FORMAT, rows, { 'Port Prep': { portName: 'Mumbai', country: 'India' } });
  ck('ok true', r[0].json.ok, true);
  ckIncludes('summary has port name', r[0].json.summary, 'Mumbai');
  ckIncludes('summary has coordinates', r[0].json.summary, '18.9333');
}

// ── TOOL_COMPLIANCE_PREP ──────────────────────────────────────────────────────
console.log('\n--- TOOL_COMPLIANCE_PREP ---');
{
  const r = runCode(NC.TOOL_COMPLIANCE_PREP, [{ hs_code: '630110', country: 'India' }]);
  ck('hs extracted', r[0].json.hs, '630110');
  ck('country extracted', r[0].json.country, 'India');
}
{
  const r = runCode(NC.TOOL_COMPLIANCE_PREP, [{}]);
  ckTruthy('no args returns error', !!r[0].json._error);
}

// ── summary ───────────────────────────────────────────────────────────────────
console.log('\n' + (fail ? fail + ' FAIL(S)' : 'ALL ' + pass + ' TESTS PASS'));
process.exit(fail ? 1 : 0);
