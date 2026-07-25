/**
 * Full feature sweep for the CGPE bot.
 *   node full-feature-test.js
 *
 * Sends each scenario as a real inbound webhook, reads back what the bot actually did
 * (reply text + the WhatsApp payload type), and prints a pass/fail table.
 * Chat memory is cleared between groups because it anchors tool arguments.
 * Only the three approved test numbers are ever contacted.
 */
require('dotenv').config({ quiet: true });
const { MongoClient } = require('mongodb');
const https = require('https');
const fs = require('fs');

const KEY = (fs.readFileSync('.env', 'utf8').match(/^N8N_API_KEY=(.+)$/m) || [])[1].trim();
const VED = '919601775061';     // admin
const SHIVAM = '919106988376';  // team member
const NEWUSER = '919888777666'; // pretend prospect

let db, mongo;
const results = [];

function post(path, body) {
  return new Promise(res => {
    const data = JSON.stringify(body);
    const r = https.request({ hostname: 'ai.cgpe.in', path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 240000 },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => res({ code: x.statusCode, body: s })); });
    r.on('error', () => res({ code: 0, body: '' }));
    r.on('timeout', () => { r.destroy(); res({ code: 0, body: 'timeout' }); });
    r.write(data); r.end();
  });
}
function api(path) {
  return new Promise(res => {
    https.get({ hostname: 'ai.cgpe.in', path: '/api/v1' + path, headers: { 'X-N8N-API-KEY': KEY } }, r => {
      let s = ''; r.on('data', d => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { res({ data: [] }); } });
    }).on('error', () => res({ data: [] }));
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function inbound(from, msg, name) {
  return post('/webhook/cgpe-whatsapp', { entry: [{ changes: [{ value: {
    messages: [Object.assign({ id: 'wamid.T' + Date.now() + Math.floor(Math.random() * 99999), from: from,
      timestamp: String(Math.floor(Date.now() / 1000)) }, msg)],
    contacts: [{ profile: { name: name || 'Ved' } }] } }] }] });
}
async function lastReply(phone) {
  const r = await db.collection('wa_messages').find({ phoneLast10: phone.slice(-10) }).sort({ _id: -1 }).limit(1).toArray();
  return r.length ? String(r[0].replyText || '') : '';
}
async function lastPayloadType() {
  const j = await api('/executions?workflowId=T6JlzF4El2bSb2h3&limit=6&includeData=true');
  for (const ex of (j.data || [])) {
    const run = ex.data && ex.data.resultData && ex.data.resultData.runData || {};
    const pr = run['Parse Reply'];
    if (pr && pr[0] && pr[0].data) return (pr[0].data.main[0][0].json.waPayload || {}).type || 'text';
  }
  return '?';
}
async function clearMemory(phone) {
  await db.collection('wa_chat_memory').deleteMany({ sessionId: 'wa-' + phone.slice(-10) });
}

// run one text scenario and judge it
async function T(label, from, text, check, opts) {
  opts = opts || {};
  if (opts.fresh) { await clearMemory(from); await sleep(1500); }
  const before = await lastReply(from);
  await inbound(from, { type: 'text', text: { body: text } }, opts.name);
  await sleep(opts.wait || 38000);
  let reply = await lastReply(from);
  if (reply === before) { await sleep(15000); reply = await lastReply(from); }
  const type = await lastPayloadType();
  let verdict;
  try { verdict = check(reply, type); } catch (e) { verdict = false; }
  results.push({ label, sent: text, reply: reply.replace(/\n/g, ' | ').slice(0, 110), type, ok: !!verdict });
  console.log((verdict ? '  ✅ ' : '  ❌ ') + label + '  [' + type + ']');
  console.log('       ' + reply.replace(/\n/g, ' | ').slice(0, 130));
}

(async () => {
  mongo = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  await mongo.connect(); db = mongo.db();
  console.log('\n=== CGPE BOT — FULL FEATURE SWEEP ===\n');

  console.log('-- 1. TEXT + DATA LOOKUPS --');
  await T('Client count', VED, 'kitne clients hain', r => /9,?012/.test(r), { fresh: true });
  await T('Birthday list', VED, 'aaj kis ka birthday hai', r => r.length > 20 && !/could not process/i.test(r));
  await T('Premium due', VED, 'is mahine kitne premium due hain', r => /\d/.test(r) && !/could not process/i.test(r));
  await T('Team list', VED, 'team members ki list dikhao', r => /shiv|priyanka|ankit|harsh/i.test(r));
  await T('Client search', VED, 'MORADIYA ALPESH ko dhundo', r => r.length > 15 && !/could not process/i.test(r));

  console.log('\n-- 2. LANGUAGES --');
  await T('English', VED, 'how many clients do we have', r => /client/i.test(r) && !/[ऀ-ॿ઀-૿]/.test(r), { fresh: true });
  await T('Hindi (Devanagari)', VED, 'आज कितने क्लाइंट हैं', r => /[ऀ-ॿ]/.test(r));
  await T('Gujarati (script)', VED, 'આપણી પાસે કેટલા ક્લાયન્ટ છે', r => /[઀-૿]/.test(r));
  await T('Roman-Hindi', VED, 'hamare paas kitne clients hain bhai', r => /hain|hai|paas/i.test(r) && !/[ऀ-ॿ઀-૿]/.test(r));
  await T('Roman-Gujarati', VED, 'apni pase ketla client che', r => /che|chhe/i.test(r) && !/[઀-૿]/.test(r));
  await T('Short ack keeps language', VED, 'saru', r => r.length > 2 && !/[ऀ-ॿ]/.test(r));

  console.log('\n-- 3. PDF GENERATION --');
  await T('CA directory PDF', VED, 'CA list ki PDF file bhejo', (r, t) => t === 'document', { fresh: true, wait: 60000 });
  await T('Birthday PDF', VED, 'is mahine ki birthday list PDF me bhejo', (r, t) => t === 'document', { fresh: true, wait: 60000 });

  console.log('\n-- 4. BUTTONS --');
  await T('New user gets options', NEWUSER, 'mujhe insurance chahiye', (r, t) => t === 'interactive', { fresh: true, name: 'Rakesh' });
  await T('No buttons on plain data', VED, 'kitne clients hain', (r, t) => t !== 'interactive', { fresh: true });

  console.log('\n-- 5. REMINDERS --');
  await T('Self reminder', VED, 'mujhe 20 minute baad reminder do: SWEEP self test', r => /reminder|yaad/i.test(r), { fresh: true });
  await T('Cross-person reminder', VED, 'Shivam ko 25 minute baad reminder do: SWEEP cross test', r => /reminder|yaad|shivam/i.test(r));

  console.log('\n-- 6. TEAM MEMBER --');
  await T('Team sees own tasks', SHIVAM, 'mere tasks dikhao', r => r.length > 15 && !/could not process/i.test(r), { fresh: true, name: 'Shivam' });

  console.log('\n-- 7. CLAIM OCR (document path) --');
  const b64 = fs.readFileSync('test-claim-ocr.pdf').toString('base64');
  const cn = 'SWEEP-' + String(Date.now()).slice(-6);
  const cr = await post('/webhook/cgpe-claim-webhook', { base64PDF: b64, fileName: 'sweep.pdf',
    mimeType: 'application/pdf', clientPhone: VED, claimNumber: cn });
  await sleep(8000);
  const ca = await db.collection('claim_analyses').findOne({ claimNumber: cn });
  const cl = await db.collection('claims').findOne({ claimId: cn });
  const tk = await db.collection('tickets').findOne({ claimId: cn });
  const claimOk = !!(ca && ca.analysisOk && cl && tk);
  results.push({ label: 'Claim PDF -> analysis + claim + ticket', sent: 'sweep.pdf', ok: claimOk, type: 'claim',
    reply: ca ? ('analysisOk=' + ca.analysisOk + ' bill=' + JSON.stringify((ca.analysis || {}).bill_review || {}).slice(0, 60)) : 'not stored' });
  console.log((claimOk ? '  ✅ ' : '  ❌ ') + 'Claim PDF -> analysis + claim + ticket');
  console.log('       ' + (ca ? 'analysisOk=' + ca.analysisOk + ', claim=' + !!cl + ', ticket=' + !!tk : 'not stored'));

  // decision buttons
  await inbound(VED, { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'approve:' + cn, title: 'Approve' } } });
  await sleep(25000);
  const ca2 = await db.collection('claim_analyses').findOne({ claimNumber: cn });
  const cl2 = await db.collection('claims').findOne({ claimId: cn });
  const decOk = ca2 && ca2.status === 'approved' && cl2 && cl2.claimStatus === 'approved';
  results.push({ label: 'Claim Approve button', sent: 'tap Approve', ok: !!decOk, type: 'button',
    reply: 'analyses=' + (ca2 || {}).status + ' claims=' + (cl2 || {}).claimStatus });
  console.log((decOk ? '  ✅ ' : '  ❌ ') + 'Claim Approve button -> ' + (ca2 || {}).status + '/' + (cl2 || {}).claimStatus);

  // ---- historical evidence for things that need real media ----
  console.log('\n-- 8. VOICE (from real traffic) --');
  const voice = await db.collection('wa_messages').find({ isVoice: true }).sort({ _id: -1 }).limit(3).toArray();
  const voiceOk = voice.length > 0 && voice.some(v => String(v.replyText || '').length > 5);
  results.push({ label: 'Voice note -> transcript + reply', ok: voiceOk, type: 'voice',
    sent: voice.length ? String(voice[0].inbound || '').slice(0, 50) : 'no voice traffic found',
    reply: voice.length ? String(voice[0].replyText || '').slice(0, 90) : '-' });
  console.log((voiceOk ? '  ✅ ' : '  ⚠️ ') + 'Voice: ' + (voice.length ? voice.length + ' recent voice messages, latest replied' : 'no voice traffic to verify'));

  console.log('\n-- 9. PHOTO CLAIM (from real traffic) --');
  const photo = await db.collection('claim_analyses').find({ fileName: /\.(jpg|jpeg|png)$/i }).sort({ _id: -1 }).limit(3).toArray();
  const photoOk = photo.length > 0 && photo.some(p => p.analysisOk);
  results.push({ label: 'Photo of bill -> claim analysis', ok: photoOk, type: 'photo',
    sent: photo.length ? photo[0].fileName : 'none', reply: photo.length ? ('analysisOk=' + photo[0].analysisOk) : '-' });
  console.log((photoOk ? '  ✅ ' : '  ⚠️ ') + 'Photo claims: ' + photo.length + ' analysed');

  // ---- summary ----
  console.log('\n\n================ SUMMARY ================');
  const pass = results.filter(r => r.ok).length;
  results.forEach(r => console.log((r.ok ? ' ✅ ' : ' ❌ ') + r.label));
  console.log('\n' + pass + ' / ' + results.length + ' passed');
  fs.writeFileSync('feature-test-results.json', JSON.stringify(results, null, 1));
  console.log('details -> feature-test-results.json');
  await mongo.close();
})().catch(e => { console.log('ERR', e.message, e.stack ? e.stack.slice(0, 200) : ''); if (mongo) mongo.close(); });
