/*
 * learn-ingest.js — READ-ONLY ingest of a real sales/purchase mailbox into aaziko_jarvis.
 * Jarvis's training corpus: real email journeys (buyer inbound + team outbound), nothing sent/changed.
 *
 * SAFETY:
 *  - IMAP mailbox opened in READ-ONLY (EXAMINE) mode → server never sets \Seen, we never delete/move/send.
 *  - Writes ONLY to aaziko_jarvis.learn_emails (our own DB). Source mailbox is never modified.
 *  - Credentials come from aaziko/.secrets/learn-mail.json (gitignored).
 *
 * Run:  node aaziko/scripts/learn-ingest.js [limitPerFolder]
 */
const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { MongoClient } = require('mongodb');

const ROOT = path.resolve(__dirname, '..');            // aaziko/
const SEC = path.join(ROOT, '.secrets', 'learn-mail.json');
const MONGO = fs.readFileSync(path.join(ROOT, '.secrets', 'mongo-uri.txt'), 'utf8').trim();
const LIMIT = Number(process.argv[2]) || 300;          // most-recent N per folder on each run

if (!fs.existsSync(SEC)) {
  console.error('MISSING ' + SEC + '\nCreate it from learn-mail.json.example with the Gmail app-password.');
  process.exit(1);
}
const C = JSON.parse(fs.readFileSync(SEC, 'utf8'));
const OWNER = String(C.email || '').toLowerCase();
const FRESH = process.argv.includes('--fresh');       // clear the corpus first (start clean)

const addrList = a => (a && a.value ? a.value.map(x => (x.address || '').toLowerCase()).filter(Boolean) : []);
const norm = s => String(s || '').replace(/^\s*(re|fwd|fw)\s*:\s*/gi, '').trim().toLowerCase();

(async () => {
  const mongo = new MongoClient(MONGO);
  await mongo.connect();
  const col = mongo.db('aaziko_jarvis').collection('learn_emails');
  try { await col.createIndex({ messageId: 1 }, { unique: true, sparse: true }); } catch (e) {}
  if (FRESH) { const d = await col.deleteMany({}); console.log('--fresh: cleared ' + d.deletedCount + ' old docs from learn_emails'); }

  const client = new ImapFlow({ host: C.host || 'imap.gmail.com', port: C.port || 993, secure: true, auth: { user: C.email, pass: String(C.appPassword || '').replace(/\s+/g, '') }, logger: false });
  await client.connect();
  console.log('Connected (READ-ONLY) as ' + C.email);

  // folders: use configured list, else INBOX + the provider's special Sent folder (auto-detected)
  let FOLDERS = C.folders;
  if (!FOLDERS) {
    FOLDERS = ['INBOX'];
    try { const list = await client.list(); const sent = list.find(m => m.specialUse === '\\Sent'); if (sent) FOLDERS.push(sent.path); } catch (e) {}
  }
  console.log('Folders: ' + FOLDERS.join(' · '));

  let added = 0, seen = 0;
  for (const folder of FOLDERS) {
    let mbox;
    try { mbox = await client.mailboxOpen(folder, { readOnly: true }); }      // EXAMINE = read-only, no flag changes
    catch (e) { console.log('  skip folder ' + folder + ' (' + e.message + ')'); continue; }
    if (!mbox.exists) { console.log('  ' + folder + ': empty'); continue; }
    const from = Math.max(1, mbox.exists - LIMIT + 1);
    console.log('  ' + folder + ': reading messages ' + from + '..' + mbox.exists);
    for await (const msg of client.fetch(from + ':*', { source: true, envelope: true, threadId: true })) {
      seen++;
      let parsed; try { parsed = await simpleParser(msg.source); } catch (e) { continue; }
      const env = msg.envelope || {};
      const fromAddr = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
      const fromEmail = (fromAddr.address || '').toLowerCase();
      const direction = fromEmail && fromEmail === OWNER ? 'outbound' : 'inbound';
      const messageId = parsed.messageId || env.messageId || (folder + ':' + msg.uid);
      const doc = {
        messageId, gmailThreadId: msg.threadId ? String(msg.threadId) : null, folder, direction,
        fromEmail, fromName: fromAddr.name || '',
        to: addrList(parsed.to), subject: parsed.subject || env.subject || '',
        subjectKey: norm(parsed.subject || env.subject || ''),
        date: parsed.date || env.date || null,
        bodyText: String(parsed.text || '').replace(/\r/g, '').trim().slice(0, 6000),
        snippet: String(parsed.text || '').replace(/\s+/g, ' ').trim().slice(0, 160),
        ingestedAt: new Date(),
      };
      try { const r = await col.updateOne({ messageId }, { $setOnInsert: doc }, { upsert: true }); if (r.upsertedCount) added++; } catch (e) {}
    }
  }
  await client.logout();
  await mongo.close();
  console.log('\nDONE — scanned ' + seen + ' messages, added ' + added + ' new to aaziko_jarvis.learn_emails (read-only; mailbox untouched).');
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
