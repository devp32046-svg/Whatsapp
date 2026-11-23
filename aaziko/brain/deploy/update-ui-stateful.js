'use strict';
/*
 * Update Aaziko UI (bL0JQ2UTk4nM5rIJ) — make it stateful:
 *   1. Session ID persisted to localStorage (survives page refresh)
 *   2. Messages cached per session in localStorage (restore on reload)
 *   3. "New Chat" button — fresh session, blank slate
 *   4. History sidebar — past chats with first-message title, click to restore
 *
 * node aaziko/brain/deploy/update-ui-stateful.js          -- verify
 * node aaziko/brain/deploy/update-ui-stateful.js --write  -- deploy
 */
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate, RROOT } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(RROOT, 'backups');
const WF_ID = 'bL0JQ2UTk4nM5rIJ';
const WRITE = process.argv.includes('--write');

const NEW_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aaziko AI</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d1117;--panel:#161b22;--border:#30363d;
  --text:#e6edf3;--muted:#8b949e;--accent:#2ea043;
  --user-bg:#1f6feb;--bot-bg:#21262d;--input-bg:#0d1117;
}
body{font-family:-apple-system,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);height:100vh;display:flex;flex-direction:column;overflow:hidden}
header{padding:10px 14px;background:var(--panel);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex:0 0 auto;z-index:10}
.logo{width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,#2ea043,#1a7f37);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;color:#fff;flex:0 0 auto}
.hd-info{flex:1;min-width:0;overflow:hidden}
.hd-info h1{font-size:13px;font-weight:600;white-space:nowrap}
.hd-info .sub{font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hd-btn{background:var(--bg);border:1px solid var(--border);border-radius:7px;color:var(--text);padding:4px 10px;font-size:12px;cursor:pointer;white-space:nowrap;flex:0 0 auto}
.hd-btn:hover{border-color:var(--accent);color:var(--accent)}
#status{font-size:11px;color:var(--muted);background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:3px 10px;flex:0 0 auto}
.layout{flex:1;display:flex;overflow:hidden;position:relative}
#sidebar{width:260px;background:var(--panel);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden;flex:0 0 auto;transition:width .2s}
#sidebar.closed{width:0;border-right:none}
.sb-head{padding:11px 14px;font-size:11px;font-weight:600;color:var(--muted);letter-spacing:.8px;text-transform:uppercase;border-bottom:1px solid var(--border);flex:0 0 auto;white-space:nowrap}
#sess-list{flex:1;overflow-y:auto;padding:4px 0}
.si{padding:9px 14px;cursor:pointer;border-left:2px solid transparent;transition:background .12s}
.si:hover{background:var(--bg)}
.si.active{background:var(--bg);border-left-color:var(--accent)}
.si-title{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)}
.si-date{font-size:10px;color:var(--muted);margin-top:1px}
#chat-pane{flex:1;display:flex;flex-direction:column;overflow:hidden}
#msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:9px}
.bubble{max-width:80%;padding:9px 13px;border-radius:11px;line-height:1.5;font-size:14px;white-space:pre-wrap;word-break:break-word}
.bubble.user{background:var(--user-bg);align-self:flex-end;border-bottom-right-radius:3px}
.bubble.bot{background:var(--bot-bg);align-self:flex-start;border-bottom-left-radius:3px;border:1px solid var(--border)}
.bubble.typing{color:var(--muted);font-style:italic}
.bubble.err{background:#3d1a1a;border-color:#6e1a1a;color:#ff7b7b}
.ts{font-size:10px;color:var(--muted);margin-top:2px}
.wrap{display:flex;flex-direction:column;align-items:flex-end}
.wrap.bw{align-items:flex-start}
form{padding:10px 14px;background:var(--panel);border-top:1px solid var(--border);display:flex;gap:8px;flex:0 0 auto}
textarea{flex:1;background:var(--input-bg);border:1px solid var(--border);border-radius:9px;color:var(--text);padding:9px 13px;font-size:14px;resize:none;outline:none;font-family:inherit;line-height:1.5;min-height:42px;max-height:120px}
textarea::placeholder{color:var(--muted)}
textarea:focus{border-color:var(--accent)}
button[type=submit]{background:var(--accent);color:#fff;border:none;border-radius:9px;padding:9px 16px;font-size:14px;font-weight:600;cursor:pointer}
button[type=submit]:hover{opacity:.88}
button[type=submit]:disabled{opacity:.4;cursor:not-allowed}
@media(max-width:600px){
  #sidebar{position:absolute;top:0;bottom:0;left:0;z-index:20;box-shadow:4px 0 20px #0008;width:0}
  #sidebar.open{width:min(260px,80vw)}
  #sidebar.closed{width:0}
  #msgs{padding:10px}
  .bubble{max-width:93%}
  form{padding:8px 10px}
}
</style>
</head>
<body>
<header>
  <div class="logo">A</div>
  <div class="hd-info">
    <h1>Aaziko AI</h1>
    <div class="sub" id="sess-label">Trade Assistant</div>
  </div>
  <button class="hd-btn" id="hist-btn">&#9776; History</button>
  <button class="hd-btn" id="new-btn">+ New Chat</button>
  <div id="status">ready</div>
</header>
<div class="layout">
  <div id="sidebar" class="closed">
    <div class="sb-head">Past Chats</div>
    <div id="sess-list"></div>
  </div>
  <div id="chat-pane">
    <div id="msgs"></div>
    <form id="form">
      <textarea id="inp" placeholder="Ask about products, tariffs, ports, compliance..." rows="1"></textarea>
      <button type="submit" id="btn">Send</button>
    </form>
  </div>
</div>
<script>
var KEY   = "a3f9e2b7c1d04e85f6a2c3d4e5f6a7b8";
var BRAIN = "/webhook/aaziko-brain-ui";
var K_SID = "az_sess";       // current session id
var K_ALL = "az_all_sess";   // [{id,title,ts}]
var K_MSG = "az_msg_";       // az_msg_<id> -> [{role,text,ts}]

function ls(k){try{return localStorage.getItem(k);}catch(e){return null;}}
function lss(k,v){try{localStorage.setItem(k,v);}catch(e){}}
function lsj(k){try{var v=ls(k);return v?JSON.parse(v):[];}catch(e){return[];}}
function lssj(k,v){lss(k,JSON.stringify(v));}

function nowTs(){var d=new Date();return("0"+d.getHours()).slice(-2)+":"+("0"+d.getMinutes()).slice(-2);}
function fmtDate(iso){
  try{
    var d=new Date(iso);
    return d.toLocaleDateString([],{month:'short',day:'numeric'})+' '+
           d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  }catch(e){return iso||'';}
}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

var SESSION;
var msgsEl=document.getElementById('msgs');
var inp=document.getElementById('inp');
var btn=document.getElementById('btn');
var status=document.getElementById('status');

function addBubble(text,role,typing,save,savedTs){
  var wrap=document.createElement('div');
  wrap.className='wrap'+(role==='bot'?' bw':'');
  var b=document.createElement('div');
  b.className='bubble '+(typing?'typing':role==='err'?'err':role);
  b.textContent=text;
  var t=document.createElement('div');
  t.className='ts';
  var tval=savedTs||nowTs();
  t.textContent=tval;
  wrap.appendChild(b);wrap.appendChild(t);
  msgsEl.appendChild(wrap);
  msgsEl.scrollTop=msgsEl.scrollHeight;
  if(save&&(role==='user'||role==='bot')){
    var arr=lsj(K_MSG+SESSION);
    arr.push({role:role,text:text,ts:tval});
    lssj(K_MSG+SESSION,arr);
  }
  return b;
}
function setStatus(t){status.textContent=t;}

function loadSession(id){
  SESSION=id;
  lss(K_SID,SESSION);
  msgsEl.innerHTML='';
  var saved=lsj(K_MSG+SESSION);
  if(saved.length===0){
    addBubble('Hello! I am Aaziko AI. Ask me about products, tariff rates, ports, or trade compliance.','bot',false,false);
  }else{
    saved.forEach(function(m){addBubble(m.text,m.role,false,false,m.ts);});
  }
  refreshLabel();
  highlightActive();
}

function upsertSession(firstMsg){
  var all=lsj(K_ALL);
  if(!all.find(function(s){return s.id===SESSION;})){
    all.unshift({id:SESSION,title:firstMsg,ts:new Date().toISOString()});
    lssj(K_ALL,all.slice(0,60));
  }
  renderSidebar();
  refreshLabel();
}

function refreshLabel(){
  var all=lsj(K_ALL);
  var cur=all.find(function(s){return s.id===SESSION;});
  document.getElementById('sess-label').textContent=cur?(cur.title.slice(0,40)||'Chat'):'New Chat';
}

function highlightActive(){
  document.querySelectorAll('.si').forEach(function(el){
    el.classList.toggle('active',el.getAttribute('data-id')===SESSION);
  });
}

function renderSidebar(){
  var list=document.getElementById('sess-list');
  var all=lsj(K_ALL);
  if(!all.length){
    list.innerHTML='<div style="padding:14px 14px;color:var(--muted);font-size:12px">No past chats yet</div>';
    return;
  }
  list.innerHTML=all.map(function(s){
    var act=s.id===SESSION?' active':'';
    return '<div class="si'+act+'" data-id="'+s.id+'">'
      +'<div class="si-title">'+esc(s.title)+'</div>'
      +'<div class="si-date">'+fmtDate(s.ts)+'</div>'
      +'</div>';
  }).join('');
  list.querySelectorAll('.si').forEach(function(el){
    el.addEventListener('click',function(){
      var id=this.getAttribute('data-id');
      if(id!==SESSION)loadSession(id);
      if(window.innerWidth<=600)toggleSidebar(false);
      else highlightActive();
    });
  });
}

function toggleSidebar(force){
  var sb=document.getElementById('sidebar');
  var isMobile=window.innerWidth<=600;
  if(isMobile){
    var open=typeof force==='boolean'?force:sb.classList.contains('closed');
    sb.classList.toggle('closed',!open);
    sb.classList.toggle('open',open);
  }else{
    var closed=typeof force==='boolean'?!force:!sb.classList.contains('closed');
    sb.classList.toggle('closed',closed);
  }
}

document.getElementById('hist-btn').addEventListener('click',function(){toggleSidebar();});
document.getElementById('new-btn').addEventListener('click',function(){
  SESSION="ui-"+Math.random().toString(36).slice(2,10);
  loadSession(SESSION);
  renderSidebar();
});

document.getElementById('form').addEventListener('submit',function(e){
  e.preventDefault();
  var text=inp.value.trim();
  if(!text)return;
  inp.value='';inp.style.height='';
  btn.disabled=true;setStatus('thinking...');
  addBubble(text,'user',false,true);
  upsertSession(text);
  var tb=addBubble('...','bot',true,false);

  fetch(BRAIN,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({message:text,sessionId:SESSION,channel:'ui',secret:KEY})
  })
  .then(function(r){return r.json();})
  .then(function(j){
    var reply=j.reply||'(no reply)';
    tb.className='bubble bot';
    tb.textContent=reply;
    msgsEl.scrollTop=msgsEl.scrollHeight;
    var arr=lsj(K_MSG+SESSION);
    arr.push({role:'bot',text:reply,ts:nowTs()});
    lssj(K_MSG+SESSION,arr);
    setStatus('ready');btn.disabled=false;inp.focus();
  })
  .catch(function(err){
    tb.className='bubble err';
    tb.textContent='Error: '+err.message;
    setStatus('error');btn.disabled=false;
  });
});

inp.addEventListener('keydown',function(e){
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();document.getElementById('form').dispatchEvent(new Event('submit'));}
});
inp.addEventListener('input',function(){
  this.style.height='';
  this.style.height=Math.min(this.scrollHeight,120)+'px';
});

// init
(function(){
  var saved=ls(K_SID);
  SESSION=saved||("ui-"+Math.random().toString(36).slice(2,10));
  loadSession(SESSION);
  renderSidebar();
})();
</script>
<style>#n8n-download-all-btn{display:none!important;visibility:hidden!important;pointer-events:none!important}</style>
<script>(function(){function rm(){var b=document.getElementById('n8n-download-all-btn');if(b)b.remove();}rm();var mo=new MutationObserver(rm);mo.observe(document.documentElement,{childList:true,subtree:true});})();</script>
</body>
</html>`;

console.log('HTML length:', NEW_HTML.length, 'chars');
if (!NEW_HTML.includes('az_sess'))      { console.log('ERR: session key missing'); process.exit(1); }
if (!NEW_HTML.includes('New Chat'))     { console.log('ERR: New Chat button missing'); process.exit(1); }
if (!NEW_HTML.includes('sess-list'))    { console.log('ERR: session list missing'); process.exit(1); }
if (!NEW_HTML.includes('localStorage')){ console.log('ERR: localStorage missing'); process.exit(1); }
if (NEW_HTML.includes('$&'))            { console.log('ERR: $& trap in HTML'); process.exit(1); }
console.log('✅ All structural checks pass');

if (!WRITE) { console.log('(--write to deploy)'); process.exit(0); }

(async () => {
  const wf = await getWf(WF_ID);
  fs.writeFileSync(path.join(BACKUP_DIR, WF_ID + '_before_stateful_ui.json'), JSON.stringify(wf, null, 2), 'utf8');
  console.log('Backup saved. Nodes:', wf.nodes.length);

  const serve = wf.nodes.find(n => n.name === 'Serve HTML');
  if (!serve) { console.log('ERR: Serve HTML node missing'); process.exit(1); }

  serve.parameters.responseBody = NEW_HTML;

  const settings = Object.assign({}, wf.settings); delete settings.binaryMode;
  const r = await putWf(WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) { console.log('PUT failed:', r.status, r.body.slice(0, 300)); process.exit(1); }
  console.log('✅ PUT 200');

  await activate(WF_ID);
  console.log('✅ Activated');

  const check = await getWf(WF_ID);
  const s2 = check.nodes.find(n => n.name === 'Serve HTML');
  const ok = s2 && s2.parameters.responseBody.includes('az_sess') && s2.parameters.responseBody.includes('New Chat');
  console.log((ok ? '✅' : '❌') + ' Read-back: stateful UI live');
  if (!ok) process.exit(1);
  console.log('URL: https://ai.cgpe.in/webhook/aaziko-ui');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
