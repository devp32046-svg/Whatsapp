/**
 * Quality regression harness for the CGPE bot prompt optimisation.
 *   node quality-test.js baseline   -> capture current answers
 *   node quality-test.js after      -> capture answers again
 *   node quality-test.js compare    -> show baseline vs after side by side
 *
 * Sends each query as a real inbound WhatsApp webhook and reads back the reply
 * the bot actually stored, so it measures the live system end to end.
 */
require('dotenv').config({ quiet: true });
const { MongoClient } = require('mongodb');
const https = require('https');
const fs = require('fs');

const DIR = 'C:/Users/Inet/AppData/Local/Temp/claude/c--Users-Inet-Desktop-test-chat-bot-Whatsapp/b01c9eba-081c-4531-a89e-3b49ddebe2b5/scratchpad';
const FROM = '919601775061';           // Ved (admin)
const WAIT_MS = 30000;                 // per query; the agent needs time for tool calls

// Representative of what the bot is actually asked (see the 300-msg category split)
const QUERIES = [
  { id: 'count',       q: 'how many clients do we have' },
  { id: 'birthday',    q: 'aaj kis ka birthday hai' },
  { id: 'guj_leads',   q: 'mane top 5 leads ni list joie che' },
  { id: 'reminder',    q: 'Shivam ko 10 minute baad reminder do: QTEST file check karni hai' },
  { id: 'team',        q: 'team members ki list dikhao' },
  { id: 'hindi_due',   q: 'इस महीने कितने premium due हैं' },
  { id: 'policy',      q: 'show me maturity list for this month' },
  { id: 'greeting',    q: 'hello' }
];

function sendMsg(text) {
  return new Promise(res => {
    const body = JSON.stringify({ entry: [{ changes: [{ value: {
      messages: [{ id: 'wamid.QT' + Date.now() + Math.floor(Math.random() * 9999), from: FROM, type: 'text',
        text: { body: text }, timestamp: String(Math.floor(Date.now() / 1000)) }],
      contacts: [{ profile: { name: 'Ved' } }] } }] }] });
    const r = https.request({ hostname: 'ai.cgpe.in', path: '/webhook/cgpe-whatsapp', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 90000 },
      x => { x.resume(); x.on('end', res); });
    r.on('error', res); r.on('timeout', () => { r.destroy(); res(); }); r.write(body); r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function lastReply(db) {
  const row = await db.collection('wa_messages').find({ phoneLast10: FROM.slice(-10) }).sort({ _id: -1 }).limit(1).toArray();
  return row.length ? String(row[0].replyText || '') : '';
}

async function capture(label) {
  const c = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  await c.connect(); const db = c.db();
  const out = {};
  for (const t of QUERIES) {
    const before = await lastReply(db);
    await sendMsg(t.q);
    await sleep(WAIT_MS);
    let reply = await lastReply(db);
    if (reply === before) { await sleep(12000); reply = await lastReply(db); }   // slow tool chain
    out[t.id] = { q: t.q, reply };
    console.log('  [' + t.id + '] ' + t.q);
    console.log('        -> ' + reply.replace(/\n/g, ' | ').slice(0, 150));
  }
  await c.close();
  fs.writeFileSync(DIR + '/qt-' + label + '.json', JSON.stringify(out, null, 1));
  console.log('\nsaved ' + DIR + '/qt-' + label + '.json');
}

function compare() {
  const a = JSON.parse(fs.readFileSync(DIR + '/qt-baseline.json', 'utf8'));
  const b = JSON.parse(fs.readFileSync(DIR + '/qt-after.json', 'utf8'));
  let same = 0;
  for (const k of Object.keys(a)) {
    const ra = (a[k].reply || '').replace(/\s+/g, ' ').trim();
    const rb = ((b[k] || {}).reply || '').replace(/\s+/g, ' ').trim();
    // did it still answer, still in the right language, still roughly the same facts?
    const numsA = (ra.match(/[0-9][0-9,]*/g) || []).join(',');
    const numsB = (rb.match(/[0-9][0-9,]*/g) || []).join(',');
    const ok = rb.length > 0 && numsA === numsB;
    if (ok) same++;
    console.log('\n[' + k + '] ' + a[k].q);
    console.log('  BEFORE (' + ra.length + ' chars, nums ' + (numsA || '-') + '): ' + ra.slice(0, 160));
    console.log('  AFTER  (' + rb.length + ' chars, nums ' + (numsB || '-') + '): ' + rb.slice(0, 160));
    console.log('  ' + (ok ? '✅ same facts' : '⚠️ CHECK - numbers or content differ'));
  }
  console.log('\n=== ' + same + '/' + Object.keys(a).length + ' kept identical facts ===');
}

const mode = process.argv[2];
if (mode === 'compare') { compare(); }
else if (mode === 'baseline' || mode === 'after') { console.log('capturing ' + mode + '...\n'); capture(mode); }
else { console.log('usage: node quality-test.js baseline|after|compare'); }
