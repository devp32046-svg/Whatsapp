/*
 * mailbox-poller.js — LIVE, READ-ONLY poller for contact@aaziko.com → aaziko_jarvis.live_inbox
 * Makes the dashboard's Live Mailbox genuinely fresh (newest buyer mail shows within one poll cycle),
 * WITHOUT depending on the production outbound_email.inboundemails sync (which lags).
 *
 * SAFETY (same as learn-ingest):
 *  - IMAP opened READ-ONLY (EXAMINE) → never sets \Seen, never deletes/moves/sends.
 *  - Writes ONLY to our own aaziko_jarvis.live_inbox. Production inboundemails is NEVER written.
 *  - Creds from aaziko/.secrets/learn-mail.json (gitignored).
 *
 * Run (foreground loop):  node aaziko/scripts/mailbox-poller.js
 * Env: POLL_MIN (minutes between cycles, default 3) · FETCH_N (newest N per cycle, default 40) · ONCE=1 (single cycle)
 */
const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { MongoClient } = require('mongodb');

const ROOT = path.resolve(__dirname, '..');            // aaziko/
const SEC = path.join(ROOT, '.secrets', 'learn-mail.json');
const MONGO = fs.readFileSync(path.join(ROOT, '.secrets', 'mongo-uri.txt'), 'utf8').trim();
const POLL_MIN = Number(process.env.POLL_MIN) || 3;
const FETCH_N = Number(process.env.FETCH_N) || 40;
const ONCE = process.env.ONCE === '1';

if (!fs.existsSync(SEC)) { console.error('MISSING ' + SEC); process.exit(1); }
const C = JSON.parse(fs.readFileSync(SEC, 'utf8'));
const OWNER = String(C.email || '').toLowerCase();

const addr1 = (a) => (a && a.value && a.value[0]) || {};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// long-running poller: never let a transient async blip kill the loop; log and keep polling.
process.on('uncaughtException', (e) => { try { console.error('[' + new Date().toISOString() + '] uncaught: ' + (e && e.message || e)); } catch (x) {} });
process.on('unhandledRejection', (e) => { try { console.error('[' + new Date().toISOString() + '] unhandledRejection: ' + (e && e.message || e)); } catch (x) {} });

const COAX = require('../service/coa-extract');   // auto-read COA/spec PDFs on new mail

let mongo, col, coaCol;
async function ensureDb() {
  if (col) return col;
  mongo = new MongoClient(MONGO, { serverSelectionTimeoutMS: 15000 });
  await mongo.connect();
  const db = mongo.db('aaziko_jarvis');
  col = db.collection('live_inbox');
  coaCol = db.collection('coa_docs');
  try { await col.createIndex({ messageId: 1 }, { unique: true, sparse: true }); } catch (e) {}
  try { await col.createIndex({ receivedAt: -1 }); } catch (e) {}
  try { await coaCol.createIndex({ key: 1 }, { unique: true, sparse: true }); } catch (e) {}
  try { await coaCol.createIndex({ messageId: 1 }); } catch (e) {}
  return col;
}

async function cycle() {
  const c = await ensureDb();
  const client = new ImapFlow({ host: C.host || 'imap.gmail.com', port: C.port || 993, secure: true,
    auth: { user: C.email, pass: String(C.appPassword || '').replace(/\s+/g, '') }, logger: false,
    connectionTimeout: 20000, greetingTimeout: 15000, socketTimeout: 90000 });   // fail fast on a blip; next cycle retries
  client.on('error', (e) => { try { console.error('[' + new Date().toISOString() + '] imap socket error: ' + (e && e.message || e)); } catch (x) {} });   // transient TLS/socket blips must NOT crash the loop — next cycle reconnects fresh
  await client.connect();
  let added = 0, seen = 0, coaAdded = 0;
  try {
    const mbox = await client.mailboxOpen('INBOX', { readOnly: true });   // EXAMINE = read-only
    if (mbox.exists) {
      const from = Math.max(1, mbox.exists - FETCH_N + 1);
      for await (const msg of client.fetch(from + ':*', { source: true, envelope: true })) {
        seen++;
        let parsed; try { parsed = await simpleParser(msg.source); } catch (e) { continue; }
        const env = msg.envelope || {};
        const f = addr1(parsed.from);
        const fromEmail = (f.address || '').toLowerCase();
        const messageId = parsed.messageId || env.messageId || ('INBOX:' + msg.uid);
        const doc = {
          messageId, fromEmail, fromName: f.name || '',
          toEmail: (addr1(parsed.to).address || OWNER || '').toLowerCase(),
          to: (parsed.to && parsed.to.value ? parsed.to.value.map(x => (x.address || '').toLowerCase()) : []),
          subject: parsed.subject || env.subject || '',
          inReplyTo: parsed.inReplyTo || null,
          direction: fromEmail && fromEmail === OWNER ? 'outbound' : 'inbound',
          receivedAt: parsed.date || env.date || new Date(),
          bodyText: String(parsed.text || '').replace(/\r/g, '').trim().slice(0, 8000),
          source: 'live-poller', ingestedAt: new Date(),
        };
        try { const r = await c.updateOne({ messageId }, { $setOnInsert: doc }, { upsert: true }); if (r.upsertedCount) added++; } catch (e) {}
        // auto-read any COA/spec PDF attachments (new mail → specs ready on the dashboard, no manual coa-ingest)
        try { const cr = await COAX.extractAndStoreCoas(parsed, coaCol); if (cr.saved) { coaAdded += cr.saved; cr.items.forEach(it => console.log('      📎 COA ' + fromEmail + ' | ' + it.filename + ' | ' + it.doc_type + ' params=' + it.params + (it.ocr ? ' [' + it.ocr + ']' : ''))); } } catch (e) { console.error('      coa-extract err: ' + (e && e.message || e)); }
      }
    }
  } finally { try { await client.logout(); } catch (e) {} }
  console.log('[' + new Date().toISOString() + '] poll: scanned ' + seen + ', +' + added + ' new → live_inbox' + (coaAdded ? ', +' + coaAdded + ' COA docs' : ''));
  return added;
}

(async () => {
  console.log('mailbox-poller: READ-ONLY ' + C.email + ' → aaziko_jarvis.live_inbox | every ' + POLL_MIN + ' min, newest ' + FETCH_N);
  while (true) {
    try { await cycle(); } catch (e) { console.error('[' + new Date().toISOString() + '] cycle ERR ' + e.message); }
    if (ONCE) break;
    await sleep(POLL_MIN * 60 * 1000);
  }
  if (mongo) await mongo.close();
  process.exit(0);
})();
