#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════════════
 *  CGPE Bot — Live Test Harness
 * ════════════════════════════════════════════════════════════════════════
 *  A standalone CLI to test the CGPE WhatsApp bot end-to-end and hunt bugs.
 *
 *  WHY THIS EXISTS
 *  The bot (https://ai.cgpe.in) is REMOTE, so any audio/image/doc must live
 *  on a PUBLIC url that serves RAW bytes. The app's /api/upload uses
 *  tmpfiles.org, which now returns an HTML redirect page instead of the file
 *  — so the bot can never download the media. This harness uploads directly
 *  to "litterbox" (temporary host, auto-deletes in 1h) which serves raw
 *  bytes, so you can test whether the BOT actually handles voice.
 *
 *  USAGE  (run from the Whatsapp/ folder)
 *    node test-bot.js voice [audioFile]     Full voice pipeline (default: uploaded_test_audio.webm)
 *    node test-bot.js text "your message"   Send one text message
 *    node test-bot.js suite                 Full bug-hunting battery
 *    node test-bot.js viaproxy [audioFile]  Test the ACTUAL UI path (through /api/upload) — shows the tmpfiles bug
 *    node test-bot.js direct "msg"          Hit the CGPE webhook directly (bypass local proxy)
 *
 *  FLAGS
 *    --from=9198...   sender phone (default: a real DB client)
 *    --name="..."     sender display name
 *    --proxy=URL      local proxy base (default http://localhost:3000)
 *    --host=litter|catbox   public file host (default litter = temporary)
 *
 *  NOTE: `voice`, `viaproxy` and the media part of `suite` UPLOAD your file to
 *  a public host so the remote bot can fetch it. litterbox auto-deletes in 1h.
 * ════════════════════════════════════════════════════════════════════════
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

// ── CLI parsing ─────────────────────────────────────────────────────────
const rawArgs = process.argv.slice(2);
const flags = {};
const pos = [];
for (const a of rawArgs) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) flags[m[1]] = m[2];
  else if (a.startsWith('--')) flags[a.slice(2)] = true;
  else pos.push(a);
}
const cmd = (pos[0] || 'suite').toLowerCase();

const CFG = {
  proxy: flags.proxy || 'http://localhost:3000',
  cgpeDirect: 'https://ai.cgpe.in/webhook/cgpe-chat',
  host: flags.host || 'litter',           // litter = temporary, catbox = permanent
  from: flags.from || '919825100001',
  name: flags.name || 'AARDESHANA ANILBHAI (#864805904)',
  defaultAudio: 'uploaded_test_audio.webm',
};

// ── Pretty logging ──────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', mag: '\x1b[35m',
};
const H = (s) => console.log(`\n${c.bold}${c.cyan}══ ${s} ══${c.reset}`);
const OK = (s) => console.log(`${c.green}✓${c.reset} ${s}`);
const BAD = (s) => console.log(`${c.red}✗${c.reset} ${s}`);
const WARN = (s) => console.log(`${c.yellow}⚠${c.reset} ${s}`);
const INFO = (s) => console.log(`${c.dim}·${c.reset} ${s}`);
const REPLY = (r) => console.log(`${c.mag}🤖 ${c.reset}${String(r).replace(/\n/g, '\n   ')}`);

// magic-byte sniff — tells us if a URL actually serves the file vs an HTML page
function sniff(buf) {
  if (!buf || !buf.length) return 'empty';
  const h4 = buf.slice(0, 4).toString('hex');
  const txt = buf.slice(0, 15).toString('utf8').toLowerCase();
  if (txt.includes('<!doctype') || txt.includes('<html')) return 'HTML PAGE (not a file!)';
  if (h4 === '1a45dfa3') return 'WebM/Matroska audio';
  if (h4 === '89504e47') return 'PNG image';
  if (buf.slice(0, 3).toString('hex') === 'ffd8ff') return 'JPEG image';
  if (buf.slice(0, 4).toString('utf8') === '%PDF') return 'PDF document';
  if (h4 === '4f676753') return 'OGG audio';
  if (buf.slice(0, 3).toString('hex') === '494433' || h4.startsWith('fffb')) return 'MP3 audio';
  return `unknown (magic ${h4})`;
}

// ── Public upload (raw-serving hosts) ───────────────────────────────────
async function uploadPublic(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`file not found: ${filePath}`);
  const buf = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  INFO(`uploading ${filename} (${(buf.length / 1024).toFixed(1)} KB) to ${CFG.host}...`);

  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', buf, { filename });
  let endpoint;
  if (CFG.host === 'catbox') {
    endpoint = 'https://catbox.moe/user/api.php';
  } else {
    endpoint = 'https://litterbox.catbox.moe/resources/internals/api.php';
    form.append('time', '1h');            // temporary; auto-deletes
  }
  const res = await axios.post(endpoint, form, { headers: form.getHeaders(), timeout: 60000 });
  const url = String(res.data).trim();
  if (!/^https?:\/\//.test(url)) throw new Error(`host returned non-URL: ${url.slice(0, 200)}`);
  return url;
}

// verify a public URL actually serves the raw file (this is the tmpfiles trap)
async function verifyRaw(url, expect) {
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000, maxRedirects: 5 });
    const kind = sniff(Buffer.from(res.data));
    const ctype = res.headers['content-type'] || '?';
    if (kind.includes('HTML')) {
      BAD(`URL does NOT serve the file — got ${kind} [content-type: ${ctype}]`);
      return false;
    }
    OK(`URL serves raw bytes: ${kind} [${ctype}, ${res.data.byteLength}b]`);
    if (expect && !kind.toLowerCase().includes(expect)) WARN(`expected ${expect}, got ${kind}`);
    return true;
  } catch (e) {
    BAD(`could not fetch URL: ${e.message}`);
    return false;
  }
}

// ── Talk to the bot ─────────────────────────────────────────────────────
async function chat(payload, { direct = false } = {}) {
  const url = direct ? CFG.cgpeDirect : `${CFG.proxy}/api/chat`;
  const started = Date.now();
  const res = await axios.post(url, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 95000,
    validateStatus: () => true,
  });
  return { status: res.status, ms: Date.now() - started, data: res.data };
}

function makePayload(extra) {
  return {
    from: CFG.from,
    name: CFG.name,
    messageId: 'test-' + process.pid + '-' + Math.floor(Math.random() * 1e6),
    ...extra,
  };
}

function judgeReply(r) {
  // Heuristic: did the bot actually understand, or fall back?
  const reply = (r.data && r.data.reply) || '';
  const empty = /returned no text|no response|try again or rephrase/i.test(reply);
  const failedConn = /connection.*failed/i.test(reply);
  if (r.status !== 200) { BAD(`HTTP ${r.status} (${r.ms}ms)`); return false; }
  if (failedConn) { BAD(`proxy→bot connection failed (${r.ms}ms)`); return false; }
  if (empty) { WARN(`bot returned EMPTY/fallback — it did not understand the input (${r.ms}ms)`); return false; }
  OK(`HTTP 200 (${r.ms}ms)`);
  return true;
}

// ── Commands ────────────────────────────────────────────────────────────
async function cmdVoice(file) {
  const audio = path.resolve(file || CFG.defaultAudio);
  H(`VOICE TEST — ${path.basename(audio)}`);
  const url = await uploadPublic(audio);
  INFO(`public URL: ${url}`);
  const served = await verifyRaw(url, 'audio');
  if (!served) WARN('bot will likely fail to transcribe because the URL is not raw audio');

  INFO('sending as type:audio to the bot...');
  const r = await chat(makePayload({ type: 'audio', audioUrl: url }));
  const good = judgeReply(r);
  REPLY((r.data && r.data.reply) || JSON.stringify(r.data));
  console.log('');
  if (good) OK('VOICE PIPELINE WORKS — bot produced a real reply from the audio.');
  else BAD('VOICE PIPELINE FAILED — see reply above. If URL served raw audio but reply is empty, the BUG is in the bot/n8n transcription, not the file host.');
}

async function cmdViaProxy(file) {
  const audio = path.resolve(file || CFG.defaultAudio);
  H(`VIA-PROXY TEST (the real UI path, through /api/upload) — ${path.basename(audio)}`);
  const buf = fs.readFileSync(audio);
  INFO('POST /api/upload (base64) ...');
  const up = await axios.post(`${CFG.proxy}/api/upload`, {
    base64Data: 'data:audio/webm;base64,' + buf.toString('base64'),
    mimeType: 'audio/webm', filename: 'voice.webm',
  }, { timeout: 60000, validateStatus: () => true });
  if (!up.data || !up.data.success) { BAD(`upload failed: ${JSON.stringify(up.data)}`); return; }
  const url = up.data.url;
  INFO(`/api/upload returned: ${url}`);
  const served = await verifyRaw(url, 'audio');
  if (!served) BAD('CONFIRMED BUG: the UI upload path hands the bot a non-file URL. Voice cannot work through the current /api/upload.');
  const r = await chat(makePayload({ type: 'audio', audioUrl: url }));
  judgeReply(r);
  REPLY((r.data && r.data.reply) || JSON.stringify(r.data));
}

async function cmdText(msg, direct = false) {
  H(`TEXT TEST${direct ? ' (direct to CGPE webhook)' : ''}`);
  INFO(`"${msg}"`);
  const r = await chat(makePayload({ text: msg }), { direct });
  judgeReply(r);
  REPLY((r.data && r.data.reply) || JSON.stringify(r.data));
  if (r.data && Array.isArray(r.data.buttons) && r.data.buttons.length)
    INFO('buttons: ' + r.data.buttons.map((b) => `[${b.title}]`).join(' '));
}

async function cmdSuite() {
  H('BUG-HUNTING BATTERY');
  const cases = [
    ['greeting (EN)',            { text: 'Hi' }],
    ['gujarati policy query',    { text: 'mari policy ni details aapo' }],
    ['hindi policy query',       { text: 'meri policy ki jankari do' }],
    ['policy# lookup (should ask verify)', { text: 'policy 864805904 status' }],
    ['button NEW_INQUIRY',       { text: 'NEW_INQUIRY' }],
    ['button CALL_BACK',         { text: 'CALL_BACK' }],
    ['button EXPLORE',           { text: 'EXPLORE' }],
    ['EMPTY object',             {}],
    ['whitespace only',          { text: '   ' }],
    ['injection payload',        { text: '<script>alert(1)</script> DROP TABLE policies;' }],
    ['unicode/emoji mix',        { text: '😀🔥 ગુજરાતી हिन्दी 12345 !@#$%' }],
    ['very long text',           { text: ('policy details ').repeat(400) }],
    ['unknown / new lead',       { text: 'Hello I want a new policy', from: '919812345678', name: 'Ramesh Patel (New Lead)' }],
  ];
  let pass = 0, warned = 0, fail = 0;
  for (const [label, extra] of cases) {
    console.log(`\n${c.bold}▶ ${label}${c.reset}`);
    try {
      const from = extra.from || CFG.from;
      const name = extra.name || CFG.name;
      const p = { from, name, messageId: 'suite-' + Math.floor(Math.random() * 1e6) };
      if (extra.text !== undefined) p.text = extra.text;
      const r = await chat(p);
      const good = judgeReply(r);
      REPLY(((r.data && r.data.reply) || JSON.stringify(r.data)).slice(0, 300));
      if (good) pass++; else if (r.status === 200) warned++; else fail++;
    } catch (e) { BAD(e.message); fail++; }
  }

  // Concurrency / race test (the app's "async router" reason for existing)
  H('CONCURRENCY BURST (4 parallel clients)');
  const clients = ['919825100001', '919825100002', '919825100003', '919825100004'];
  const results = await Promise.allSettled(
    clients.map((ph, i) => chat({ from: ph, name: 'Client' + (i + 1), messageId: 'conc' + i, text: 'hello from client ' + (i + 1) }))
  );
  results.forEach((res, i) => {
    if (res.status === 'fulfilled' && res.value.status === 200) OK(`client${i + 1}: ${(res.value.data.reply || '').slice(0, 60)}...`);
    else BAD(`client${i + 1}: failed`);
  });

  H('SUMMARY');
  console.log(`${c.green}pass ${pass}${c.reset}  ${c.yellow}empty/fallback ${warned}${c.reset}  ${c.red}fail ${fail}${c.reset}`);
  WARN('Reminder: media (voice/image/doc) still needs `node test-bot.js voice` — it is NOT covered above because it requires a public upload.');
}

// ── Entry ───────────────────────────────────────────────────────────────
(async () => {
  console.log(`${c.dim}proxy=${CFG.proxy}  host=${CFG.host}  from=${CFG.from}${c.reset}`);
  try {
    switch (cmd) {
      case 'voice':    await cmdVoice(pos[1]); break;
      case 'viaproxy': await cmdViaProxy(pos[1]); break;
      case 'text':     await cmdText(pos[1] || 'Hi', false); break;
      case 'direct':   await cmdText(pos[1] || 'Hi', true); break;
      case 'suite':    await cmdSuite(); break;
      default:
        console.log('Unknown command. Use: voice | text | suite | viaproxy | direct');
    }
  } catch (e) {
    BAD(e.message);
    process.exitCode = 1;
  }
})();
