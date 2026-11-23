'use strict';
/*
 * Aaziko UI v4 — full brand redesign
 *   1. Dark + Light theme toggle (logo colors throughout)
 *   2. Cursor animation: cycles logo colors on focus, solid green on typing
 *   3. Focus border animation with logo colors
 *   4. Header rainbow accent line from logo colors
 *   5. All v3 features (logo, session history, copy, rename/delete, markdown)
 *
 * node aaziko/brain/deploy/update-ui-v4.js          -- verify
 * node aaziko/brain/deploy/update-ui-v4.js --write  -- deploy
 */
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate, RROOT } = require('../../../scripts/lib/n8n-req');
const BACKUP_DIR = path.resolve(RROOT, 'backups');
const WF_ID = 'bL0JQ2UTk4nM5rIJ';
const WRITE = process.argv.includes('--write');

// ── Logo base64 ───────────────────────────────────────────────────────────
let LOGO_B64 = '';
const B64_CACHE = path.join(process.env.TEMP || 'C:\\Users\\Inet\\AppData\\Local\\Temp', 'aaziko_logo.b64');
if (fs.existsSync(B64_CACHE)) {
  LOGO_B64 = fs.readFileSync(B64_CACHE, 'utf8').trim();
  console.log('Logo loaded (' + (LOGO_B64.length/1024).toFixed(0) + ' KB b64)');
} else {
  console.log('⚠ Logo cache missing — run update-ui-v3.js first to cache it, or place logo PNG at TEMP/aaziko_logo.b64');
}

const LOGO_TAG = LOGO_B64
  ? `<div id="logo-wrap"><img id="logo-img" src="data:image/png;base64,${LOGO_B64}" alt="Aaziko"></div>`
  : `<div id="logo-wrap"><div class="logo-fb">A</div></div>`;

// ── HTML ──────────────────────────────────────────────────────────────────
const NEW_HTML = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aaziko AI</title>
<script>
(function(){var t=localStorage.getItem('az_theme')||'dark';document.documentElement.setAttribute('data-theme',t);})();
<\/script>
<style>
/* ── BRAND COLORS (Aaziko logo) ─────────────────────────── */
:root{
  --g:#2ba64f; --o:#f7941d; --r:#e31e24; --b:#00aeef;
}
/* ── DARK THEME ─────────────────────────────────────────── */
html[data-theme="dark"]{
  --bg:#0d1117; --panel:#161b22; --panel2:#1c2128;
  --border:#30363d; --text:#e6edf3; --muted:#8b949e;
  --user-bg:#1a4f72; --bot-bg:#1c2128; --input-bg:#0d1117;
  --logo-bg:#fff; --logo-sh:none;
  --link:#00aeef;
}
/* ── LIGHT THEME ────────────────────────────────────────── */
html[data-theme="light"]{
  --bg:#f4f6f8; --panel:#ffffff; --panel2:#f0f2f4;
  --border:#dde1e6; --text:#1a1d21; --muted:#6b7280;
  --user-bg:#1a4f72; --bot-bg:#ffffff; --input-bg:#ffffff;
  --logo-bg:#fff; --logo-sh:0 1px 6px rgba(0,0,0,.12);
  --link:#0969da;
}
/* ── RESET ───────────────────────────────────────────────── */
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);height:100vh;display:flex;flex-direction:column;overflow:hidden;transition:background .25s,color .25s}
/* ── HEADER ─────────────────────────────────────────────── */
header{
  padding:9px 14px;background:var(--panel);border-bottom:1px solid var(--border);
  display:flex;align-items:center;gap:10px;flex:0 0 auto;z-index:10;
  position:relative;transition:background .25s,border-color .25s;
}
/* Rainbow stripe from logo colors */
header::after{
  content:'';position:absolute;bottom:-2px;left:0;right:0;height:2px;
  background:linear-gradient(90deg,var(--g) 0%,var(--o) 33%,var(--r) 66%,var(--b) 100%);
  border-radius:0 0 2px 2px;
}
/* logo */
#logo-wrap{
  flex:0 0 auto;border-radius:7px;overflow:hidden;
  background:var(--logo-bg);box-shadow:var(--logo-sh);
  display:flex;align-items:center;padding:3px 8px;
}
#logo-img{height:32px;width:auto;display:block}
.logo-fb{width:32px;height:32px;border-radius:7px;background:linear-gradient(135deg,var(--g),#1a7f37);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;color:#fff}
.hd-info{flex:1;min-width:0;overflow:hidden}
.hd-sub{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hd-btn{
  background:transparent;border:1px solid var(--border);border-radius:7px;
  color:var(--text);padding:5px 11px;font-size:12px;cursor:pointer;
  white-space:nowrap;flex:0 0 auto;transition:all .15s;
}
.hd-btn:hover{border-color:var(--g);color:var(--g)}
#tbtn{font-size:16px;padding:4px 9px;border-color:var(--border)}
#tbtn:hover{border-color:var(--o);color:var(--o)}
/* status dot */
#st{width:9px;height:9px;border-radius:50%;background:var(--g);flex:0 0 auto;box-shadow:0 0 7px color-mix(in srgb,var(--g) 60%,transparent)}
#st.busy{background:var(--o);box-shadow:0 0 7px color-mix(in srgb,var(--o) 60%,transparent);animation:pulse 1s ease-in-out infinite}
#st.err{background:var(--r);box-shadow:0 0 7px color-mix(in srgb,var(--r) 60%,transparent)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
/* ── LAYOUT ──────────────────────────────────────────────── */
.layout{flex:1;display:flex;overflow:hidden;position:relative}
/* ── SIDEBAR ─────────────────────────────────────────────── */
#sidebar{
  width:0;overflow:hidden;background:var(--panel);flex:none;
  border-right:1px solid transparent;
  display:flex;flex-direction:column;
  transition:width .22s ease,border-color .22s ease,background .25s;
}
#sidebar.open{width:260px;border-right-color:var(--border)}
.sb-head{
  padding:11px 14px;font-size:11px;font-weight:700;color:var(--muted);
  letter-spacing:.9px;text-transform:uppercase;border-bottom:1px solid var(--border);
  flex:0 0 auto;white-space:nowrap;
}
#sess-list{flex:1;overflow-y:auto;padding:4px 0;min-width:260px}
.si{
  padding:9px 12px;cursor:pointer;border-left:3px solid transparent;
  display:flex;align-items:center;gap:6px;transition:background .12s;
}
.si:hover{background:rgba(43,166,79,.07)}
.si.active{background:rgba(43,166,79,.12);border-left-color:var(--g)}
.si-body{flex:1;min-width:0}
.si-title{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)}
.si-date{font-size:10px;color:var(--muted);margin-top:2px}
.si-del{opacity:0;background:none;border:none;color:var(--muted);cursor:pointer;padding:2px 5px;font-size:12px;border-radius:4px;flex:0 0 auto;line-height:1}
.si:hover .si-del{opacity:1}
.si-del:hover{color:var(--r);background:rgba(227,30,36,.12)}
/* ── CHAT PANE ───────────────────────────────────────────── */
#chat-pane{flex:1;display:flex;flex-direction:column;overflow:hidden;position:relative;min-width:0}
#msgs{flex:1;overflow-y:auto;padding:18px 16px;display:flex;flex-direction:column;gap:14px}
/* message rows */
.msg-row{display:flex;gap:9px;align-items:flex-start}
.msg-row.ur{flex-direction:row-reverse}
/* avatar */
.av{
  width:30px;height:30px;border-radius:9px;flex:0 0 auto;margin-top:1px;
  background:linear-gradient(135deg,var(--g),#1a7f37);
  display:flex;align-items:center;justify-content:center;
  font-weight:800;font-size:13px;color:#fff;
}
/* message column */
.mc{display:flex;flex-direction:column;max-width:76%;gap:3px}
.msg-row.ur .mc{align-items:flex-end}
/* bubbles */
.bubble{padding:11px 14px;border-radius:14px;line-height:1.65;font-size:14px;word-break:break-word;transition:background .25s}
.bubble.user{
  background:var(--user-bg);color:#fff;
  border-bottom-right-radius:4px;white-space:pre-wrap;
}
.bubble.bot{
  background:var(--bot-bg);color:var(--text);
  border:1px solid var(--border);border-bottom-left-radius:4px;
}
.bubble.bot a{color:var(--link);text-decoration:none}
.bubble.bot a:hover{text-decoration:underline}
.bubble.bot code{
  background:var(--bg);border:1px solid var(--border);
  border-radius:4px;padding:1px 5px;font-size:12px;font-family:monospace;
}
.bubble.bot strong{color:var(--text);font-weight:700}
.bubble.bot ul,.bubble.bot ol{margin:5px 0 5px 20px}
.bubble.bot li{margin-bottom:3px}
.bubble.bot p{margin-bottom:7px}
.bubble.bot p:last-child{margin-bottom:0}
.bubble.err{border:1px solid var(--r)}
html[data-theme="dark"] .bubble.err{background:#3d1a1a;color:#ff7b7b}
html[data-theme="light"] .bubble.err{background:#fde8e8;color:#c0392b}
/* bubble actions (hover) */
.ba{display:flex;align-items:center;gap:7px;opacity:0;transition:opacity .15s;min-height:18px}
.msg-row:hover .ba{opacity:1}
.ts{font-size:10px;color:var(--muted)}
.cp{
  background:transparent;border:1px solid var(--border);border-radius:5px;
  color:var(--muted);padding:1px 8px;font-size:11px;cursor:pointer;transition:all .12s;
}
.cp:hover{border-color:var(--b);color:var(--b)}
.cp.ok{border-color:var(--g);color:var(--g)}
/* typing dots */
.td{display:inline-flex;gap:5px;align-items:center;padding:4px 0}
.td span{display:block;width:7px;height:7px;border-radius:50%;background:var(--muted);animation:tda .9s ease-in-out infinite}
.td span:nth-child(2){animation-delay:.18s}
.td span:nth-child(3){animation-delay:.36s}
@keyframes tda{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-7px);opacity:1}}
/* scroll button */
#sb-btn{
  position:absolute;bottom:78px;right:14px;width:36px;height:36px;
  border-radius:50%;background:var(--panel);border:1px solid var(--border);
  color:var(--muted);display:none;align-items:center;justify-content:center;
  cursor:pointer;font-size:17px;z-index:5;box-shadow:0 2px 10px rgba(0,0,0,.2);
  transition:border-color .15s,color .15s;
}
#sb-btn:hover{border-color:var(--g);color:var(--g)}
/* ── PREFS MODAL ─────────────────────────────────────────── */
#pref-modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.58);z-index:200;align-items:center;justify-content:center;padding:16px}
#pref-modal.open{display:flex}
#pref-box{background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:22px 24px;width:min(500px,100%);display:flex;flex-direction:column;gap:14px;box-shadow:0 12px 48px rgba(0,0,0,.45)}
.pref-head{display:flex;align-items:center;justify-content:space-between}
.pref-head strong{font-size:15px;color:var(--text)}
.pref-x{background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer;padding:0 4px;line-height:1;border-radius:5px}
.pref-x:hover{color:var(--r);background:rgba(227,30,36,.1)}
.pref-hint{font-size:12px;color:var(--muted);line-height:1.6}
.pref-chips{display:flex;flex-wrap:wrap;gap:6px}
.pref-chip{background:transparent;border:1px solid var(--border);border-radius:20px;color:var(--muted);font-size:11px;padding:4px 11px;cursor:pointer;transition:all .12s;white-space:nowrap}
.pref-chip:hover{border-color:var(--g);color:var(--g);background:rgba(43,166,79,.07)}
#pref-inp{background:var(--input-bg);border:1.5px solid var(--border);border-radius:10px;color:var(--text);padding:11px 13px;font-size:13px;resize:vertical;outline:none;font-family:inherit;line-height:1.65;min-height:120px;width:100%;transition:border-color .15s;caret-color:var(--g)}
#pref-inp:focus{border-color:var(--g);box-shadow:0 0 0 2px rgba(43,166,79,.15)}
#pref-inp::placeholder{color:var(--muted)}
.pref-btns{display:flex;gap:9px;justify-content:flex-end;margin-top:4px}
#pref-save{background:var(--g);color:#fff;border:none;border-radius:9px;padding:9px 24px;font-size:13px;font-weight:700;cursor:pointer;transition:opacity .15s}
#pref-save:hover{opacity:.85}
#pref-cl{background:transparent;border:1px solid var(--border);border-radius:9px;color:var(--muted);padding:9px 18px;font-size:13px;cursor:pointer;transition:all .12s}
#pref-cl:hover{border-color:var(--muted);color:var(--text)}
/* Green dot indicator on Prefs btn when rules are set */
#pbtn.has-prefs{border-color:var(--g);color:var(--g);position:relative}
#pbtn.has-prefs::after{content:'';position:absolute;top:4px;right:4px;width:7px;height:7px;border-radius:50%;background:var(--g);border:2px solid var(--panel)}
/* ── FORM ────────────────────────────────────────────────── */
form{padding:12px 14px;background:var(--panel);border-top:1px solid var(--border);display:flex;gap:9px;flex:0 0 auto;transition:background .25s,border-color .25s;position:relative}
/* Cursor animation: cycles logo colors on focus */
@keyframes fc{
  0%,100%{border-color:var(--g);box-shadow:0 0 0 2px rgba(43,166,79,.18)}
  25%    {border-color:var(--o);box-shadow:0 0 0 2px rgba(247,148,29,.18)}
  50%    {border-color:var(--r);box-shadow:0 0 0 2px rgba(227,30,36,.18)}
  75%    {border-color:var(--b);box-shadow:0 0 0 2px rgba(0,174,239,.18)}
}
/* Fake cursor */
#fcc{position:absolute;width:3px;border-radius:2px;pointer-events:none;display:none;z-index:9;top:0;left:0}
#fcc.on{display:block}
@keyframes fcc-a{
  0%,100%{background:var(--g)}25%{background:var(--o)}50%{background:var(--r)}75%{background:var(--b)}
}
#fcc.on:not(.typing){animation:fcc-a 2.4s linear infinite}
#fcc.on.typing{background:var(--g);animation:none}
textarea{
  flex:1;background:var(--input-bg);border:1.5px solid var(--border);border-radius:11px;
  color:var(--text);padding:10px 14px;font-size:14px;resize:none;outline:none;
  font-family:inherit;line-height:1.55;min-height:44px;max-height:130px;
  transition:background .25s,border-color .15s;caret-color:transparent;
}
textarea::placeholder{color:var(--muted)}
/* Focus: cycle logo colors on border + cursor */
textarea:focus{animation:fc 2.4s linear infinite}
/* Typing: solid green only */
textarea:focus.typing{
  animation:none;
  border-color:var(--g);box-shadow:0 0 0 2px rgba(43,166,79,.2);
}
/* Send button — green accent */
button[type=submit]{
  background:var(--g);color:#fff;border:none;border-radius:11px;
  padding:10px 20px;font-size:14px;font-weight:700;cursor:pointer;
  transition:opacity .15s,background .15s;white-space:nowrap;
}
button[type=submit]:hover{opacity:.88}
button[type=submit]:disabled{opacity:.4;cursor:not-allowed}
/* ── EMPTY STATE ─────────────────────────────────────────── */
#es{display:none;flex-direction:column;align-items:center;justify-content:center;flex:1;text-align:center;padding:32px 20px;gap:16px;min-height:200px}
#es-icon{width:68px;height:68px;border-radius:18px;background:linear-gradient(135deg,var(--g) 0%,#1a7f37 100%);display:flex;align-items:center;justify-content:center;font-weight:900;font-size:26px;color:#fff;letter-spacing:-1px;box-shadow:0 4px 24px rgba(43,166,79,.28)}
#es h2{font-size:21px;font-weight:800;color:var(--text);margin:0}
#es p{font-size:13px;color:var(--muted);margin:0;max-width:340px;line-height:1.55}
.es-qs{display:flex;flex-direction:column;gap:8px;width:100%;max-width:460px;margin-top:6px}
.es-q{background:var(--bot-bg);border:1px solid var(--border);border-radius:11px;color:var(--text);padding:11px 16px;font-size:13px;cursor:pointer;text-align:left;transition:all .15s;line-height:1.4;font-family:inherit}
.es-q:hover{border-color:var(--g);background:rgba(43,166,79,.05);color:var(--g)}
.es-q .arr{color:var(--g);font-weight:700;margin-right:6px}
/* ── MOBILE ──────────────────────────────────────────────── */
@media(max-width:620px){
  #sidebar{position:absolute;top:0;bottom:0;left:0;z-index:20;box-shadow:4px 0 24px rgba(0,0,0,.35);width:0}
  #sidebar.open{width:min(260px,82vw)}
  #msgs{padding:12px 10px}
  .bubble{font-size:13px}
  .mc{max-width:88%}
  form{padding:9px 10px}
  /* compact header on mobile */
  .bl{display:none}
  header{gap:5px;padding:7px 10px}
  .hd-btn{padding:5px 9px;font-size:12px}
  #tbtn{padding:4px 7px}
  /* always show delete on touch */
  .si-del{opacity:.65}
}
#cc{font-size:11px;color:var(--muted);text-align:right;padding:1px 4px 0;line-height:1;min-width:28px;align-self:flex-end;transition:color .2s;pointer-events:none}
#cc.warn{color:var(--o)}
#cc.over{color:var(--r);font-weight:700}
pre{background:var(--input-bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px;overflow-x:auto;margin:4px 0;font-size:12.5px}
pre code.hljs{background:transparent;padding:0;border-radius:0;font-size:inherit}
pre code:not(.hljs){font-family:monospace;white-space:pre}
</style>
<link rel="stylesheet" id="hljs-css" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"><\/script>
</head>
<body>
<header>
  ${LOGO_TAG}
  <div class="hd-info">
    <div class="hd-sub" id="slabel">Trade Assistant</div>
  </div>
  <button class="hd-btn" id="tbtn" title="Toggle theme">&#9790;</button>
  <button class="hd-btn" id="pbtn" title="Personalize">&#9881;<span class="bl"> Prefs</span></button>
  <button class="hd-btn" id="hbtn">&#9776;<span class="bl"> History</span></button>
  <button class="hd-btn" id="nbtn">+<span class="bl"> New Chat</span></button>
  <div id="st" title="ready"></div>
</header>
<div class="layout">
  <div id="sidebar">
    <div class="sb-head">Past Chats</div>
    <div id="sess-list"></div>
  </div>
  <div id="chat-pane">
    <div id="es">
      <div id="es-icon">Az</div>
      <h2>Aaziko Trade AI</h2>
      <p>Your research assistant for international trade — tariffs, buyers, compliance, HS codes &amp; more</p>
      <div class="es-qs">
        <button class="es-q"><span class="arr">&#8594;</span>Cotton HS 5201 — tariff for India to USA?</button>
        <button class="es-q"><span class="arr">&#8594;</span>Top buyers for leather jackets worldwide</button>
        <button class="es-q"><span class="arr">&#8594;</span>Documents needed to export spices India &#8594; Germany</button>
        <button class="es-q"><span class="arr">&#8594;</span>What HS code for frozen shrimp?</button>
      </div>
    </div>
    <div id="msgs"></div>
    <button id="sb-btn" title="Jump to bottom">&#8595;</button>
    <form id="form">
      <textarea id="inp" placeholder="Ask about products, tariffs, ports, compliance..." rows="1"></textarea>
      <div id="cc"></div>
      <button type="submit" id="btn">Send</button>
    </form>
  </div>
</div>
<script>
var KEY='a3f9e2b7c1d04e85f6a2c3d4e5f6a7b8',BRAIN='/webhook/aaziko-brain-ui';
var K_SID='az_sess',K_ALL='az_all_sess',K_MSG='az_msg_',K_THEME='az_theme';
function ls(k){try{return localStorage.getItem(k);}catch(e){return null;}}
function lss(k,v){try{localStorage.setItem(k,v);}catch(e){}}
function lsj(k){try{var v=ls(k);return v?JSON.parse(v):[];}catch(e){return[];}}
function lssj(k,v){lss(k,JSON.stringify(v));}
function nts(){var d=new Date();return('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2);}
function fdt(iso){try{var d=new Date(iso);return d.toLocaleDateString([],{month:'short',day:'numeric'})+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});}catch(e){return '';}}
function eh(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

/* markdown */
function md(raw){
  var BSEP=String.fromCharCode(1),blocks=[];
  var r=raw.replace(/\`\`\`([\\w]*)\\n?([\\s\\S]*?)\`\`\`/g,function(_,lang,code){
    blocks.push('<pre><code class="language-'+(lang||'plaintext')+'">'+eh(code.trim())+'</code></pre>');
    return BSEP+'B'+(blocks.length-1)+BSEP;
  });
  var s=eh(r);
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
  if(blocks.length){var pts=s.split(BSEP);s=pts.map(function(p,i){if(i%2===1&&p[0]==='B'){return blocks[+p.slice(1)]||p;}return p;}).join('');}
  if(window.hljs)setTimeout(function(){document.querySelectorAll('pre code:not(.hljs)').forEach(function(el){window.hljs.highlightElement(el);});},0);
  return '<p>'+s+'</p>';
}

/* theme */
var currentTheme=ls(K_THEME)||'dark';
function applyTheme(t){
  currentTheme=t;document.documentElement.setAttribute('data-theme',t);lss(K_THEME,t);
  document.getElementById('tbtn').textContent=t==='dark'?'\u2600':'\u263e';
  var hc=document.getElementById('hljs-css');
  if(hc)hc.href='https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/'+(t==='dark'?'github-dark':'github')+'.min.css';
}
applyTheme(currentTheme);
document.getElementById('tbtn').addEventListener('click',function(){applyTheme(currentTheme==='dark'?'light':'dark');});

/* refs */
var SESSION,sidebarOpen=false;
var msgsEl=document.getElementById('msgs'),inp=document.getElementById('inp'),
    btn=document.getElementById('btn'),stEl=document.getElementById('st'),sbBtn=document.getElementById('sb-btn');

function setSt(v){stEl.className=v==='busy'?'busy':v==='err'?'err':'';stEl.title=v;}

/* scroll button */
msgsEl.addEventListener('scroll',function(){sbBtn.style.display=(msgsEl.scrollHeight-msgsEl.scrollTop-msgsEl.clientHeight>80)?'flex':'none';});
sbBtn.addEventListener('click',function(){msgsEl.scrollTo({top:msgsEl.scrollHeight,behavior:'smooth'});});

/* cursor: add .typing on input, remove after pause */
var typingTimer;
inp.addEventListener('input',function(){
  this.classList.add('typing');
  if(window._fcc)window._fcc.classList.add('typing');
  clearTimeout(typingTimer);
  typingTimer=setTimeout(function(){inp.classList.remove('typing');if(window._fcc)window._fcc.classList.remove('typing');},800);
});

/* add bubble */
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
      function fb2(){var ta=document.createElement('textarea');ta.value=raw;ta.style.cssText='position:fixed;opacity:0';document.body.appendChild(ta);ta.select();try{document.execCommand('copy');}catch(e){}document.body.removeChild(ta);cp.textContent='\u2713';setTimeout(function(){cp.textContent='Copy';},1000);}
      if(navigator.clipboard){navigator.clipboard.writeText(raw).then(function(){cp.textContent='\u2713 Copied';cp.classList.add('ok');setTimeout(function(){cp.textContent='Copy';cp.classList.remove('ok');},1500);}).catch(fb2);}else{fb2();}
    };
    ba.appendChild(cp);
  }
  mc.appendChild(b);mc.appendChild(ba);
  if(role==='bot'||role==='err'){var av=document.createElement('div');av.className='av';av.textContent='A';row.appendChild(av);}
  row.appendChild(mc);msgsEl.appendChild(row);msgsEl.scrollTop=msgsEl.scrollHeight;
  if(save&&(role==='user'||role==='bot')){var arr=lsj(K_MSG+SESSION);arr.push({role:role,text:text,ts:tval});lssj(K_MSG+SESSION,arr);}
  return b;
}

/* session management */
function showEmpty(){var e=document.getElementById('es');if(e)e.style.display='flex';msgsEl.style.display='none';}
function showMsgs(){var e=document.getElementById('es');if(e)e.style.display='none';msgsEl.style.display='flex';}
function loadSession(id){
  SESSION=id;lss(K_SID,SESSION);msgsEl.innerHTML='';
  var saved=lsj(K_MSG+SESSION);
  if(!saved.length){showEmpty();}
  else{showMsgs();saved.forEach(function(m){addBubble(m.text,m.role,false,false,m.ts);});}
  refreshLbl();highlightAct();
}
/* Empty state chip clicks \u2014 event delegation (chips are after script tag) */
document.addEventListener('click',function(e){
  var q=e.target.closest('.es-q');if(!q)return;
  var text=q.textContent.replace(/^\s*\u2192\s*/,'').trim();
  inp.value=text;inp.style.height='';inp.style.height=Math.min(inp.scrollHeight,130)+'px';
  inp.focus();
  document.getElementById('form').dispatchEvent(new Event('submit'));
});
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
  list.querySelectorAll('.si-title').forEach(function(el){el.addEventListener('dblclick',function(e){e.stopPropagation();var id=this.getAttribute('data-id'),cur=this.textContent,inp2=document.createElement('input');inp2.value=cur;inp2.style.cssText='width:100%;background:var(--input-bg);border:1px solid var(--g);color:var(--text);border-radius:4px;padding:1px 5px;font-size:12px;outline:none';var self2=this;self2.replaceWith(inp2);inp2.focus();inp2.select();function commit(){renameSess(id,inp2.value);}inp2.addEventListener('blur',commit);inp2.addEventListener('keydown',function(e2){if(e2.key==='Enter'){e2.preventDefault();commit();}if(e2.key==='Escape'){renderSidebar();}});});});
}

function toggleSb(force){
  sidebarOpen=typeof force==='boolean'?force:!sidebarOpen;
  document.getElementById('sidebar').classList.toggle('open',sidebarOpen);
}

document.getElementById('hbtn').addEventListener('click',function(){toggleSb();});
document.getElementById('nbtn').addEventListener('click',function(){SESSION='ui-'+Math.random().toString(36).slice(2,10);loadSession(SESSION);renderSidebar();});

/* send */
document.getElementById('form').addEventListener('submit',function(e){
  e.preventDefault();var text=inp.value.trim();if(!text)return;
  inp.value='';inp.style.height='';btn.disabled=true;setSt('busy');
  showMsgs();document.title='Thinking… | Aaziko AI';
  addBubble(text,'user',false,true);upsertSess(text);autoPrefs(text);
  var tb=addBubble('','bot',true,false);
  fetch(BRAIN,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text,sessionId:SESSION,channel:'ui',secret:KEY,userPrefs:ls('az_prefs')||''})})
  .then(function(r){return r.json();})
  .then(function(j){
    var reply=j.reply||'(no reply)';tb.setAttribute('data-raw',reply);tb.innerHTML=md(reply);
    msgsEl.scrollTop=msgsEl.scrollHeight;
    var arr=lsj(K_MSG+SESSION);arr.push({role:'bot',text:reply,ts:nts()});lssj(K_MSG+SESSION,arr);
    setSt('ready');btn.disabled=false;inp.focus();document.title='Aaziko AI';
  })
  .catch(function(err){
    tb.className='bubble err';
    tb.innerHTML='<div>'+eh(err.message)+'</div><div style="font-size:11px;margin-top:5px;color:#ff9f9f">Your message was restored below — press Send to retry.</div>';
    inp.value=text;inp.style.height='';inp.style.height=Math.min(inp.scrollHeight,130)+'px';
    setSt('err');btn.disabled=false;document.title='Aaziko AI';
    setTimeout(function(){if(stEl.className==='err')setSt('ready');},20000);
  });
});

inp.addEventListener('keydown',function(e){if(e.key==='Enter'&&(e.ctrlKey||!e.shiftKey)){e.preventDefault();document.getElementById('form').dispatchEvent(new Event('submit'));}});
inp.addEventListener('input',function(){this.style.height='';this.style.height=Math.min(this.scrollHeight,130)+'px';var cc=document.getElementById('cc');if(cc){var n=this.value.length;cc.textContent=n>0?n:'';cc.className=n>1800?'over':n>1400?'warn':'';}});

(function(){SESSION=ls(K_SID)||('ui-'+Math.random().toString(36).slice(2,10));loadSession(SESSION);renderSidebar();})();
/* placeholder rotation */
(function(){var ph=['Ask about HS codes, tariffs, duties...','Find export markets for your product...','Check import requirements for any country...','Trade agreements & FTA concessions...','Port, shipping docs, Incoterms help...','Custom duty on leather, textile, machinery...'];var pi=0;setInterval(function(){if(document.activeElement!==inp&&!inp.value){pi=(pi+1)%ph.length;inp.placeholder=ph[pi];}},3000);})();

/* Prefs modal — init after DOM (modal div is after this script tag) */
function _syncPrefBtn(){
  var has=!!(ls('az_prefs')||'').trim();
  var pb=document.getElementById('pbtn');
  if(pb)pb.classList.toggle('has-prefs',has);
}
setTimeout(function(){
  function openP(){
    var m=document.getElementById('pref-modal');if(!m)return;
    m.classList.add('open');
    document.getElementById('pref-inp').value=ls('az_prefs')||'';
  }
  function closeP(){var m=document.getElementById('pref-modal');if(m)m.classList.remove('open');}
  var pb=document.getElementById('pbtn'),px=document.getElementById('pref-x'),
      pcl=document.getElementById('pref-cl'),psave=document.getElementById('pref-save'),
      pm=document.getElementById('pref-modal');
  if(pb)pb.addEventListener('click',openP);
  if(px)px.addEventListener('click',closeP);
  if(pcl)pcl.addEventListener('click',closeP);
  if(pm)pm.addEventListener('click',function(e){if(e.target===this)closeP();});
  if(psave)psave.addEventListener('click',function(){
    lss('az_prefs',document.getElementById('pref-inp').value.trim());
    closeP();_syncPrefBtn();
  });
  var pclr=document.getElementById('pref-clear');
  if(pclr)pclr.addEventListener('click',function(){
    document.getElementById('pref-inp').value='';
    lss('az_prefs','');lss('az_ap','');
    _syncPrefBtn();closeP();
  });
  document.querySelectorAll('.pref-chip').forEach(function(c){
    c.addEventListener('click',function(){
      var ta=document.getElementById('pref-inp'),cur=ta.value.trim(),rule=this.getAttribute('data-rule');
      ta.value=cur?(cur+'\\n'+rule):rule;ta.focus();
    });
  });
  _syncPrefBtn();
}, 80);

/* Auto-detect user prefs from first message (language + name) */
function autoPrefs(text){
  if((ls('az_prefs')||'').trim()||ls('az_ap')) return; // already set or already auto-done
  var rules=[];
  // Language detection via Unicode ranges
  if(/[ऀ-ॿ]{3,}/.test(text))      rules.push('Talk to me in Hindi only.');
  else if(/[઀-૿]{3,}/.test(text)) rules.push('Talk to me in Gujarati only.');
  // Name detection: "I am X", "mera naam X hai", "call me X", "main X hoon"
  var nm=/(?:call me|i am|i'm|mera naam|main|my name is)\s+([A-Za-z][a-zA-Z]{2,12})/i.exec(text);
  if(nm) rules.push('My name is '+nm[1]+'. Call me '+nm[1]+'.');
  if(!rules.length) return;
  var val=rules.join('\\n');
  lss('az_prefs',val);lss('az_ap','1');
  _syncPrefBtn();
  // Toast notification
  var t=document.createElement('div');
  t.style.cssText='position:fixed;bottom:85px;left:50%;transform:translateX(-50%);background:var(--g);color:#fff;padding:9px 20px;border-radius:20px;font-size:12px;z-index:999;box-shadow:0 4px 16px rgba(0,0,0,.3);white-space:nowrap';
  t.textContent='✓ Auto-prefs: '+rules[0];
  document.body.appendChild(t);
  setTimeout(function(){t.style.transition='opacity .8s';t.style.opacity='0';setTimeout(function(){t.remove();},900);},3000);
}

/* Fake cursor — JS-driven, works in all browsers */
(function(){
  var fc=document.createElement('div');fc.id='fcc';
  document.getElementById('form').appendChild(fc);
  window._fcc=fc;

  var _md=document.createElement('div');
  _md.style.cssText='position:absolute;visibility:hidden;top:-9999px;left:-9999px;white-space:pre-wrap;';
  document.body.appendChild(_md);
  var _mdSp=document.createElement('span');_mdSp.textContent='​';_md.appendChild(_mdSp);

  function mirror(ta,pos){
    var cs=window.getComputedStyle(ta);
    ['fontFamily','fontSize','fontWeight','lineHeight',
     'paddingTop','paddingLeft','paddingRight','paddingBottom',
     'wordBreak','overflowWrap'].forEach(function(p){_md.style[p]=cs[p];});
    _md.style.width=ta.offsetWidth+'px';
    _md.textContent=ta.value.substring(0,pos);
    _md.appendChild(_mdSp);
    var tar=ta.getBoundingClientRect(),sr=_mdSp.getBoundingClientRect();
    return{x:sr.left-tar.left,y:sr.top-tar.top};
  }

  function upd(){
    if(document.activeElement!==inp){fc.classList.remove('on');return;}
    try{
      var p=mirror(inp,inp.selectionStart||0);
      var lh=parseFloat(window.getComputedStyle(inp).lineHeight)||20;
      var iTop=inp.offsetTop,iLeft=inp.offsetLeft;
      fc.style.height=lh+'px';
      fc.style.top=(iTop+p.y-inp.scrollTop)+'px';
      fc.style.left=(iLeft+p.x)+'px';
      fc.classList.add('on');
    }catch(e){fc.classList.remove('on');}
  }

  inp.addEventListener('focus',function(){setTimeout(upd,20);});
  inp.addEventListener('blur',function(){fc.classList.remove('on');});
  inp.addEventListener('input',upd);
  inp.addEventListener('keyup',upd);
  inp.addEventListener('click',upd);
  document.addEventListener('selectionchange',function(){if(document.activeElement===inp)upd();});
})();
<\/script>
<div id="pref-modal">
  <div id="pref-box">
    <div class="pref-head">
      <strong>&#9881; Personalize Aaziko AI</strong>
      <button class="pref-x" id="pref-x">&times;</button>
    </div>
    <div class="pref-hint">Set your personal rules — language, name, reply style. Aaziko will follow these in every conversation.</div>
    <div class="pref-chips">
      <span style="font-size:11px;color:var(--muted);align-self:center">Quick add:</span>
      <button class="pref-chip" data-rule="Talk to me in Hindi only.">Hindi only</button>
      <button class="pref-chip" data-rule="Talk to me in Gujarati only.">Gujarati only</button>
      <button class="pref-chip" data-rule="Talk to me in English only.">English only</button>
      <button class="pref-chip" data-rule="Always be concise and direct.">Be concise</button>
      <button class="pref-chip" data-rule="Always reply in bullet points.">Bullet points</button>
      <button class="pref-chip" data-rule="Explain things simply, avoid jargon.">Simple language</button>
    </div>
    <textarea id="pref-inp" placeholder="Type your custom rules here, one per line.&#10;&#10;Examples:&#10;Talk to me in Hindi only&#10;Call me Ravi&#10;Always be concise&#10;When I ask about tariffs, give me India-specific info"></textarea>
    <div class="pref-btns">
      <button id="pref-clear" style="margin-right:auto;color:var(--r);border:1px solid var(--r);background:transparent;border-radius:9px;padding:9px 14px;font-size:12px;cursor:pointer">Clear All</button>
      <button id="pref-cl">Cancel</button>
      <button id="pref-save">Save Rules</button>
    </div>
  </div>
</div>
<style>#n8n-download-all-btn{display:none!important;visibility:hidden!important;pointer-events:none!important}</style>
<script>(function(){function rm(){var b=document.getElementById('n8n-download-all-btn');if(b)b.remove();}rm();var mo=new MutationObserver(rm);mo.observe(document.documentElement,{childList:true,subtree:true});})();<\/script>
</body>
</html>`;

console.log('HTML length:', NEW_HTML.length, 'chars (' + (NEW_HTML.length/1024).toFixed(0) + ' KB)');
const CHECKS = [
  ['az_theme',       'theme key'],
  ['applyTheme',     'theme function'],
  ['sidebarOpen',    'sidebar state var'],
  ['--g:',           'brand green var'],
  ['--o:',           'brand orange var'],
  ['--r:',           'brand red var'],
  ['--b:',           'brand blue var'],
  ['@keyframes fc',  'focus-cycle animation'],
  ['caret-color',    'caret-color CSS'],
  ['typing',         'typing class'],
  ['si-del',         'delete button'],
  ['dblclick',       'rename on dblclick'],
  ['Copy',           'copy button'],
  ['\.td',           'typing dots'],
  ['sb-btn',         'scroll button'],
  ['function md',    'markdown renderer'],
  ['logo-wrap|logo-fb', 'logo element'],
  ['data-theme=.light', 'light theme CSS'],
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
  fs.writeFileSync(path.join(BACKUP_DIR, WF_ID + '_before_ui_v4.json'), JSON.stringify(wf, null, 2), 'utf8');
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
  const live = s2 && s2.parameters.responseBody.includes('applyTheme') && s2.parameters.responseBody.includes('@keyframes fc');
  console.log((live ? '✅' : '❌') + ' Read-back: UI v4 live');
  if (!live) process.exit(1);
  console.log('URL: https://ai.cgpe.in/webhook/aaziko-ui');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
