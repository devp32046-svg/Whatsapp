// Fetch the live Reminder Engine workflow to inspect its current node structure
// Run: node fetch-reminder-engine.js

const N8N_API_KEY = process.env.N8N_API_KEY || require('fs').readFileSync('.env','utf8').match(/N8N_API_KEY=(.+)/)?.[1]?.trim();
const BASE = 'https://ai.cgpe.in/api/v1';
const WF_ID = 'KL9WetH0w1Sr6Ddf';

async function main() {
  const r = await fetch(`${BASE}/workflows/${WF_ID}`, {
    headers: { 'X-N8N-API-KEY': N8N_API_KEY, 'Accept': 'application/json' }
  });
  const wf = await r.json();
  const nodes = wf.nodes || [];
  
  // Print node list with names and types
  console.log('=== Reminder Engine Nodes ===');
  nodes.forEach((n, i) => {
    const code = n.parameters?.jsCode ? '\n  CODE: ' + n.parameters.jsCode.slice(0, 300).replace(/\n/g, ' ') : '';
    const query = n.parameters?.query ? '\n  QUERY: ' + n.parameters.query : '';
    const coll = n.parameters?.collection ? ' [' + n.parameters.collection + ']' : '';
    console.log(`${i+1}. [${n.name}] type=${n.type}${coll}${code}${query}`);
  });

  // Print connections
  console.log('\n=== Connections ===');
  const conns = wf.connections || {};
  for (const [from, targets] of Object.entries(conns)) {
    (targets.main || []).forEach((arr, idx) => {
      (arr || []).forEach(t => {
        console.log(`  ${from} → ${t.node}`);
      });
    });
  }

  // Save full JSON for inspection
  require('fs').writeFileSync('reng_live.json', JSON.stringify(wf, null, 2));
  console.log('\nSaved to reng_live.json');
}

main().catch(console.error);
