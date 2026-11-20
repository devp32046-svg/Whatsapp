'use strict';
/*
 * Fix find_port Port Prep: common aliases and suffix stripping.
 *
 * Problems:
 *  - "JNPT" → DB has "Jawaharlal Nehru" → 0 results
 *  - "Jawaharlal Nehru Port" → DB has "Jawaharlal Nehru" (no "Port" suffix) → 0 results
 *
 * Fix:
 *  1. Alias map: JNPT → Jawaharlal Nehru, BOM → Mumbai, etc.
 *  2. Strip common suffixes: " Port", " Terminal", " Harbor", " Harbour"
 *
 * node aaziko/brain/deploy/fix-port-prep-aliases.js          -- dry run
 * node aaziko/brain/deploy/fix-port-prep-aliases.js --write  -- apply
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const WRITE  = process.argv.includes('--write');
const WF_ID  = '7EaCbHmYLnzpaLPn';
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');

const NEW_PREP = `let inp = {};
try { inp = typeof $input.first().json === 'string' ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}

var portName = String(inp.port_name || inp.port || '').trim();
const country = String(inp.country || '').trim();
if (!portName && !country) return [{ json: { _error: 'port_name or country required' } }];

// Known aliases (abbreviations / alternate names)
var ALIASES = {
  'jnpt': 'Jawaharlal Nehru', 'nhava sheva': 'Nhava Sheva',
  'jawaharlal nehru port': 'Jawaharlal Nehru',
  'bombay': 'Mumbai', 'bom': 'Mumbai',
  'madras': 'Chennai', 'calcutta': 'Kolkata', 'kolkata': 'Calcutta',
  'visakhapatnam': 'Visakhapatnam', 'vizag': 'Visakhapatnam',
  'cochin': 'Cochin', 'kochi': 'Cochin',
  'marmagao': 'Marmagoa', 'mormugao': 'Marmagoa'
};

var lo = portName.toLowerCase();
if (ALIASES[lo]) {
  portName = ALIASES[lo];
} else {
  // Strip common suffixes: " Port", " Terminal", " Harbour", " Harbor"
  portName = portName.replace(/\\s+(port|terminal|harbour|harbor)\\s*$/i, '').trim();
}

const filter = {};
if (portName) filter.port_name = { '$regex': portName, '$options': 'i' };
if (country) filter.country_name = { '$regex': country, '$options': 'i' };

const pipeline = JSON.stringify([{"$match": filter}, {"$facet": {"rows": [{"$limit": 10}]}}]);
return [{ json: { portName, country, matchQuery: JSON.stringify(filter), pipeline } }];`;

(async () => {
  console.log('=== Fix: find_port Port Prep aliases + suffix strip ===');
  console.log('Problem: "JNPT" and "Jawaharlal Nehru Port" return 0 (DB: "Jawaharlal Nehru")');
  console.log('Fix: alias map + strip Port/Terminal suffix\n');

  const wf = await getWf(WF_ID);
  const prep = wf.nodes.find(n => n.name === 'Port Prep');
  if (!prep) { console.log('❌ Port Prep not found'); process.exit(1); }

  console.log('Current code has JNPT alias:', prep.parameters.jsCode.includes('JNPT') ? 'YES' : 'NO (needs fix)');

  if (!WRITE) { console.log('\n(dry run — pass --write to apply)'); return; }

  const bk = path.join(BACKUP_DIR, WF_ID + '_before_port-aliases.json');
  fs.writeFileSync(bk, JSON.stringify(wf, null, 2), 'utf8');
  console.log('Backup:', bk);

  prep.parameters.jsCode = NEW_PREP;

  const settings = Object.assign({}, wf.settings);
  delete settings.binaryMode;

  const r = await putWf(WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) {
    console.log('❌ PUT failed (' + r.status + '):', JSON.stringify(r.body).slice(0, 300));
    process.exit(1);
  }
  await activate(WF_ID);

  const check = await getWf(WF_ID);
  const live = check.nodes.find(n => n.name === 'Port Prep');
  const c1 = live.parameters.jsCode.includes('JNPT');
  const c2 = live.parameters.jsCode.includes('suffix');
  console.log(c1 ? '✅ JNPT alias present' : '❌ JNPT alias missing');
  console.log(c2 ? '✅ suffix strip present' : '❌ suffix strip missing');
  if (c1 && c2) console.log('\n✅ Fix live! "JNPT" and "Jawaharlal Nehru Port" will now resolve correctly.');
  else process.exit(1);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
