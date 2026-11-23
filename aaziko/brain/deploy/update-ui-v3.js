'use strict';
/*
 * Aaziko UI v3 — 2 fixes on top of v2:
 *   1. Aaziko brand logo in header (embedded as base64 PNG)
 *   2. History sidebar toggle fixed (state variable, no class-read ambiguity)
 *
 * node aaziko/brain/deploy/update-ui-v3.js          -- verify
 * node aaziko/brain/deploy/update-ui-v3.js --write  -- deploy
 */
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate, RROOT } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(RROOT, 'backups');
const WF_ID = 'bL0JQ2UTk4nM5rIJ';
const WRITE = process.argv.includes('--write');

// ── Aaziko logo ───────────────────────────────────────────────────────────
// Try saved b64 file first, else re-read from known temp path
let LOGO_B64 = '';
const B64_CACHE = path.join(process.env.TEMP || 'C:\\Users\\Inet\\AppData\\Local\\Temp', 'aaziko_logo.b64');
const PNG_PATH  = path.join(process.env.TEMP || 'C:\\Users\\Inet\\AppData\\Local\\Temp',
  'claude', '70a9d5b356a9a0e9', 'a77b6283-5cc3-4466-8863-437bab87be76', 'images', '20.png');

if (fs.existsSync(B64_CACHE)) {
  LOGO_B64 = fs.readFileSync(B64_CACHE, 'utf8').trim();
  console.log('Logo loaded from cache (' + (LOGO_B64.length / 1024).toFixed(0) + ' KB b64)');
} else if (fs.existsSync(PNG_PATH)) {
  LOGO_B64 = fs.readFileSync(PNG_PATH).toString('base64');
  fs.writeFileSync(B64_CACHE, LOGO_B64, 'utf8');
  console.log('Logo read from PNG (' + (LOGO_B64.length / 1024).toFixed(0) + ' KB b64)');
} else {
  console.log('⚠️  Logo PNG not found — using text placeholder. Run with logo PNG at:\n  ' + PNG_PATH);
  LOGO_B64 = '';
}

const LOGO_TAG = LOGO_B64
  ? `<img id="logo-img" src="data:image/png;base64,${LOGO_B64}" alt="Aaziko" style="height:36px;width:auto;border-radius:6px;background:#fff;padding:3px 10px;flex:0 0 auto;">`
  : `<div class="logo">A</div>`;

// ── Build HTML ────────────────────────────────────────────────────────────
const NEW_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aaziko AI</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--text:#e6edf3;--muted:#8b949e;--accent:#2ea043;--user-bg:#1f6feb;--bot-bg:#21262d;--input-bg:#0d1117}
body{font-family:-apple-system,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);height:100vh;display:flex;flex-direction:column;overflow:hidden}
header{padding:8px 14px;background:var(--panel);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;flex:0 0 auto;z-index:10}
.logo{width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,#2ea043,#1a7f37);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;color:#fff;flex:0 0 auto}
.hd-info{flex:1;min-width:0;overflow:hidden}
.hd-sub{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hd-btn{background:var(--bg);border:1px solid var(--border);border-radius:7px;color:var(--text);padding:5px 11px;font-size:12px;cursor:pointer;white-space:nowrap;flex:0 0 auto;transition:border-color .15s,color .15s}
.hd-btn:hover{border-color:var(--accent);color:var(--accent)}
#st{width:8px;height:8px;border-radius:50%;background:#3fb950;flex:0 0 auto;box-shadow:0 0 6px #3fb95066}
#st.busy{background:#f0883e;box-shadow:0 0 6px #f0883e66;animation:pulse 1s ease-in-out infinite}
#st.err{background:#f85149;box-shadow:0 0 6px #f8514966}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.layout{flex:1;display:flex;overflow:hidden;position:relative}
/* sidebar */
#sidebar{width:0;overflow:hidden;background:var(--panel);border-right:1px solid transparent;display:flex;flex-direction:column;flex:none;transition:width .22s ease,border-color .22s ease}
#sidebar.open{width:260px;border-right-color:var(--border)}
.sb-head{padding:11px 14px;font-size:11px;font-weight:600;color:var(--muted);letter-spacing:.8px;text-transform:uppercase;border-bottom:1px solid var(--border);flex:0 0 auto;white-space:nowrap}
#sess-list{flex:1;overflow-y:auto;padding:4px 0;min-width:260px}
.si{padding:9px 12px;cursor:pointer;border-left:3px solid transparent;display:flex;align-items:center;gap:6px;transition:background .12s}
.si:hover{background:rgba(255,255,255,.05)}
.si.active{background:rgba(255,255,255,.07);border-left-color:var(--accent)}
.si-body{flex:1;min-width:0}
.si-title{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)}
.si-date{font-size:10px;color:var(--muted);margin-top:2px}
.si-del{opacity:0;background:none;border:none;color:var(--muted);cursor:pointer;padding:2px 5px;font-size:12px;border-radius:4px;flex:0 0 auto;line-height:1}
.si:hover .si-del{opacity:1}
.si-del:hover{color:#f85149;background:rgba(248,81,73,.15)}
/* chat */
#chat-pane{flex:1;display:flex;flex-direction:column;overflow:hidden;position:relative;min-width:0}
#msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.msg-row{display:flex;gap:8px;align-items:flex-start}
.msg-row.ur{flex-direction:row-reverse}
.av{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#2ea043,#1a7f37);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;color:#fff;flex:0 0 auto;margin-top:2px}
.mc{display:flex;flex-direction:column;max-width:78%;gap:3px}
.msg-row.ur .mc{align-items:flex-end}
.bubble{padding:10px 13px;border-radius:12px;line-height:1.6;font-size:14px;word-break:break-word}
.bubble.user{background:var(--user-bg);border-bottom-right-radius:3px;white-space:pre-wrap}
.bubble.bot{background:var(--bot-bg);border:1px solid var(--border);border-bottom-left-radius:3px}
.bubble.bot a{color:#58a6ff;text-decoration:none}
.bubble.bot a:hover{text-decoration:underline}
.bubble.bot code{background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:1px 5px;font-size:12px;font-family:monospace}
.bubble.bot strong{color:#e6edf3}
.bubble.bot ul,.bubble.bot ol{margin:4px 0 4px 18px}
.bubble.bot li{margin-bottom:2px}
.bubble.bot p{margin-bottom:6px}
.bubble.bot p:last-child{margin-bottom:0}
.bubble.err{background:#3d1a1a;border-color:#6e1a1a;color:#ff7b7b}
.ba{display:flex;align-items:center;gap:6px;opacity:0;transition:opacity .15s;min-height:18px}
.msg-row:hover .ba{opacity:1}
.ts{font-size:10px;color:var(--muted)}
.cp{background:none;border:1px solid var(--border);border-radius:5px;color:var(--muted);padding:1px 7px;font-size:11px;cursor:pointer;transition:all .12s}
.cp:hover{border-color:var(--accent);color:var(--accent)}
.cp.ok{border-color:#3fb950;color:#3fb950}
/* typing dots */
.td{display:inline-flex;gap:4px;align-items:center;padding:4px 0}
.td span{display:block;width:7px;height:7px;border-radius:50%;background:var(--muted);animation:tda .9s ease-in-out infinite}
.td span:nth-child(2){animation-delay:.18s}
.td span:nth-child(3){animation-delay:.36s}
@keyframes tda{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-6px);opacity:1}}
/* scroll btn */
#sb-btn{position:absolute;bottom:76px;right:14px;width:34px;height:34px;border-radius:50%;background:var(--panel);border:1px solid var(--border);color:var(--muted);display:none;align-items:center;justify-content:center;cursor:pointer;font-size:16px;z-index:5;box-shadow:0 2px 8px #0005}
#sb-btn:hover{border-color:var(--accent);color:var(--accent)}
/* input */
form{padding:10px 14px;background:var(--panel);border-top:1px solid var(--border);display:flex;gap:8px;flex:0 0 auto}
textarea{flex:1;background:var(--input-bg);border:1px solid var(--border);border-radius:9px;color:var(--text);padding:9px 13px;font-size:14px;resize:none;outline:none;font-family:inherit;line-height:1.5;min-height:42px;max-height:120px}
textarea::placeholder{color:var(--muted)}
textarea:focus{border-color:var(--accent)}
button[type=submit]{background:var(--accent);color:#fff;border:none;border-radius:9px;padding:9px 18px;font-size:14px;font-weight:600;cursor:pointer}
button[type=submit]:hover{opacity:.88}
button[type=submit]:disabled{opacity:.4;cursor:not-allowed}
@media(max-width:620px){
  #sidebar{position:absolute;top:0;bottom:0;left:0;z-index:20;box-shadow:4px 0 20px #0008;width:0}
  #sidebar.open{width:min(260px,80vw)}
  #msgs{padding:10px}
  .bubble{font-size:13px}
  .mc{max-width:88%}
  form{padding:8px 10px}
}
</style>
</head>
<body>
<header>
  ${LOGO_TAG}
  <div class="hd-info">
    <div class="hd-sub" id="slabel">Trade Assistant</div>
  </div>
  <button class="hd-btn" id="hbtn">&#9776; History</button>
  <button class="hd-btn" id="nbtn">+ New Chat</button>
  <div id="st" title="ready"></div>
</header>
<div class="layout">
  <div id="sidebar">
    <div class="sb-head">Past Chats</div>
    <div id="sess-list"></div>
  </div>
  <div id="chat-pane">
    <div id="msgs"></div>
    <button id="sb-btn" title="Jump to bottom">&#8595;</button>
    <form id="form">
      <textarea id="inp" placeholder="Ask about products, tariffs, ports, compliance..." rows="1"></textarea>
      <button type="submit" id="btn">Send</button>
    </form>
  </div>
</div>
<script>
var KEY='a3f9e2b7c1d04e85f6a2c3d4e5f6a7b8',BRAIN='/webhook/aaziko-brain-ui';
var K_SID='az_sess',K_ALL='az_all_sess',K_MSG='az_msg_';
function ls(k){try{return localStorage.getItem(k);}catch(e){return null;}}
function lss(k,v){try{localStorage.setItem(k,v);}catch(e){}}
function lsj(k){try{var v=ls(k);return v?JSON.parse(v):[];}catch(e){return[];}}
function lssj(k,v){lss(k,JSON.stringify(v));}
function nts(){var d=new Date();return('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2);}
function fdt(iso){try{var d=new Date(iso);return d.toLocaleDateString([],{month:'short',day:'numeric'})+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});}catch(e){return '';}}
function eh(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

function md(raw){
  var s=eh(raw);
  s=s.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  s=s.replace(/\`([^\`]+)\`/g,'<code>$1</code>');
  s=s.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)]{1,300})\\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  s=s.replace(/(^|[ (])(https?:\\/\\/[^\\s<>"']{4,300})/g,'$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  var ls2=s.split('\\n'),out=[],ul=false,ol=false;
  for(var i=0;i<ls2.length;i++){
    var l=ls2[i],um=/^[-*] (.+)/.exec(l),om=/^\\d+\\. (.+)/.exec(l);
    if(um){if(ol){out.push('</ol>');ol=false;}if(!ul){out.push('<ul>');ul=true;}out.push('<li>'+um[1]+'</li>');}
    else if(om){if(ul){out.push('</ul>');ul=false;}if(!ol){out.push('<ol>');ol=true;}out.push('<li>'+om[1]+'</li>');}
    else{if(ul){out.push('</ul>');ul=false;}if(ol){out.push('</ol>');ol=false;}out.push(l);}
  }
  if(ul)out.push('</ul>');if(ol)out.push('</ol>');
  s=out.join('\\n').replace(/\\n\\n/g,'</p><p>').replace(/\\n/g,'<br>');
  return '<p>'+s+'</p>';
}

var SESSION,sidebarOpen=false;
var msgsEl=document.getElementById('msgs'),inp=document.getElementById('inp'),
    btn=document.getElementById('btn'),stEl=document.getElementById('st'),
    sbBtn=document.getElementById('sb-btn');

function setSt(v){stEl.className=v==='busy'?'busy':v==='err'?'err':'';stEl.title=v;}

msgsEl.addEventListener('scroll',function(){
  sbBtn.style.display=(msgsEl.scrollHeight-msgsEl.scrollTop-msgsEl.clientHeight>80)?'flex':'none';
});
sbBtn.addEventListener('click',function(){msgsEl.scrollTo({top:msgsEl.scrollHeight,behavior:'smooth'});});

function addBubble(text,role,typing,save,sts){
  var row=document.createElement('div');row.className='msg-row'+(role==='user'?' ur':'');
  var mc=document.createElement('div');mc.className='mc';
  var b=document.createElement('div');b.className='bubble '+(role==='err'?'err':role);
  b.setAttribute('data-raw',text);
  if(typing){b.innerHTML='<div class="td"><span></span><span></span><span></span></div>';}
  else if(role==='bot'||role==='err'){b.innerHTML=md(text);}
  else{b.textContent=text;}
  var tval=sts||nts();
  var ba=document.createElement('div');ba.className='ba';
  var tsSpan=document.createElement('span');tsSpan.className='ts';tsSpan.textContent=tval;ba.appendChild(tsSpan);
  if(role==='bot'){
    var cp=document.createElement('button');cp.className='cp';cp.textContent='Copy';
    cp.onclick=function(){
      var raw=b.getAttribute('data-raw')||b.textContent;
      function fb2(){var ta=document.createElement('textarea');ta.value=raw;ta.style.cssText='position:fixed;opacity:0';document.body.appendChild(ta);ta.select();try{document.execCommand('copy');}catch(e){}document.body.removeChild(ta);cp.textContent='✓';setTimeout(function(){cp.textContent='Copy';},1000);}
      if(navigator.clipboard){navigator.clipboard.writeText(raw).then(function(){cp.textContent='✓ Copied';cp.classList.add('ok');setTimeout(function(){cp.textContent='Copy';cp.classList.remove('ok');},1500);}).catch(fb2);}else{fb2();}
    };
    ba.appendChild(cp);
  }
  mc.appendChild(b);mc.appendChild(ba);
  if(role==='bot'||role==='err'){var av=document.createElement('div');av.className='av';av.textContent='A';row.appendChild(av);}
  row.appendChild(mc);msgsEl.appendChild(row);msgsEl.scrollTop=msgsEl.scrollHeight;
  if(save&&(role==='user'||role==='bot')){var arr=lsj(K_MSG+SESSION);arr.push({role:role,text:text,ts:tval});lssj(K_MSG+SESSION,arr);}
  return b;
}

function loadSession(id){
  SESSION=id;lss(K_SID,SESSION);msgsEl.innerHTML='';
  var saved=lsj(K_MSG+SESSION);
  if(!saved.length){
    addBubble('Hello! I am **Aaziko AI** — your trade research assistant.\\n\\nAsk me about:\\n- **HS codes** and tariff rates\\n- **Export markets** for your products\\n- **Buyers** importing specific products\\n- **Indian suppliers** on IndiaMART','bot',false,false);
  } else {
    saved.forEach(function(m){addBubble(m.text,m.role,false,false,m.ts);});
  }
  refreshLbl();highlightAct();
}
function upsertSess(firstMsg){
  var all=lsj(K_ALL);
  if(!all.find(function(s){return s.id===SESSION;})){all.unshift({id:SESSION,title:firstMsg,ts:new Date().toISOString()});lssj(K_ALL,all.slice(0,60));}
  renderSidebar();refreshLbl();
}
function delSess(id){
  var all=lsj(K_ALL).filter(function(s){return s.id!==id;});lssj(K_ALL,all);
  try{localStorage.removeItem(K_MSG+id);}catch(e){}
  if(id===SESSION){SESSION=all.length?all[0].id:('ui-'+Math.random().toString(36).slice(2,10));loadSession(SESSION);}
  renderSidebar();
}
function renameSess(id,title){
  if(!title.trim())return;
  var all=lsj(K_ALL),s=all.find(function(x){return x.id===id;});
  if(s){s.title=title.trim().slice(0,80);lssj(K_ALL,all);}
  renderSidebar();if(id===SESSION)refreshLbl();
}
function refreshLbl(){
  var all=lsj(K_ALL),cur=all.find(function(s){return s.id===SESSION;});
  document.getElementById('slabel').textContent=cur?cur.title.slice(0,42):'Trade Assistant';
}
function highlightAct(){document.querySelectorAll('.si').forEach(function(el){el.classList.toggle('active',el.getAttribute('data-id')===SESSION);});}
function renderSidebar(){
  var list=document.getElementById('sess-list'),all=lsj(K_ALL);
  if(!all.length){list.innerHTML='<div style="padding:14px;color:var(--muted);font-size:12px">No past chats yet</div>';return;}
  list.innerHTML=all.map(function(s){var a=s.id===SESSION?' active':'';return'<div class="si'+a+'" data-id="'+s.id+'"><div class="si-body"><div class="si-title" data-id="'+s.id+'" title="Double-click to rename">'+eh(s.title)+'</div><div class="si-date">'+fdt(s.ts)+'</div></div><button class="si-del" data-id="'+s.id+'" title="Delete">&#10005;</button></div>';}).join('');
  list.querySelectorAll('.si').forEach(function(el){el.addEventListener('click',function(e){if(e.target.classList.contains('si-del'))return;var id=this.getAttribute('data-id');if(id!==SESSION)loadSession(id);if(window.innerWidth<=620)toggleSb(false);else highlightAct();});});
  list.querySelectorAll('.si-del').forEach(function(b2){b2.addEventListener('click',function(e){e.stopPropagation();if(confirm('Delete this chat?'))delSess(this.getAttribute('data-id'));});});
  list.querySelectorAll('.si-title').forEach(function(el){el.addEventListener('dblclick',function(e){e.stopPropagation();var id=this.getAttribute('data-id'),cur=this.textContent,inp2=document.createElement('input');inp2.value=cur;inp2.style.cssText='width:100%;background:#0d1117;border:1px solid #2ea043;color:#e6edf3;border-radius:4px;padding:1px 5px;font-size:12px;outline:none';var self2=this;self2.replaceWith(inp2);inp2.focus();inp2.select();function commit(){renameSess(id,inp2.value);}inp2.addEventListener('blur',commit);inp2.addEventListener('keydown',function(e2){if(e2.key==='Enter'){e2.preventDefault();commit();}if(e2.key==='Escape'){renderSidebar();}});});});
}

/* sidebar toggle — state variable, no class-read */
function toggleSb(force){
  sidebarOpen=typeof force==='boolean'?force:!sidebarOpen;
  document.getElementById('sidebar').classList.toggle('open',sidebarOpen);
}

document.getElementById('hbtn').addEventListener('click',function(){toggleSb();});
document.getElementById('nbtn').addEventListener('click',function(){SESSION='ui-'+Math.random().toString(36).slice(2,10);loadSession(SESSION);renderSidebar();});

document.getElementById('form').addEventListener('submit',function(e){
  e.preventDefault();var text=inp.value.trim();if(!text)return;
  inp.value='';inp.style.height='';btn.disabled=true;setSt('busy');
  addBubble(text,'user',false,true);upsertSess(text);
  var tb=addBubble('','bot',true,false);
  fetch(BRAIN,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text,sessionId:SESSION,channel:'ui',secret:KEY})})
  .then(function(r){return r.json();})
  .then(function(j){
    var reply=j.reply||'(no reply)';tb.setAttribute('data-raw',reply);tb.innerHTML=md(reply);
    msgsEl.scrollTop=msgsEl.scrollHeight;
    var arr=lsj(K_MSG+SESSION);arr.push({role:'bot',text:reply,ts:nts()});lssj(K_MSG+SESSION,arr);
    setSt('ready');btn.disabled=false;inp.focus();
  })
  .catch(function(err){tb.className='bubble err';tb.textContent='Error: '+err.message;setSt('err');btn.disabled=false;});
});

inp.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();document.getElementById('form').dispatchEvent(new Event('submit'));}});
inp.addEventListener('input',function(){this.style.height='';this.style.height=Math.min(this.scrollHeight,120)+'px';});

(function(){SESSION=ls(K_SID)||('ui-'+Math.random().toString(36).slice(2,10));loadSession(SESSION);renderSidebar();})();
</script>
<style>#n8n-download-all-btn{display:none!important;visibility:hidden!important;pointer-events:none!important}</style>
<script>(function(){function rm(){var b=document.getElementById('n8n-download-all-btn');if(b)b.remove();}rm();var mo=new MutationObserver(rm);mo.observe(document.documentElement,{childList:true,subtree:true});})();</script>
</body>
</html>`;

console.log('HTML length:', NEW_HTML.length, 'chars (' + (NEW_HTML.length/1024).toFixed(0) + ' KB)');
const CHECKS = [
  ['az_sess',         'session key'],
  ['sidebarOpen',     'sidebar state var'],
  ['sidebar.*open|open.*sidebar', 'sidebar open class'],
  ['si-del',          'delete button'],
  ['dblclick',        'rename on dblclick'],
  ['Copy',            'copy button'],
  ['td.*span|span.*td','typing dots'],
  ['sb-btn',          'scroll button'],
  ['function md',     'markdown renderer'],
  ['navigator.clipboard','clipboard API'],
  ['logo-img|class.*logo','logo element'],
];
let ok = true;
CHECKS.forEach(function([pat, label]) {
  if (!new RegExp(pat).test(NEW_HTML)) { console.log('ERR: missing', label); ok = false; }
  else console.log('OK:', label);
});
if (!ok) process.exit(1);
console.log('\n✅ All checks pass');
if (!WRITE) { console.log('(--write to deploy)'); process.exit(0); }

(async () => {
  const wf = await getWf(WF_ID);
  fs.writeFileSync(path.join(BACKUP_DIR, WF_ID + '_before_ui_v3.json'), JSON.stringify(wf, null, 2), 'utf8');
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
  const live = s2 && s2.parameters.responseBody.includes('sidebarOpen');
  console.log((live ? '✅' : '❌') + ' Read-back: UI v3 live');
  if (!live) process.exit(1);
  console.log('URL: https://ai.cgpe.in/webhook/aaziko-ui');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
