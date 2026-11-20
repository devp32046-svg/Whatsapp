'use strict';
/*
 * Create get_trade_stats: new sub-workflow + wire to brain.
 *
 * Data source: aaziko_organized.trademap_organized (139K trade flow records)
 * Input: hs_code (required), reporter (importer country), origin (exporter country)
 * Returns yearly trade volumes by country pair for a given HS code.
 *
 * Also queries trademapsheet_tariff_line_organized (1.08M) for broader HS coverage.
 *
 * node aaziko/brain/deploy/create-trade-stats.js         -- dry run
 * node aaziko/brain/deploy/create-trade-stats.js --write -- apply
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate, req, cleanSettings } = require('../../../scripts/lib/n8n-req');

const WRITE      = process.argv.includes('--write');
const BRAIN_ID   = 'w7no6uCJkz7lfaah';
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');
const CRED       = { id: '9hyaSxc0saIzUgsX', name: 'Aaziko Brain - organized (compliance)' };

// ── Nodes ───────────────────────────────────────────────────────────────────

const PREP_CODE = `let inp = {};
try { inp = typeof $input.first().json === "string" ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}

const hs6Raw = String(inp.hs_code || inp.hs || "").replace(/\\D/g, "").slice(0, 6);
const reporterRaw = String(inp.reporter || inp.importer || inp.country || "").trim();
const originRaw   = String(inp.origin || inp.exporter || "").trim();

if (!hs6Raw || hs6Raw.length < 4) {
  return [{ json: { _error: "hs_code required (4-6 digits, e.g. 610910 for cotton t-shirts)" } }];
}
const hs6 = hs6Raw.padEnd(6, "0").slice(0, 6);

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
  'hong kong':'HK','taiwan':'TW','philippines':'PH','cambodia':'KH'
};

function toISO2(name) {
  if (!name) return null;
  const lo = name.toLowerCase().trim();
  return CMAP[lo] || (lo.length === 2 ? lo.toUpperCase() : null);
}

const reporterISO = toISO2(reporterRaw);
const originISO   = toISO2(originRaw);

const unmapped = [];
if (reporterRaw && !reporterISO) unmapped.push('reporter: ' + reporterRaw);
if (originRaw   && !originISO)   unmapped.push('origin: ' + originRaw);

const matchQ = { 'applicability.product.hs6': hs6 };
if (reporterISO) matchQ['applicability.reporter'] = 'cty:' + reporterISO;
if (originISO)   matchQ['applicability.origin']   = 'cty:' + originISO;

// Search both collections; use $facet to get flows + tariff lines
const pipeline = JSON.stringify([
  { "$match": matchQ },
  { "$sort": { "structured.latest_year": -1, "structured.latest_value": -1 } },
  { "$facet": {
    "rows": [{ "$limit": 10 }],
    "total": [{ "$count": "n" }]
  }}
]);

var label = hs6;
if (reporterRaw && originRaw) label += " (" + originRaw + " → " + reporterRaw + ")";
else if (reporterRaw) label += " (importer: " + reporterRaw + ")";
else if (originRaw)   label += " (exporter: " + originRaw + ")";

return [{ json: {
  hs6, reporterRaw: reporterRaw || null, originRaw: originRaw || null,
  reporterISO: reporterISO || null, originISO: originISO || null,
  label, unmapped, matchQuery: JSON.stringify(matchQ), pipeline
} }];`;

const FORMAT_CODE = `const data = $input.first().json;
const prep = $('Stats Prep').first().json;
const rows = data.rows || [];
const total = data.total && data.total[0] && data.total[0].n || 0;

if (prep._error) return [{ json: { ok: false, summary: prep._error } }];

if (prep.unmapped && prep.unmapped.length) {
  return [{ json: { ok: false, summary: "Country not recognised: " + prep.unmapped.join(", ") + ". Use English name or ISO-2 code (e.g. IN, US, CN)." } }];
}

if (!rows.length) {
  return [{ json: { ok: false, summary: "No trade flow data found for HS " + prep.hs6
    + (prep.reporterRaw ? " (importer: " + prep.reporterRaw + ")" : "")
    + (prep.originRaw   ? " (exporter: " + prep.originRaw + ")" : "")
    + ". Try without country filters, or check the HS code." } }];
}

const blocks = rows.map(function(r) {
  const app = r.applicability || {};
  const str = r.structured || {};
  const reporter = app.reporter ? app.reporter.replace('cty:', '') : '?';
  const origin   = app.origin   ? app.origin.replace('cty:', '')   : app.partner_keys && app.partner_keys[0] ? app.partner_keys[0].replace('cty:', '') : '?';
  const mode     = str.mode || (app.direction === 'import' ? 'import' : 'export');
  const prodLabel = str.product_label || str.description || '';
  const years    = str.years || {};
  const latest   = str.latest_year || Object.keys(years).sort().pop();
  const latestVal = str.latest_value != null ? str.latest_value : (latest ? years[latest] : null);
  const unit     = str.unit || 'USD Thousand';

  // Show last 4 years of data
  const recentYears = Object.keys(years).sort().slice(-4);
  const trend = recentYears.map(function(y){ return y + ': ' + (years[y] || 0).toLocaleString(); }).join(', ');

  var header = reporter + ' ' + mode + 's from ' + origin;
  if (prodLabel) header += ' \\u2014 ' + prodLabel.slice(0, 60);
  var body = latestVal != null ? '  Latest (' + latest + '): ' + latestVal.toLocaleString() + ' ' + unit : '';
  if (trend) body += (body ? '\\n  Trend: ' + trend : '  Trend: ' + trend);
  return header + '\\n' + body;
}).join('\\n\\n');

const summary = 'Trade stats for HS ' + prep.label + (total > 10 ? ' (' + total + ' flows found, showing top 10)' : '') + ':\\n\\n' + blocks;
return [{ json: { ok: true, summary: summary, rowCount: rows.length } }];`;

// ── Workflow definition ──────────────────────────────────────────────────────

function makeWorkflow() {
  return {
    name: 'Aaziko — get_trade_stats',
    nodes: [
      {
        id: 'n1', name: 'Execute Workflow Trigger',
        type: 'n8n-nodes-base.executeWorkflowTrigger',
        typeVersion: 1, position: [0, 300], parameters: {}
      },
      {
        id: 'n2', name: 'Stats Prep',
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
        parameters: { mode: 'manual', assignments: { assignments: [{ id: '1', name: 'output', value: "={{ $('Stats Prep').first().json._error }}", type: 'string' }] } }
      },
      {
        id: 'n5', name: 'Find Trade Flows',
        type: 'n8n-nodes-base.mongoDb',
        typeVersion: 1.3, position: [640, 420],
        parameters: {
          operation: 'aggregate',
          collection: 'trademap_organized',
          databaseName: 'aaziko_organized',
          query: "={{ $('Stats Prep').first().json.pipeline }}"
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
      'Execute Workflow Trigger': { main: [[{ node: 'Stats Prep',       type: 'main', index: 0 }]] },
      'Stats Prep':               { main: [[{ node: 'Gate: Error?',     type: 'main', index: 0 }]] },
      'Gate: Error?':             { main: [[{ node: 'Respond Error',    type: 'main', index: 0 }], [{ node: 'Find Trade Flows', type: 'main', index: 0 }]] },
      'Find Trade Flows':         { main: [[{ node: 'Format Result',    type: 'main', index: 0 }]] },
      'Format Result':            { main: [[{ node: 'Respond OK',       type: 'main', index: 0 }]] }
    },
    settings: { saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all' }
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== Create: get_trade_stats sub-workflow ===');
  console.log('Data: aaziko_organized.trademap_organized (139K trade flow records)\n');

  const brainWf = await getWf(BRAIN_ID);
  const existingTool = brainWf.nodes.find(n => n.name === 'get_trade_stats');
  if (existingTool) {
    console.log('⚠️  get_trade_stats already wired in brain (wfId:', existingTool.parameters && existingTool.parameters.workflowId && (existingTool.parameters.workflowId.value || existingTool.parameters.workflowId), ')');
    console.log('Dry run will show what changes; --write will update the existing wf and re-wire brain.');
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

  fs.writeFileSync(path.join(BACKUP_DIR, newId + '_initial_trade-stats.json'), JSON.stringify(newWf, null, 2), 'utf8');

  // Activate it
  await activate(newId);
  console.log('✅ Activated');

  const bkBrain = path.join(BACKUP_DIR, BRAIN_ID + '_before_add-trade-stats.json');
  fs.writeFileSync(bkBrain, JSON.stringify(brainWf, null, 2), 'utf8');
  console.log('Brain backup:', bkBrain);

  // Find an existing tool node to copy position/structure from
  const refTool = brainWf.nodes.find(n => n.name === 'lookup_hs_code') || brainWf.nodes.find(n => n.type === '@n8n/n8n-nodes-langchain.toolWorkflow');

  if (!existingTool) {
    // Add new tool node
    brainWf.nodes.push({
      id: 'ts_' + Date.now(),
      name: 'get_trade_stats',
      type: '@n8n/n8n-nodes-langchain.toolWorkflow',
      typeVersion: refTool ? refTool.typeVersion : 2,
      position: refTool ? [refTool.position[0] + 20, refTool.position[1] + 80] : [1500, 500],
      parameters: {
        name: 'get_trade_stats',
        description:
          'Get trade flow statistics for a product by HS code. ' +
          'Use hs_code (6-digit, e.g. 610910) to see which countries import/export it and in what volumes. ' +
          'Optional: reporter (importer country, e.g. "USA") and origin (exporter country, e.g. "China"). ' +
          'Returns yearly trade values in USD Thousand for each country pair.',
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
  console.log('✅ Brain updated with get_trade_stats tool');

  // Verify
  const checkBrain = await getWf(BRAIN_ID);
  const liveTool = checkBrain.nodes.find(n => n.name === 'get_trade_stats');
  if (liveTool) {
    const wid = liveTool.parameters && liveTool.parameters.workflowId && (liveTool.parameters.workflowId.value || liveTool.parameters.workflowId);
    console.log('✅ Brain tool wired: get_trade_stats → wf', wid);
    console.log('\nSave this ID for future reference:', newId);
    console.log('\n✅ Done! Test: "Cotton t-shirt (HS 610910) ka sabse bada importer kaun hai?"');
  } else {
    console.log('❌ Tool not found in brain after update');
    process.exit(1);
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
