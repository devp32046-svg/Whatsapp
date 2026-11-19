'use strict';
/* Build WORKFLOW #3 — the test UI (served by n8n on ai.cgpe.in). A chat-style page that polls a feed
 * of fired reminders (ui_inbox) + pending ones, and lets you create a reminder that fires in N minutes.
 * No WhatsApp number needed — this IS the v1 notification surface (channel 'ui'). ISOLATED (Aaziko mongo
 * cred only). The page reads its key from ?k= (NOT embedded) and sends it as the create secret + feed key.
 *
 *   node aaziko/reminders/deploy/build-ui.js            # dry-run
 *   node aaziko/reminders/deploy/build-ui.js --write     # create/update + activate; prints the URL (with ?k=)
 */
const path = require('path'), fs = require('fs');
const { req, HOST } = require('../../../scripts/lib/n8n-req');
const { buildFeed } = require('../lib/node-code');

const SEC_DIR = path.resolve(__dirname, '..', '..', '.secrets');
const env = {}; try { fs.readFileSync(path.join(SEC_DIR, 'reminders.env'), 'utf8').split(/\r?\n/).forEach(l => { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2]; }); } catch (e) {}
const SECRET = env.REMINDERS_CREATE_SECRET;
if (!SECRET) { console.error('REMINDERS_CREATE_SECRET missing — run build-create.js first'); process.exit(1); }
const CRED = 'Hxh39r3Fnn77hr55', CRED_NAME = 'Aaziko Reminders Mongo (aaziko_reminders ONLY)', CGPE_MONGO_CRED = 'WZ2iSk9j0aJMoLDk';
const IDS_FILE = path.join(SEC_DIR, 'reminders-n8n.json');
const ids = (() => { try { return JSON.parse(fs.readFileSync(IDS_FILE, 'utf8')); } catch (e) { return {}; } })();
const saveIds = () => fs.writeFileSync(IDS_FILE, JSON.stringify(ids, null, 2));
const mongo = (name, params, pos, extra) => Object.assign({ id: name.replace(/[^a-z]/gi, '').slice(0, 8) + pos[0], name,
  type: 'n8n-nodes-base.mongoDb', typeVersion: 1.3, position: pos, parameters: params,
  credentials: { mongoDb: { id: CRED, name: CRED_NAME } } }, extra || {});

// ---- the page (static; no secret embedded — read from ?k=). Inline JS uses concatenation, no `${}`. ----
const HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aaziko Reminders</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;background:#eceff3;color:#111}
#app{max-width:520px;margin:0 auto;height:100vh;display:flex;flex-direction:column;background:#f5f6f8}
header{background:#0b7a4b;color:#fff;padding:12px 16px}
header .title{font-weight:700;font-size:17px}
header .tag{font-weight:400;font-size:11px;opacity:.8;border:1px solid rgba(255,255,255,.5);border-radius:10px;padding:1px 7px;margin-left:6px}
#state{font-size:12px;opacity:.9;margin-top:4px}
main{flex:1;overflow-y:auto;padding:14px}
.section-label{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#789;margin:8px 2px}
.chip{background:#fff;border:1px solid #dde3ea;border-radius:10px;padding:8px 10px;margin:6px 0;font-size:14px;display:flex;justify-content:space-between;gap:8px;align-items:center}
.chip .due{font-size:12px;color:#789;white-space:nowrap}
.chip.od{border-color:#e6a200;background:#fff8e6}
.chip.od .due{color:#b37400}
.bubble{background:#dcf8c6;border-radius:10px 10px 2px 10px;padding:8px 11px;margin:6px 0 6px auto;max-width:85%;font-size:14px;box-shadow:0 1px 1px rgba(0,0,0,.06)}
.bubble .t{font-size:11px;color:#5a7a52;text-align:right;margin-top:3px}
.empty{color:#9aa7b4;font-size:13px;text-align:center;margin:18px 0}
footer{padding:10px;border-top:1px solid #dde3ea;background:#fff}
footer input{width:100%;padding:11px;border:1px solid #cfd6de;border-radius:10px;font-size:14px}
.btns{display:flex;gap:8px;margin-top:8px}
.btns button{flex:1;padding:10px;border:0;border-radius:10px;background:#0b7a4b;color:#fff;font-size:13px;font-weight:600;cursor:pointer}
.btns button:active{opacity:.8}
#toast{position:fixed;bottom:84px;left:50%;transform:translateX(-50%);background:#111;color:#fff;padding:8px 14px;border-radius:20px;font-size:13px;opacity:0;transition:opacity .25s;pointer-events:none}
#toast.show{opacity:.92}
</style></head>
<body><div id="app">
<header><div class="title">Aaziko Reminders <span class="tag">v1 test</span></div><div id="state">connecting…</div></header>
<main><div class="section-label">Scheduled</div><div id="pending"></div><div class="section-label">Fired</div><div id="inbox"></div></main>
<footer><input id="text" placeholder="Reminder text, e.g. Call supplier" autocomplete="off">
<div class="btns"><button data-min="1">in 1 min</button><button data-min="2">in 2 min</button><button data-min="5">in 5 min</button></div></footer>
</div><div id="toast"></div>
<script>
(function(){
  var K = new URLSearchParams(location.search).get('k') || '';
  var FEED = '/webhook/aaziko-reminders-feed?k=' + encodeURIComponent(K);
  var CREATE = '/webhook/aaziko-reminder-create';
  function z(n){ return (n<10?'0':'')+n; }
  function istWall(plusMin){ var d = new Date(Date.now() + plusMin*60000 + 5.5*3600000);
    return d.getUTCFullYear()+'-'+z(d.getUTCMonth()+1)+'-'+z(d.getUTCDate())+' '+z(d.getUTCHours())+':'+z(d.getUTCMinutes()); }
  function el(tag, cls, txt){ var e=document.createElement(tag); if(cls)e.className=cls; if(txt!=null)e.textContent=txt; return e; }
  function toast(m){ var t=document.getElementById('toast'); t.textContent=m; t.className='show'; setTimeout(function(){t.className='';},1800); }
  function render(d){
    var st=document.getElementById('state');
    if(!d || d.ok===false){ st.textContent = (d&&d.error) ? ('error: '+d.error) : 'cannot load feed (check link key)'; return; }
    st.textContent = 'channel '+d.channel+' · '+(d.sendEnabled?'ON':'OFF')+(d.quietNow?' · quiet hours (22-08), holding':'')+' · IST '+d.nowIST;
    var P=document.getElementById('pending'); P.innerHTML='';
    if(!d.pending.length){ P.appendChild(el('div','empty','no scheduled reminders')); }
    d.pending.forEach(function(r){ var c=el('div','chip'+(r.overdue?' od':'')); c.appendChild(el('span',null,r.text)); c.appendChild(el('span','due', (r.overdue?'overdue · ':'')+'at '+r.dueIST)); P.appendChild(c); });
    var I=document.getElementById('inbox'); I.innerHTML='';
    if(!d.inbox.length){ I.appendChild(el('div','empty','nothing fired yet')); }
    d.inbox.slice().reverse().forEach(function(r){ var b=el('div','bubble'); b.appendChild(el('div',null,r.text)); b.appendChild(el('div','t',r.firedIST)); I.appendChild(b); });
  }
  function poll(){ fetch(FEED,{method:'GET'}).then(function(r){return r.json();}).then(render).catch(function(){ document.getElementById('state').textContent='offline — retrying…'; }); }
  function send(min){ var inp=document.getElementById('text'); var text=(inp.value||'').trim(); if(!text){ toast('type a reminder first'); return; }
    fetch(CREATE,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:text,recipientPhone:'910000000000',nextFireAt:istWall(min),secret:K,source:'ui'})})
      .then(function(r){return r.json().catch(function(){return {};});})
      .then(function(){ toast('scheduled in '+min+' min'); }).catch(function(){ toast('scheduled (will appear shortly)'); });
    inp.value=''; setTimeout(poll,600);
  }
  var btns=document.querySelectorAll('.btns button'); for(var i=0;i<btns.length;i++){ btns[i].addEventListener('click',function(){ send(parseInt(this.getAttribute('data-min'),10)); }); }
  document.getElementById('text').addEventListener('keydown',function(e){ if(e.key==='Enter') send(1); });
  poll(); setInterval(poll,4000);
})();
</script></body></html>`;

const wfPayload = () => ({
  name: 'Aaziko Reminders — UI',
  nodes: [
    { id: 'ph', name: 'Page Hook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, -120],
      parameters: { httpMethod: 'GET', path: 'aaziko-reminders-ui', responseMode: 'responseNode', options: {} } },
    { id: 'sp', name: 'Serve Page', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1, position: [240, -120],
      parameters: { respondWith: 'text', responseBody: HTML, options: { responseHeaders: { entries: [{ name: 'content-type', value: 'text/html; charset=utf-8' }] } } } },
    { id: 'fh', name: 'Feed Hook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 120],
      parameters: { httpMethod: 'GET', path: 'aaziko-reminders-feed', responseMode: 'responseNode', options: { allowedOrigins: '*' } } },
    mongo('Load Config', { collection: 'config', query: '{"key":"engine"}', options: { limit: 1 } }, [240, 120], { executeOnce: true }),
    mongo('Load Inbox', { operation: 'aggregate', collection: 'ui_inbox',
      query: '[{"$sort":{"firedAt":-1}},{"$limit":50},{"$facet":{"rows":[{"$project":{"_id":0,"text":1,"recipientPhone":1,"firedAt":1}}]}}]' }, [460, 120], { executeOnce: true }),
    mongo('Load Pending', { operation: 'aggregate', collection: 'reminders',
      query: '[{"$match":{"status":"active"}},{"$sort":{"nextFireAt":1}},{"$limit":50},{"$facet":{"rows":[{"$project":{"_id":0,"text":1,"recipientPhone":1,"nextFireAt":1}}]}}]' }, [680, 120], { executeOnce: true }),
    { id: 'bf', name: 'Build Feed', type: 'n8n-nodes-base.code', typeVersion: 2, position: [900, 120],
      parameters: { jsCode: buildFeed(SECRET) } },
    { id: 'rf', name: 'Respond Feed', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1, position: [1120, 120],
      parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json) }}', options: {} } },
  ],
  connections: {
    'Page Hook': { main: [[{ node: 'Serve Page', type: 'main', index: 0 }]] },
    'Feed Hook': { main: [[{ node: 'Load Config', type: 'main', index: 0 }]] },
    'Load Config': { main: [[{ node: 'Load Inbox', type: 'main', index: 0 }]] },
    'Load Inbox': { main: [[{ node: 'Load Pending', type: 'main', index: 0 }]] },
    'Load Pending': { main: [[{ node: 'Build Feed', type: 'main', index: 0 }]] },
    'Build Feed': { main: [[{ node: 'Respond Feed', type: 'main', index: 0 }]] },
  },
  settings: { saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all' },
});

function assertClean(wf) {
  if (JSON.stringify(wf).includes(CGPE_MONGO_CRED)) throw new Error('ABORT: CGPE mongo cred leaked');
  const bad = wf.nodes.flatMap(n => Object.values(n.credentials || {}).map(c => c.id)).filter(id => id !== CRED);
  if (bad.length) throw new Error('ABORT: unexpected cred id(s): ' + bad.join(','));
}

(async () => {
  const mode = process.argv.includes('--write') ? 'write' : 'dry';
  const wf = wfPayload(); assertClean(wf);
  if (mode === 'dry') {
    console.log('nodes:', wf.nodes.map(n => n.name).join(' -> '));
    console.log('HTML bytes:', HTML.length);
    console.log('\nDRY-RUN. --write to deploy. URL will be https://' + HOST + '/webhook/aaziko-reminders-ui?k=<secret>');
    return;
  }
  if (!ids.uiWfId) {
    const r = await req('POST', '/api/v1/workflows', wf);
    if (r.status >= 300) throw new Error('create -> ' + r.status + ' ' + r.body.slice(0, 400));
    ids.uiWfId = JSON.parse(r.body).id; saveIds();
    console.log('created UI workflow:', ids.uiWfId);
  } else {
    const put = await req('PUT', '/api/v1/workflows/' + ids.uiWfId, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings });
    console.log('updated UI workflow ' + ids.uiWfId + ' -> ' + put.status + (put.status >= 300 ? ' ' + put.body.slice(0, 400) : ''));
  }
  await req('POST', '/api/v1/workflows/' + ids.uiWfId + '/activate');
  const live = JSON.parse((await req('GET', '/api/v1/workflows/' + ids.uiWfId)).body);
  assertClean(live);
  console.log('active=' + live.active + ' | nodes =', live.nodes.map(n => n.name).join(' -> '));
  console.log('\nOPEN THIS (contains the key — keep it private):');
  console.log('  https://' + HOST + '/webhook/aaziko-reminders-ui?k=' + SECRET);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
