'use strict';
/*
 * Fix port Format Result + tool description using real doc schema discovered from execution.
 *
 * Rich port doc (e.g. Mumbai) has: coordinates.decimal, general_info.un_locode,
 * lifts_cranes (fixed/mobile/floating), supplies (fuel/water/provisions), pilotage,
 * nearby_ports[], url (Searates).
 * Sparse doc (small ports) has: port_name, country_name, country_code, port_url.
 *
 * Also update find_port tool description to list specific facts (UN LOCODE, cranes,
 * supplies) so brain stops answering from memory and always calls the tool.
 *
 * node aaziko/brain/deploy/fix-port-rich-format.js          -- dry run
 * node aaziko/brain/deploy/fix-port-rich-format.js --write  -- apply
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const WRITE      = process.argv.includes('--write');
const BRAIN_ID   = 'w7no6uCJkz7lfaah';
const PORT_WF_ID = '7EaCbHmYLnzpaLPn';
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');

// ── New Port Format Result ───────────────────────────────────────────────────
const NEW_PORT_FORMAT = `const data = $input.first().json;
const prep = $('Port Prep').first().json;
const rows = data.rows || [];
if (prep._error) return [{ json: { ok: false, error: prep._error } }];
if (!rows.length) return [{ json: { ok: false, error: 'No ports found for: ' + (prep.portName || prep.country) } }];

function avail(obj) {
  if (!obj) return [];
  return Object.entries(obj)
    .filter(function(e) { return e[1] === 'available'; })
    .map(function(e) { return e[0].replace(/_/g,' '); });
}

const lines = rows.slice(0, 3).map(function(r) {
  var parts = ['\\u2022 *' + r.port_name + '*, ' + r.country_name];

  var coords = r.coordinates && r.coordinates.decimal;
  if (coords) parts.push('  Coordinates: ' + coords);

  var locode = r.general_info && r.general_info.un_locode;
  if (locode && locode !== 'not_available') parts.push('  UN LOCODE: ' + locode);

  var cranes = avail(r.lifts_cranes);
  if (cranes.length) parts.push('  Cranes: ' + cranes.slice(0,3).join(', '));

  var supply = avail(r.supplies);
  if (supply.length) parts.push('  Supplies: ' + supply.join(', '));

  var pilotage = r.pilotage && r.pilotage.compulsory === 'available' ? 'compulsory' :
                 r.pilotage && r.pilotage.available === 'available' ? 'available' : null;
  if (pilotage) parts.push('  Pilotage: ' + pilotage);

  var nearby = r.nearby_ports && r.nearby_ports.slice(0,3).map(function(p){return p.name;}).join(', ');
  if (nearby) parts.push('  Nearby: ' + nearby);

  var link = r.url || r.port_url;
  if (link) parts.push('  Details: ' + link);

  return parts.join('\\n');
});

const summary = 'Port info for "' + (prep.portName || prep.country) + '":\\n' + lines.join('\\n\\n');
return [{ json: { ok: true, summary, rowCount: rows.length } }];`;

// ── Updated find_port tool description ──────────────────────────────────────
const NEW_PORT_DESC = [
  'Find port details by port name or country.',
  'Returns UN LOCODE, GPS coordinates, crane availability (fixed/mobile/floating),',
  'fuel & water supplies, pilotage status, nearby ports, and Searates URL.',
  'ALWAYS call this tool for port queries — this data is not in your training.',
  'Call for: "Mumbai port ki facilities kya hain?", "India ke major ports",',
  '"Shanghai port", "ports in Germany", "JNPT port details".',
].join(' ');

(async () => {
  console.log('=== Fix: Port Format Result (port wf) ===');
  console.log('Shows: coordinates, UN LOCODE, cranes, supplies, pilotage, nearby ports, URL\n');
  console.log('=== Fix: find_port description (brain) ===');
  console.log('New:', NEW_PORT_DESC, '\n');

  if (!WRITE) { console.log('(dry run — pass --write to apply)'); return; }

  // 1. Update port wf Format Result
  const portWf = await getWf(PORT_WF_ID);
  const portFmt = portWf.nodes.find(n => n.name === 'Format Result');
  portFmt.parameters.jsCode = NEW_PORT_FORMAT;

  const portBk = path.join(BACKUP_DIR, PORT_WF_ID + '_before_rich-format.json');
  fs.writeFileSync(portBk, JSON.stringify(portWf, null, 2), 'utf8');

  const portSettings = Object.assign({}, portWf.settings);
  delete portSettings.binaryMode;

  const r1 = await putWf(PORT_WF_ID, { name: portWf.name, nodes: portWf.nodes, connections: portWf.connections, settings: portSettings });
  if (r1.status === 200) {
    await activate(PORT_WF_ID);
    const checkPort = await getWf(PORT_WF_ID);
    const liveFmt = checkPort.nodes.find(n => n.name === 'Format Result');
    console.log(liveFmt.parameters.jsCode.includes('un_locode') ? '✅ Port Format Result — rich format live' : '❌ VERIFY FAILED');
  } else {
    console.log('❌ Port wf PUT failed (' + r1.status + '):', JSON.stringify(r1.body).slice(0, 150));
    process.exit(1);
  }

  // 2. Update brain: find_port tool description
  const brain = await getWf(BRAIN_ID);
  const portTool = brain.nodes.find(n => n.name === 'Tool: find_port');
  portTool.parameters.description = NEW_PORT_DESC;

  const brainBk = path.join(BACKUP_DIR, BRAIN_ID + '_before_port-desc-v2.json');
  fs.writeFileSync(brainBk, JSON.stringify(brain, null, 2), 'utf8');

  const brainSettings = Object.assign({}, brain.settings);
  delete brainSettings.binaryMode;

  const r2 = await putWf(BRAIN_ID, { name: brain.name, nodes: brain.nodes, connections: brain.connections, settings: brainSettings });
  if (r2.status === 200) {
    await activate(BRAIN_ID);
    const checkBrain = await getWf(BRAIN_ID);
    const liveDesc = checkBrain.nodes.find(n => n.name === 'Tool: find_port');
    console.log(liveDesc.parameters.description.includes('ALWAYS call') ? '✅ find_port description — ALWAYS call added' : '❌ VERIFY FAILED');
  } else {
    console.log('❌ Brain PUT failed (' + r2.status + '):', JSON.stringify(r2.body).slice(0, 150));
    process.exit(1);
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
