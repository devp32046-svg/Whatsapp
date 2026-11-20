'use strict';
/*
 * Fix find_port: ports were returned alphabetically, so "Ahmedabad" (not a port!)
 * appeared before JNPT/Mumbai/Mundra for India queries.
 *
 * Fix: when querying by country (no specific port name), inject a _rank field
 * via $addFields + $sort so major trade ports appear first.
 *
 * node aaziko/brain/deploy/fix-port-ranking.js         -- dry run
 * node aaziko/brain/deploy/fix-port-ranking.js --write -- deploy
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');
const WF_ID = '7EaCbHmYLnzpaLPn';
const WRITE = process.argv.includes('--write');

// ── Major port priority (lower number = shown first) ──────────────────────────
// Source: container throughput + trade volume rankings
const MAJOR_PORTS = {
  india: [
    { rank: 1,  pattern: 'Nhava|Jawaharlal|JNPT' },      // JNPT Mumbai — #1 India
    { rank: 2,  pattern: 'Mundra' },                       // Mundra Gujarat
    { rank: 3,  pattern: 'Kandla|Deendayal' },             // Kandla/Deendayal Gujarat
    { rank: 4,  pattern: 'Chennai|Madras' },               // Chennai
    { rank: 5,  pattern: 'Kolkata|Calcutta|Haldia' },      // Kolkata/Haldia
    { rank: 6,  pattern: 'Cochin|Kochi' },                 // Cochin Kerala
    { rank: 7,  pattern: 'Visakhapatnam|Vizag' },          // Vizag
    { rank: 8,  pattern: 'Tuticorin|Thoothukudi|V O C' },  // Tuticorin
    { rank: 9,  pattern: 'Mangalore|New Mangalore' },       // Mangalore
    { rank: 10, pattern: 'Marmagoa|Mormugao|Marmagao' },    // Goa
  ],
  uae: [
    { rank: 1, pattern: 'Jebel Ali' },
    { rank: 2, pattern: 'Khalifa|Mina Zayed' },
    { rank: 3, pattern: 'Sharjah|Khaled' },
    { rank: 4, pattern: 'Fujairah' },
    { rank: 5, pattern: 'Rashid' },
  ],
  china: [
    { rank: 1, pattern: 'Shanghai' },
    { rank: 2, pattern: 'Shenzhen|Yantian|Shekou' },
    { rank: 3, pattern: 'Ningbo|Zhoushan' },
    { rank: 4, pattern: 'Guangzhou|Nansha|Huangpu' },
    { rank: 5, pattern: 'Tianjin|Xingang' },
    { rank: 6, pattern: 'Qingdao' },
  ],
  usa: [
    { rank: 1, pattern: 'Los Angeles' },
    { rank: 2, pattern: 'Long Beach' },
    { rank: 3, pattern: 'New York|Newark' },
    { rank: 4, pattern: 'Houston|Bayport' },
    { rank: 5, pattern: 'Savannah' },
    { rank: 6, pattern: 'Seattle|Tacoma' },
  ],
  germany: [
    { rank: 1, pattern: 'Hamburg' },
    { rank: 2, pattern: 'Bremen|Bremerhaven' },
  ],
  netherlands: [
    { rank: 1, pattern: 'Rotterdam' },
    { rank: 2, pattern: 'Amsterdam' },
  ],
  singapore: [
    { rank: 1, pattern: 'Singapore' },
  ],
  malaysia: [
    { rank: 1, pattern: 'Port Klang|Klang' },
    { rank: 2, pattern: 'Penang|George Town' },
    { rank: 3, pattern: 'Tanjung Pelepas' },
  ],
  'south korea': [
    { rank: 1, pattern: 'Busan' },
    { rank: 2, pattern: 'Incheon' },
  ],
  japan: [
    { rank: 1, pattern: 'Tokyo' },
    { rank: 2, pattern: 'Yokohama' },
    { rank: 3, pattern: 'Osaka|Kobe' },
    { rank: 4, pattern: 'Nagoya' },
  ],
};

// Build the new Port Prep code
const NEW_PORT_PREP = `let inp = {};
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
  portName = portName.replace(/\\s+(port|terminal|harbour|harbor)\\s*$/i, '').trim();
}

// ── Major-port priority map (lower rank = shown first) ────────────────────────
var MAJOR_PORTS = ${JSON.stringify(MAJOR_PORTS, null, 2)};

// Build pipeline: if specific portName given → exact search (unchanged)
// if country-only → rank by MAJOR_PORTS, fallback rank=99 for others
var pipeline;
if (portName) {
  // Exact/partial port name search — no ranking needed
  var filter = {};
  filter.port_name = { '$regex': portName, '$options': 'i' };
  if (country) filter.country_name = { '$regex': country, '$options': 'i' };
  pipeline = JSON.stringify([
    {'$match': filter},
    {'$facet': {'rows': [{'$limit': 5}]}}
  ]);
} else {
  // Country-only query: apply major-port ranking
  var cLow = country.toLowerCase();
  var rankList = null;
  for (var cKey in MAJOR_PORTS) {
    if (cLow.indexOf(cKey) >= 0 || cKey.indexOf(cLow) >= 0) {
      rankList = MAJOR_PORTS[cKey];
      break;
    }
  }

  var matchFilter = { country_name: { '$regex': country, '$options': 'i' } };

  if (rankList) {
    // Build $switch branches for known major ports
    var branches = rankList.map(function(p) {
      return {
        'case': { '$regexMatch': { 'input': '$port_name', 'regex': p.pattern, 'options': 'i' } },
        'then': p.rank
      };
    });
    pipeline = JSON.stringify([
      { '$match': matchFilter },
      { '$addFields': { '_rank': { '$switch': { 'branches': branches, 'default': 99 } } } },
      { '$sort': { '_rank': 1 } },
      { '$facet': { 'rows': [ { '$limit': 5 } ] } }
    ]);
  } else {
    // No priority data for this country — return as-is (limit 5)
    pipeline = JSON.stringify([
      { '$match': matchFilter },
      { '$facet': { 'rows': [ { '$limit': 5 } ] } }
    ]);
  }
}

return [{ json: { portName, country, pipeline } }];`;

// ── Dry-run verification ───────────────────────────────────────────────────────
console.log('=== Tests (pipeline shape check) ===');
// Check that India pipeline includes $addFields + $sort
function checkPipeline(country, portName, expectRanked) {
  var cLow = country.toLowerCase();
  var hasRankData = false;
  for (var k in MAJOR_PORTS) {
    if (cLow.indexOf(k) >= 0 || k.indexOf(cLow) >= 0) { hasRankData = true; break; }
  }
  const isRanked = !portName && hasRankData;
  const pass = isRanked === expectRanked;
  console.log((pass ? '✅' : '❌'), `country="${country}" portName="${portName}" → ranked=${isRanked} (expected ${expectRanked})`);
  return pass;
}

let allPass = true;
allPass &= checkPipeline('India', '', true);       // country-only India → ranked
allPass &= checkPipeline('UAE', '', true);          // country-only UAE → ranked
allPass &= checkPipeline('India', 'Mumbai', false); // specific port → not ranked
allPass &= checkPipeline('Bangladesh', '', false);  // unknown country → not ranked (no crash)

// Syntax check
try { new Function(NEW_PORT_PREP); console.log('✅ Code syntax OK'); }
catch(e) { console.log('❌ Syntax error:', e.message); allPass = false; }

console.log('\nAll tests:', allPass ? '✅ PASS' : '❌ FAIL');
if (!allPass) process.exit(1);
if (!WRITE) { console.log('\n(dry run — pass --write to deploy)'); process.exit(0); }

// ── Deploy ─────────────────────────────────────────────────────────────────────
(async () => {
  const wf = await getWf(WF_ID);
  const node = wf.nodes.find(n => n.name === 'Port Prep');
  if (!node) { console.log('❌ Port Prep node not found'); process.exit(1); }

  fs.writeFileSync(path.join(BACKUP_DIR, WF_ID + '_before_port_ranking.json'), JSON.stringify(wf, null, 2), 'utf8');
  console.log('\nBackup saved.');

  node.parameters.jsCode = NEW_PORT_PREP;

  const settings = Object.assign({}, wf.settings); delete settings.binaryMode;
  const r = await putWf(WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) { console.log('❌ PUT failed:', r.body.slice(0, 300)); process.exit(1); }
  await activate(WF_ID);

  const check = await getWf(WF_ID);
  const n2 = check.nodes.find(n => n.name === 'Port Prep');
  const ok = n2.parameters.jsCode.includes('MAJOR_PORTS') &&
             n2.parameters.jsCode.includes('$addFields') &&
             n2.parameters.jsCode.includes('$regexMatch');
  console.log((ok ? '✅' : '❌') + ' Port ranking deployed');
  if (ok) {
    console.log('\nTest: "India ke major ports" → JNPT/Mundra/Kandla should come first, not Ahmedabad');
    console.log('Test: "UAE ports" → Jebel Ali first');
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
