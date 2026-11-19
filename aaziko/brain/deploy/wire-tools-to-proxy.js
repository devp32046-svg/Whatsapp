'use strict';
/*
 * Wire all 6 Aaziko tool sub-workflows to use the HTTP proxy instead of mongoDb.
 * Replaces each mongoDb node with an httpRequest node calling:
 *   POST https://ai.cgpe.in/api/aaziko/query
 *   Header: x-aaziko-secret: <AAZIKO_PROXY_SECRET>
 *
 * PREREQUISITE: server.js must be restarted after adding .env keys:
 *   AAZIKO_TRADE_DB_URI=mongodb://admin:...@100.70.212.45:27017/?authSource=admin&directConnection=true
 *   AAZIKO_PROXY_SECRET=aazikoProxy2026
 *
 * node aaziko/brain/deploy/wire-tools-to-proxy.js          -- dry run
 * node aaziko/brain/deploy/wire-tools-to-proxy.js --write  -- apply
 */
const path = require('path'), fs = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const SEC_DIR = path.resolve(__dirname, '..', '..', '.secrets');
const ids = JSON.parse(fs.readFileSync(path.join(SEC_DIR, 'brain-n8n.json'), 'utf8'));
const WRITE = process.argv.includes('--write');
const BACKUP_DIR = path.resolve(__dirname, '..', '..', '..', 'backups');

// host.docker.internal resolves to the Windows/Mac host machine from inside Docker — no config needed
// Aaziko proxy runs on its OWN port (4001) — completely separate from CGPE server.js (3000)
const PROXY_URL    = 'https://loose-poems-end.loca.lt/query';
const PROXY_SECRET = 'aazikoProxy2026'; // must match AAZIKO_PROXY_SECRET in .env

// Tool configs — each defines which DB/collection to query
const TOOLS = [
  {
    wfId: ids.tariffWfId, label: 'search_tariff',
    prepNode: 'Tariff Prep',
    db: 'wits', collection: 'tariff_trains', limit: 10,
    filterExpr: "={{ JSON.parse($('Tariff Prep').first().json.matchQuery) }}"
  },
  {
    wfId: ids.productWfId, label: 'search_products',
    prepNode: 'Product Prep',
    db: 'indiamart', collection: 'products', limit: 5,
    filterExpr: "={{ JSON.parse($('Product Prep').first().json.matchQuery) }}"
  },
  {
    wfId: ids.portWfId, label: 'find_port',
    prepNode: 'Port Prep',
    db: 'searates-scraper', collection: 'detailed_ports', limit: 5,
    filterExpr: "={{ JSON.parse($('Port Prep').first().json.matchQuery) }}"
  },
  {
    wfId: ids.complianceWfId, label: 'get_compliance',
    prepNode: 'Compliance Prep',
    db: 'aaziko_organized', collection: 'map_trade_remedies_organized', limit: 5,
    filterExpr: "={{ JSON.parse($('Compliance Prep').first().json.matchQuery) }}"
  },
  {
    wfId: ids.hsLookupWfId, label: 'lookup_hs_code',
    prepNode: 'HS Prep',
    db: 'aaziko_organized', collection: 'map_products_organized', limit: 10,
    filterExpr: "={{ JSON.parse($('HS Prep').first().json.matchQuery) }}"
  },
  {
    wfId: ids.buyersWfId, label: 'find_buyers',
    prepNode: 'Buyers Prep',
    db: 'Dhruval', collection: 'buyer_intelligence', limit: 5,
    filterExpr: "={{ JSON.parse($('Buyers Prep').first().json.matchQuery) }}"
  },
];

function buildHttpNode(oldNode, tool) {
  // jsonBody is the correct field for specifyBody:'json' in n8n HTTP Request v4.2
  // (NOT bodyParameters — that sends key-value pairs, objects get serialized wrong)
  const bodyExpr = `={{ JSON.stringify({db:"${tool.db}",collection:"${tool.collection}",filter:JSON.parse($('${tool.prepNode}').first().json.matchQuery),limit:${tool.limit}}) }}`;
  return {
    id: oldNode.id,
    name: oldNode.name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: oldNode.position,
    parameters: {
      method: 'POST',
      url: PROXY_URL,
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'x-aaziko-secret',       value: PROXY_SECRET },
          { name: 'bypass-tunnel-reminder', value: 'true' }
        ]
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: bodyExpr,
      options: {}
    }
  };
}

async function wireTool(tool) {
  const wf = await getWf(tool.wfId);
  let targetIdx = wf.nodes.findIndex(n => n.type && n.type.includes('mongoDb'));

  if (targetIdx === -1) {
    // May already be an httpRequest — update it too (body format fix)
    targetIdx = wf.nodes.findIndex(n => n.type && n.type.includes('httpRequest'));
    if (targetIdx !== -1) {
      const existing = wf.nodes[targetIdx];
      const hasCorrectBody   = existing.parameters && existing.parameters.jsonBody;
      const hasCorrectUrl    = existing.parameters && existing.parameters.url === PROXY_URL;
      const headers          = (existing.parameters && existing.parameters.headerParameters && existing.parameters.headerParameters.parameters) || [];
      const hasBypassHeader  = headers.some(h => h.name === 'bypass-tunnel-reminder');
      if (hasCorrectBody && hasCorrectUrl && hasBypassHeader) {
        console.log(tool.label + ': httpRequest already correct — skip ✅');
        return;
      }
      console.log(tool.label + ': httpRequest has WRONG body format — fixing jsonBody');
    } else {
      console.log(tool.label + ': no mongoDb or httpRequest node found — INVESTIGATE');
      return;
    }
  }

  const oldNode = wf.nodes[targetIdx];
  const isHttp = oldNode.type && oldNode.type.includes('httpRequest');
  console.log(tool.label + ' (' + tool.wfId + '): ' + (isHttp ? 'fix httpRequest body' : 'mongoDb → httpRequest'));
  console.log('  DB: ' + tool.db + '.' + tool.collection);

  if (!WRITE) return;

  fs.writeFileSync(path.join(BACKUP_DIR, tool.wfId + '_before_proxy_wire_v2.json'), JSON.stringify(wf, null, 2));

  wf.nodes[targetIdx] = buildHttpNode(oldNode, tool);

  await putWf(tool.wfId, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings });
  await activate(tool.wfId);

  // Verify
  const live = await getWf(tool.wfId);
  const lHttp = live.nodes.find(n => n.type && n.type.includes('httpRequest'));
  const lMongo = live.nodes.find(n => n.type && n.type.includes('mongoDb'));
  const lJsonBody = lHttp && lHttp.parameters && lHttp.parameters.jsonBody;
  const ok = !!lHttp && !lMongo && !!lJsonBody;
  console.log('  → httpRequest:', !!lHttp, '| mongoDb gone:', !lMongo, '| jsonBody:', !!lJsonBody, ok ? '✅' : '❌');
}

(async () => {
  console.log('=== WIRE TOOLS TO PROXY (dry:' + !WRITE + ') ===\n');
  console.log('Proxy URL:', PROXY_URL);
  console.log('Secret:   aazikoProxy2026 (add to .env as AAZIKO_PROXY_SECRET)\n');

  for (const tool of TOOLS) {
    await wireTool(tool);
  }

  if (!WRITE) {
    console.log('\n--- BEFORE RUNNING --write, do these 2 steps ---');
    console.log('1. Add to .env:');
    console.log('   AAZIKO_TRADE_DB_URI=<your 100.70.212.45 connection string>');
    console.log('   AAZIKO_PROXY_SECRET=aazikoProxy2026');
    console.log('2. Restart server.js (npm run dev or restart the process)');
    console.log('3. Test health: GET http://localhost:3000/api/aaziko/health  (from browser on this machine)');
    console.log('\n(pass --write to wire the tools)');
  } else {
    console.log('\n✅ All tools wired to proxy — test a query on Aaziko UI');
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
