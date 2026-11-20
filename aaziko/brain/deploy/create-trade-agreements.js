'use strict';
/*
 * Create get_trade_agreements: new sub-workflow + wire to brain.
 *
 * Data source: aaziko_organized.map_trade_agreements_organized (1,290 agreements)
 * Input: country1 (required), optional country2 (find bilateral agreements)
 * Returns: agreement name, type, status, in-force date, member countries.
 *
 * node aaziko/brain/deploy/create-trade-agreements.js         -- dry run
 * node aaziko/brain/deploy/create-trade-agreements.js --write -- apply
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate, req } = require('../../../scripts/lib/n8n-req');

const WRITE      = process.argv.includes('--write');
const BRAIN_ID   = 'w7no6uCJkz7lfaah';
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');
const CRED       = { id: '9hyaSxc0saIzUgsX', name: 'Aaziko Brain - organized (compliance)' };

// Country ISO-2 → member_keys uses "cty:XX" format in this collection
const PREP_CODE = `let inp = {};
try { inp = typeof $input.first().json === "string" ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}

const country1Raw = String(inp.country1 || inp.country || inp.from || "").trim();
const country2Raw = String(inp.country2 || inp.to || inp.partner || "").trim();

if (!country1Raw) {
  return [{ json: { _error: "country1 required (e.g. India, USA, Germany)" } }];
}

const CMAP = {
  'india':'IN','united states':'US','usa':'US','us':'US','america':'US',
  'china':'CN','uk':'GB','united kingdom':'GB','germany':'DE','france':'FR',
  'japan':'JP','south korea':'KR','korea':'KR','australia':'AU',
  'canada':'CA','brazil':'BR','indonesia':'ID','vietnam':'VN',
  'thailand':'TH','malaysia':'MY','singapore':'SG','uae':'AE',
  'united arab emirates':'AE','saudi arabia':'SA','turkey':'TR',
  'russia':'RU','bangladesh':'BD','pakistan':'PK','sri lanka':'LK',
  'mexico':'MX','italy':'IT','spain':'ES','netherlands':'NL',
  'belgium':'BE','switzerland':'CH','sweden':'SE','poland':'PL',
  'hong kong':'HK','taiwan':'TW','philippines':'PH','cambodia':'KH',
  'myanmar':'MM','laos':'LA','nepal':'NP','bhutan':'BT',
  'kenya':'KE','nigeria':'NG','egypt':'EG','ethiopia':'ET',
  'asean':'ASEAN','eu':'EU','european union':'EU'
};

function toISO2(name) {
  if (!name) return null;
  const lo = name.toLowerCase().trim();
  return CMAP[lo] || (lo.length === 2 ? lo.toUpperCase() : null);
}

const iso1 = toISO2(country1Raw);
const iso2 = toISO2(country2Raw);

const unmapped = [];
if (!iso1) unmapped.push(country1Raw);
if (country2Raw && !iso2) unmapped.push(country2Raw);

if (!iso1) {
  return [{ json: { _error: "Country not recognised: " + country1Raw + ". Use English name or ISO-2 code (e.g. IN, US, DE)." } }];
}

// Build match query
// member_keys is array like ["cty:IN", "cty:US", ...]
const andClauses = [{ "structured.member_keys": "cty:" + iso1 }];
if (iso2) andClauses.push({ "structured.member_keys": "cty:" + iso2 });
const matchQ = andClauses.length === 1 ? andClauses[0] : { "$and": andClauses };

const pipeline = JSON.stringify([
  { "$match": matchQ },
  { "$sort": { "structured.in_force_date": -1, "structured.year": -1 } },
  { "$facet": {
    "rows": [{ "$limit": 10 }],
    "total": [{ "$count": "n" }]
  }}
]);

var label = country1Raw;
if (country2Raw) label += " & " + country2Raw;

return [{ json: {
  country1Raw, country2Raw: country2Raw || null,
  iso1, iso2: iso2 || null, label, unmapped, pipeline
} }];`;

const FORMAT_CODE = `const data = $input.first().json;
const prep = $('Agreement Prep').first().json;
const rows = data.rows || [];
const total = data.total && data.total[0] && data.total[0].n || 0;

if (prep._error) return [{ json: { ok: false, summary: prep._error } }];

if (!rows.length) {
  var msg = "No trade agreements found involving " + prep.country1Raw;
  if (prep.country2Raw) msg += " and " + prep.country2Raw;
  msg += ". Countries might not have direct FTAs, or try with ISO-2 code (e.g. IN, US, CN).";
  return [{ json: { ok: false, summary: msg } }];
}

const blocks = rows.map(function(r) {
  const str    = r.structured || {};
  const name   = str.name || r.text && r.text.split('|')[0] || 'Unknown';
  const type   = str.type || '';
  const status = str.status || '';
  const inForce = str.in_force_date || str.status_date || '';
  const signed  = str.signed_date || '';
  const memberCount = str.member_count || (str.members && str.members.length) || 0;
  const members = str.members ? str.members.slice(0, 6).join(', ') + (str.members.length > 6 ? '...' : '') : '';

  var lines = ['• ' + name.trim()];
  if (type) lines.push('  Type: ' + type);
  if (status) lines.push('  Status: ' + status + (inForce ? ' (' + inForce.slice(0, 10) + ')' : ''));
  if (members) lines.push('  Members (' + memberCount + '): ' + members);
  return lines.join('\\n');
}).join('\\n\\n');

const header = 'Trade agreements for ' + prep.label + (total > 10 ? ' (' + total + ' found, showing top 10)' : '') + ':';
return [{ json: { ok: true, summary: header + '\\n\\n' + blocks, rowCount: rows.length } }];`;

// ── Workflow definition ──────────────────────────────────────────────────────

function makeWorkflow() {
  return {
    name: 'Aaziko — get_trade_agreements',
    nodes: [
      {
        id: 'n1', name: 'Execute Workflow Trigger',
        type: 'n8n-nodes-base.executeWorkflowTrigger',
        typeVersion: 1, position: [0, 300], parameters: {}
      },
      {
        id: 'n2', name: 'Agreement Prep',
        type: 'n8n-nodes-base.code',
        typeVersion: 2, position: [200, 300],
        parameters: { jsCode: PREP_CODE }
      },
      {
        id: 'n3', name: 'Gate: Error?',
        type: 'n8n-nodes-base.if',
        typeVersion: 2, position: [420, 300],
        parameters: {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 1 },
            conditions: [{ leftValue: '={{ !!$json._error }}', operator: { type: 'boolean', operation: 'true', singleValue: true }, rightValue: '' }],
            combinator: 'and'
          },
          options: {}
        }
      },
      {
        id: 'n4', name: 'Respond Error',
        type: 'n8n-nodes-base.set',
        typeVersion: 3, position: [640, 180],
        parameters: { mode: 'manual', assignments: { assignments: [{ id: '1', name: 'output', value: "={{ $('Agreement Prep').first().json._error }}", type: 'string' }] } }
      },
      {
        id: 'n5', name: 'Find Agreements',
        type: 'n8n-nodes-base.mongoDb',
        typeVersion: 1.3, position: [640, 420],
        parameters: {
          operation: 'aggregate',
          collection: 'map_trade_agreements_organized',
          databaseName: 'aaziko_organized',
          query: "={{ $('Agreement Prep').first().json.pipeline }}"
        },
        credentials: { mongoDb: CRED }
      },
      {
        id: 'n6', name: 'Format Result',
        type: 'n8n-nodes-base.code',
        typeVersion: 2, position: [860, 300],
        parameters: { jsCode: FORMAT_CODE }
      },
      {
        id: 'n7', name: 'Respond OK',
        type: 'n8n-nodes-base.set',
        typeVersion: 3, position: [1080, 300],
        parameters: { mode: 'manual', assignments: { assignments: [{ id: '1', name: 'output', value: '={{ $json.summary || $json.error }}', type: 'string' }] } }
      }
    ],
    connections: {
      'Execute Workflow Trigger': { main: [[{ node: 'Agreement Prep',  type: 'main', index: 0 }]] },
      'Agreement Prep':           { main: [[{ node: 'Gate: Error?',    type: 'main', index: 0 }]] },
      'Gate: Error?':             { main: [[{ node: 'Respond Error',   type: 'main', index: 0 }], [{ node: 'Find Agreements', type: 'main', index: 0 }]] },
      'Find Agreements':          { main: [[{ node: 'Format Result',   type: 'main', index: 0 }]] },
      'Format Result':            { main: [[{ node: 'Respond OK',      type: 'main', index: 0 }]] }
    },
    settings: { saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all' }
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== Create: get_trade_agreements sub-workflow ===');
  console.log('Data: aaziko_organized.map_trade_agreements_organized (1,290 FTA records)\n');

  const brainWf = await getWf(BRAIN_ID);
  const existingTool = brainWf.nodes.find(n => n.name === 'get_trade_agreements');
  if (existingTool) {
    console.log('⚠️  get_trade_agreements already wired in brain — will update wf + re-wire');
  }

  if (!WRITE) {
    console.log('\nDry run complete — pass --write to create + wire');
    return;
  }

  // Create sub-workflow
  const createRes = await req('POST', '/api/v1/workflows', makeWorkflow());
  if (createRes.status !== 200 && createRes.status !== 201) {
    console.log('❌ Create failed (' + createRes.status + '):', createRes.body.slice(0, 400));
    process.exit(1);
  }
  const newWf = JSON.parse(createRes.body);
  const newId  = newWf.id;
  console.log('✅ Created sub-workflow ID:', newId);

  fs.writeFileSync(path.join(BACKUP_DIR, newId + '_initial_trade-agreements.json'), JSON.stringify(newWf, null, 2), 'utf8');

  await activate(newId);
  console.log('✅ Activated');

  const bkBrain = path.join(BACKUP_DIR, BRAIN_ID + '_before_add-trade-agreements.json');
  fs.writeFileSync(bkBrain, JSON.stringify(brainWf, null, 2), 'utf8');
  console.log('Brain backup:', bkBrain);

  const refTool = brainWf.nodes.find(n => n.name === 'get_compliance') || brainWf.nodes.find(n => n.type === '@n8n/n8n-nodes-langchain.toolWorkflow');

  if (!existingTool) {
    brainWf.nodes.push({
      id: 'ta_' + Date.now(),
      name: 'get_trade_agreements',
      type: '@n8n/n8n-nodes-langchain.toolWorkflow',
      typeVersion: refTool ? refTool.typeVersion : 2,
      position: refTool ? [refTool.position[0] + 40, refTool.position[1] + 100] : [1600, 500],
      parameters: {
        name: 'get_trade_agreements',
        description:
          'Get trade agreements (FTAs, RTAs) that a country is part of. ' +
          'Use country1 (required, e.g. "India", "USA", "Germany") and optionally country2 to find bilateral agreements. ' +
          'Returns agreement name, type (FTA/RTA/customs union), status, in-force date, and member countries. ' +
          'Covers 1,290 agreements from WTO/ITC database.',
        workflowId: { __rl: true, value: newId, mode: 'id' }
      }
    });
  } else {
    existingTool.parameters.workflowId = { __rl: true, value: newId, mode: 'id' };
  }

  const brainSettings = Object.assign({}, brainWf.settings);
  delete brainSettings.binaryMode;

  const r2 = await putWf(BRAIN_ID, { name: brainWf.name, nodes: brainWf.nodes, connections: brainWf.connections, settings: brainSettings });
  if (r2.status !== 200) {
    console.log('❌ Brain PUT failed (' + r2.status + '):', r2.body.slice(0, 300));
    process.exit(1);
  }
  await activate(BRAIN_ID);
  console.log('✅ Brain updated with get_trade_agreements tool');

  // Verify
  const checkBrain = await getWf(BRAIN_ID);
  const liveTool = checkBrain.nodes.find(n => n.name === 'get_trade_agreements');
  if (liveTool) {
    const wid = liveTool.parameters && liveTool.parameters.workflowId && (liveTool.parameters.workflowId.value || liveTool.parameters.workflowId);
    console.log('✅ Brain tool wired: get_trade_agreements → wf', wid);
    console.log('\nSave this ID for future reference:', newId);
    console.log('\n✅ Done! Test: "India aur Vietnam ke beech koi FTA hai?"');
  } else {
    console.log('❌ Tool not found in brain after update');
    process.exit(1);
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
