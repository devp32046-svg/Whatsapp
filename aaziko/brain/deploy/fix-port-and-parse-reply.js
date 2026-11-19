'use strict';
/*
 * Fix 1: Parse Reply (brain wf w7no6uCJkz7lfaah) — strip "Calling Tool_xxx..." lines
 *        that the AI model leaks into final output text.
 *
 * Fix 2: Port Format Result (find_port wf 7EaCbHmYLnzpaLPn) — scraper collected
 *        port_name, country_name, port_url only. Old formatter referenced
 *        r.coordinates.decimal and r.communication_channels (both absent) → empty output.
 *        New: show port name + country + Searates URL clearly.
 *
 * Also: update find_port tool description to match actual data ("Searates link" not "facilities").
 *
 * node aaziko/brain/deploy/fix-port-and-parse-reply.js          -- dry run
 * node aaziko/brain/deploy/fix-port-and-parse-reply.js --write  -- apply
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const WRITE      = process.argv.includes('--write');
const BRAIN_ID   = 'w7no6uCJkz7lfaah';
const PORT_WF_ID = '7EaCbHmYLnzpaLPn';
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');

// ── Fix 1: new Parse Reply code ────────────────────────────────────────────
const NEW_PARSE_REPLY = `const out = $input.first().json;
let text = String(out.output || out.text || out.replyText || '').trim();

// Strip AI tool-call traces that sometimes leak into the output text
// e.g. "Calling Tool_get_compliance with input: {...}"
text = text.replace(/^Calling Tool_\\S+.*$/gm, '').trim();
text = text.replace(/^Using tool.*$/gm, '').trim();

// Clean markdown -> plain text (WhatsApp/UI safe)
text = text
  .replace(/\\*\\*\\*([^*\\n]+?)\\*\\*\\*/g, '*$1*')
  .replace(/\\*\\*([^*\\n]+?)\\*\\*/g, '*$1*')
  .replace(/#\\{1,6\\}\\s+/g, '')
  .replace(/\\n{3,}/g, '\\n\\n')
  .trim();

const prevChannel = ($('Normalize Message').first() || { json: {} }).json.channel || 'ui';
return [{ json: { replyText: text, channel: prevChannel } }];`;

// ── Fix 2: new Port Format Result code ────────────────────────────────────
const NEW_PORT_FORMAT = `const data = $input.first().json;
const prep = $('Port Prep').first().json;
const rows = data.rows || [];
if (prep._error) return [{ json: { ok: false, error: prep._error } }];
if (!rows.length) return [{ json: { ok: false, error: 'No ports found for: ' + (prep.portName || prep.country) } }];

const lines = rows.slice(0, 5).map(function(r) {
  var line = '\\u2022 *' + r.port_name + '*, ' + r.country_name + ' (' + (r.country_code || '') + ')';
  if (r.port_url) line += '\\n  Details: ' + r.port_url;
  return line;
});
const summary = 'Ports matching "' + (prep.portName || prep.country) + '":\\n' + lines.join('\\n');
return [{ json: { ok: true, summary, rowCount: rows.length } }];`;

// ── Fix 3: updated tool description for find_port ─────────────────────────
const NEW_PORT_DESC = [
  'Find port information by port name or country.',
  'Returns port name, country, and a direct Searates link for full details (coordinates, facilities, shipping routes).',
  'Call for: "Mumbai port kahan hai", "India ke ports dikhao", "Shanghai port", "find ports in Germany".',
].join(' ');

(async () => {
  // ── BRAIN: Parse Reply ───────────────────────────────────────────────────
  const brain = await getWf(BRAIN_ID);
  const parseReply = brain.nodes.find(n => n.name === 'Parse Reply');
  if (!parseReply) { console.log('Parse Reply node not found in brain!'); process.exit(1); }

  const oldParseCode = parseReply.parameters.jsCode;
  console.log('=== Fix 1: Parse Reply (brain) ===');
  console.log('Old (strip section):', oldParseCode.includes('Calling Tool') ? 'ALREADY HAS strip' : 'no strip — needs fix');
  console.log('New: adds strip for "Calling Tool_xxx..." lines\n');

  // Also find the port tool node for description update
  const portToolNode = brain.nodes.find(n => n.name === 'Tool: find_port');
  const oldPortDesc = portToolNode && portToolNode.parameters.description;
  console.log('=== Fix 3: find_port tool description ===');
  console.log('Old:', oldPortDesc);
  console.log('New:', NEW_PORT_DESC, '\n');

  // ── PORT WF: Format Result ───────────────────────────────────────────────
  const portWf = await getWf(PORT_WF_ID);
  const portFmt = portWf.nodes.find(n => n.name === 'Format Result');
  if (!portFmt) { console.log('Format Result not found in port wf!'); process.exit(1); }

  console.log('=== Fix 2: Port Format Result ===');
  console.log('Old references r.coordinates.decimal + r.communication_channels (both absent in DB)');
  console.log('New: shows port_name, country_name, country_code, port_url\n');

  if (!WRITE) { console.log('(dry run — pass --write to apply)'); return; }

  // Apply Fix 1 + Fix 3 to brain
  parseReply.parameters.jsCode = NEW_PARSE_REPLY;
  if (portToolNode) portToolNode.parameters.description = NEW_PORT_DESC;

  const brainBk = path.join(BACKUP_DIR, BRAIN_ID + '_before_parse-reply-port-desc.json');
  fs.writeFileSync(brainBk, JSON.stringify(brain, null, 2), 'utf8');

  const brainSettings = Object.assign({}, brain.settings);
  delete brainSettings.binaryMode;

  const r1 = await putWf(BRAIN_ID, { name: brain.name, nodes: brain.nodes, connections: brain.connections, settings: brainSettings });
  if (r1.status === 200) {
    await activate(BRAIN_ID);
    const checkBrain = await getWf(BRAIN_ID);
    const livePR = checkBrain.nodes.find(n => n.name === 'Parse Reply');
    const liveDesc = checkBrain.nodes.find(n => n.name === 'Tool: find_port');
    console.log(livePR.parameters.jsCode.includes('Calling Tool') ? '✅ Parse Reply — strip added' : '❌ Parse Reply verify FAILED');
    console.log(liveDesc && liveDesc.parameters.description === NEW_PORT_DESC ? '✅ find_port description — updated' : '❌ find_port desc verify FAILED');
  } else {
    console.log('❌ Brain PUT failed (' + r1.status + '):', JSON.stringify(r1.body).slice(0, 200));
    process.exit(1);
  }

  // Apply Fix 2 to port wf
  portFmt.parameters.jsCode = NEW_PORT_FORMAT;

  const portBk = path.join(BACKUP_DIR, PORT_WF_ID + '_before_format-result-fix.json');
  fs.writeFileSync(portBk, JSON.stringify(portWf, null, 2), 'utf8');

  const portSettings = Object.assign({}, portWf.settings);
  delete portSettings.binaryMode;

  const r2 = await putWf(PORT_WF_ID, { name: portWf.name, nodes: portWf.nodes, connections: portWf.connections, settings: portSettings });
  if (r2.status === 200) {
    await activate(PORT_WF_ID);
    const checkPort = await getWf(PORT_WF_ID);
    const liveFmt = checkPort.nodes.find(n => n.name === 'Format Result');
    console.log(liveFmt.parameters.jsCode.includes('port_url') ? '✅ Port Format Result — URL-based format live' : '❌ Port Format verify FAILED');
  } else {
    console.log('❌ Port wf PUT failed (' + r2.status + '):', JSON.stringify(r2.body).slice(0, 200));
    process.exit(1);
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
