'use strict';
require('dotenv').config();
const https = require('https');
const key = process.env.N8N_API_KEY;

function n8nGet(p) {
  return new Promise((res,rej)=>{
    const req = https.request({hostname:'ai.cgpe.in',path:'/api/v1'+p,headers:{'X-N8N-API-KEY':key}},r=>{
      let d=Buffer.alloc(0);
      r.on('data',c=>d=Buffer.concat([d,c]));
      r.on('end',()=>{ try{res(JSON.parse(d.toString('utf8')));}catch(e){res({});} });
    });
    req.on('error',rej); req.end();
  });
}

const IDS = {
  'search_tariff':        'k71O78yLV0v0TXZl',
  'search_products':      'IdQQ66Ugw7eJIqax',
  'find_port':            '7EaCbHmYLnzpaLPn',
  'get_compliance':       '3qY2tab3Pnt6FmPD',
  'get_trade_stats':      'VSjS7OSBfpoQDsor',
  'lookup_hs_code':       'OqZH3AoC6yy8UIbz',
  'get_trade_agreements': 'VD5U9B9GCVb3ymo0',
  'find_buyers':          'WPAowCu3eKOHz4Yr',
};

(async () => {
  console.log('=== Aaziko Tool Sub-Workflow Audit ===\n');
  for (const [name, id] of Object.entries(IDS)) {
    const wf = await n8nGet('/workflows/' + id);
    const nodes = wf.nodes || [];

    const codeNodes = nodes.filter(n =>
      n.type === 'n8n-nodes-base.code' && n.parameters && n.parameters.jsCode
    );

    const prepNode = codeNodes.find(n => /prep|parse|input|query/i.test(n.name)) || codeNodes[0];
    if (!prepNode) {
      console.log(name + ': no code node\n'); continue;
    }

    const code = prepNode.parameters.jsCode;
    const hasCountry   = /country/.test(code);
    const hasHyphenFix = code.includes('replace(/-');
    const kindM = (code.match(/kind\s*:\s*'([^']+)'/) || code.match(/kind\s*:\s*"([^"]+)"/));
    const hasErrorGate = nodes.some(n => n.name && /error|gate/i.test(n.name));

    console.log(name + ':');
    console.log('  node: ' + prepNode.name + ' | total nodes: ' + nodes.length);
    if (hasCountry) {
      console.log('  country parse: YES | hyphen fix: ' + (hasHyphenFix ? '✅' : '❌ MISSING'));
    } else {
      console.log('  country parse: no');
    }
    if (kindM) console.log('  kind: "' + kindM[1] + '"');
    console.log('  error gate: ' + (hasErrorGate ? 'yes' : 'NO'));
    // Show inp.country or similar extraction snippet
    var idx = code.indexOf('inp.country');
    if (idx < 0) idx = code.indexOf('country1');
    if (idx < 0) idx = code.indexOf('country');
    if (idx > 0) console.log('  snippet: ...' + code.slice(Math.max(0,idx-5),idx+100).replace(/\n/g,' ').slice(0,130));
    console.log('');
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
