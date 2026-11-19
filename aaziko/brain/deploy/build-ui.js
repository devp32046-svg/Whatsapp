'use strict';
/* Deploy Aaziko Brain UI — single-window chat page served by n8n
 *   node aaziko/brain/deploy/build-ui.js          -- dry run
 *   node aaziko/brain/deploy/build-ui.js --write  -- deploy
 */
const path = require('path'), fs = require('fs');
const { req, getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const SEC_DIR = path.resolve(__dirname, '..', '..', '.secrets');
const env = {};
try { fs.readFileSync(path.join(SEC_DIR, 'brain.env'), 'utf8').split(/\r?\n/).forEach(l => { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2]; }); } catch (e) {}
const ids = JSON.parse(fs.readFileSync(path.join(SEC_DIR, 'brain-n8n.json'), 'utf8'));

const WRITE  = process.argv.includes('--write');
const SECRET = env.BRAIN_CHAT_SECRET || 'a3f9e2b7c1d04e85f6a2c3d4e5f6a7b8';

function uid() { return Math.random().toString(36).slice(2, 10); }

// ─── HTML Chat Page ──────────────────────────────────────────────────────────
function buildHtml(secret, brainPath) {
  // No ${} in HTML — string literals only
  return `<!doctype html>
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
header{padding:14px 20px;background:var(--panel);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;flex:0 0 auto}
.logo{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#2ea043,#1a7f37);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;color:#fff}
.hd-info h1{font-size:15px;font-weight:600;letter-spacing:.2px}
.hd-info span{font-size:11px;color:var(--muted)}
#status{margin-left:auto;font-size:11px;color:var(--muted);background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:3px 10px}
#msgs{flex:1;overflow-y:auto;padding:20px 16px;display:flex;flex-direction:column;gap:10px}
.bubble{max-width:80%;padding:10px 14px;border-radius:12px;line-height:1.5;font-size:14px;white-space:pre-wrap;word-break:break-word}
.bubble.user{background:var(--user-bg);align-self:flex-end;border-bottom-right-radius:4px}
.bubble.bot{background:var(--bot-bg);align-self:flex-start;border-bottom-left-radius:4px;border:1px solid var(--border)}
.bubble.typing{color:var(--muted);font-style:italic}
.bubble.err{background:#3d1a1a;border-color:#6e1a1a;color:#ff7b7b}
.ts{font-size:10px;color:var(--muted);margin-top:3px;text-align:right}
.bubble.user .ts{text-align:right}
.bubble.bot .ts{text-align:left}
.wrap{display:flex;flex-direction:column;align-items:flex-end}
.wrap.bot-wrap{align-items:flex-start}
form{padding:12px 16px;background:var(--panel);border-top:1px solid var(--border);display:flex;gap:10px;flex:0 0 auto}
textarea{flex:1;background:var(--input-bg);border:1px solid var(--border);border-radius:10px;color:var(--text);padding:10px 14px;font-size:14px;resize:none;outline:none;font-family:inherit;line-height:1.5;min-height:44px;max-height:120px}
textarea::placeholder{color:var(--muted)}
textarea:focus{border-color:var(--accent)}
button{background:var(--accent);color:#fff;border:none;border-radius:10px;padding:10px 18px;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap;flex:0 0 auto}
button:hover{opacity:.88}
button:disabled{opacity:.4;cursor:not-allowed}
@media(max-width:600px){#msgs{padding:12px 10px}.bubble{max-width:93%}form{padding:8px 10px}}
</style>
</head>
<body>
<header>
  <div class="logo">A</div>
  <div class="hd-info"><h1>Aaziko AI</h1><span>Trade Assistant</span></div>
  <div id="status">ready</div>
</header>
<div id="msgs"></div>
<form id="form">
  <textarea id="inp" placeholder="Ask about products, tariffs, ports, compliance..." rows="1"></textarea>
  <button id="btn" type="submit">Send</button>
</form>
<script>
var KEY = "` + secret + `";
var BRAIN = "/webhook/aaziko-brain-ui";
var SESSION = "ui-" + Math.random().toString(36).slice(2,10);
var msgs = document.getElementById("msgs");
var inp  = document.getElementById("inp");
var btn  = document.getElementById("btn");
var status = document.getElementById("status");

function ts() {
  var d = new Date();
  return ("0"+d.getHours()).slice(-2)+":"+("0"+d.getMinutes()).slice(-2);
}
function addBubble(text, role, isTyping) {
  var wrap = document.createElement("div");
  wrap.className = "wrap" + (role==="bot"?" bot-wrap":"");
  var b = document.createElement("div");
  b.className = "bubble " + (isTyping ? "typing" : role);
  b.textContent = text;
  var t = document.createElement("div");
  t.className = "ts";
  t.textContent = ts();
  wrap.appendChild(b);
  wrap.appendChild(t);
  msgs.appendChild(wrap);
  msgs.scrollTop = msgs.scrollHeight;
  return b;
}

function setStatus(txt) { status.textContent = txt; }

document.getElementById("form").addEventListener("submit", function(e) {
  e.preventDefault();
  var text = inp.value.trim();
  if (!text) return;
  inp.value = "";
  inp.style.height = "";
  btn.disabled = true;
  setStatus("thinking...");
  addBubble(text, "user", false);
  var typingBubble = addBubble("...", "bot", true);

  fetch(BRAIN, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: text, sessionId: SESSION, channel: "ui", secret: KEY })
  })
  .then(function(r){ return r.json(); })
  .then(function(j){
    typingBubble.className = "bubble bot";
    typingBubble.textContent = j.reply || "(no reply)";
    msgs.scrollTop = msgs.scrollHeight;
    setStatus("ready");
    btn.disabled = false;
    inp.focus();
  })
  .catch(function(err){
    typingBubble.className = "bubble err";
    typingBubble.textContent = "Error: " + err.message;
    setStatus("error");
    btn.disabled = false;
  });
});

inp.addEventListener("keydown", function(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    document.getElementById("form").dispatchEvent(new Event("submit"));
  }
});
inp.addEventListener("input", function() {
  this.style.height = "";
  this.style.height = Math.min(this.scrollHeight, 120) + "px";
});

addBubble("Hello! I am Aaziko AI. Ask me about products, tariff rates, ports, or trade compliance.", "bot", false);
</script>
</body>
</html>`;
}

function buildWorkflow() {
  const html = buildHtml(SECRET, 'aaziko-brain-ui');
  const uid2 = uid;
  const nodes = [
    {
      id: uid2(), name: 'UI Page (GET)', type: 'n8n-nodes-base.webhook', typeVersion: 2,
      position: [0, 300],
      parameters: {
        httpMethod: 'GET',
        path: 'aaziko-ui',
        responseMode: 'responseNode',
        options: {}
      },
      webhookId: 'aaziko-ui-get'
    },
    {
      id: uid2(), name: 'Serve HTML', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1,
      position: [220, 300],
      parameters: {
        respondWith: 'text',
        responseBody: html,
        options: { responseCode: 200, responseHeaders: { entries: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }] } }
      }
    }
  ];

  const connections = {
    'UI Page (GET)': { main: [[{ node: 'Serve HTML', type: 'main', index: 0 }]] }
  };

  return {
    name: 'Aaziko — Brain UI Page',
    nodes,
    connections,
    settings: { saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all', executionOrder: 'v1' }
  };
}

(async () => {
  const wf = buildWorkflow();
  console.log('Built UI workflow:', wf.name, '| nodes:', wf.nodes.length);
  console.log('URL will be: https://ai.cgpe.in/webhook/aaziko-ui');

  if (!WRITE) { console.log('\n(dry run — pass --write to deploy)'); return; }

  if (ids.uiWfId) {
    // Update existing
    const backupDir = path.resolve(__dirname, '..', '..', '..', '..', 'backups');
    const existing = await getWf(ids.uiWfId);
    fs.writeFileSync(path.join(backupDir, ids.uiWfId + '_before_ui_redeploy.json'), JSON.stringify(existing, null, 2));
    await putWf(ids.uiWfId, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings });
    console.log('Updated UI workflow');
  } else {
    const r = await req('POST', '/api/v1/workflows', wf);
    const created = JSON.parse(r.body);
    if (!created.id) { console.error('Create failed:', r.body.slice(0, 200)); process.exit(1); }
    ids.uiWfId = created.id;
    fs.writeFileSync(path.join(SEC_DIR, 'brain-n8n.json'), JSON.stringify(ids, null, 2));
    console.log('Created UI workflow:', ids.uiWfId);
  }

  await activate(ids.uiWfId);
  const live = JSON.parse((await req('GET', '/api/v1/workflows/' + ids.uiWfId)).body);
  console.log('Active:', live.active, '| nodes:', live.nodes.length);
  console.log('\n✅ UI LIVE: https://ai.cgpe.in/webhook/aaziko-ui');
  console.log('Brain endpoint: https://ai.cgpe.in/webhook/aaziko-brain-ui (POST)');
  console.log('Secret:', SECRET);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
