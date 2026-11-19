/*
 * coa-ingest.js — READ-ONLY: download COA/spec/TDS PDF attachments from contact@aaziko.com,
 * read them (text extract), parse the spec parameters, and store them in aaziko_jarvis.coa_docs.
 * This is the "download kar ke read kar ke rakhna" engine — the foundation for spec-match → pricing.
 *
 * SAFETY (same as learn-ingest / poller):
 *  - IMAP opened READ-ONLY (EXAMINE) → never sets \Seen, never deletes/moves/sends.
 *  - Writes ONLY to our own aaziko_jarvis.coa_docs + saves files under aaziko/coa-files/. Mailbox untouched.
 *  - Credentials from aaziko/.secrets/learn-mail.json (gitignored).
 *
 * Run:  node aaziko/scripts/coa-ingest.js        (scans last SCAN_N inbox mails, default 60)
 * Env:  SCAN_N (how many recent inbox mails to scan)
 */
const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { PDFParse } = require('pdf-parse');
const { MongoClient } = require('mongodb');
const COAX = require('../service/coa-extract');    // shared extractor (same path the live poller uses)

const ROOT = path.resolve(__dirname, '..');            // aaziko/
const SEC = path.join(ROOT, '.secrets', 'learn-mail.json');
const MONGO = fs.readFileSync(path.join(ROOT, '.secrets', 'mongo-uri.txt'), 'utf8').trim();
const FILES = path.join(ROOT, 'coa-files');
const SCAN_N = Number(process.env.SCAN_N) || 60;
const C = JSON.parse(fs.readFileSync(SEC, 'utf8'));
if (!fs.existsSync(FILES)) fs.mkdirSync(FILES, { recursive: true });

const COA_HINT = /coa|certificate|analysis|spec|technical|tds|msds|\bsds\b|data ?sheet|test ?report|assay/i;
const safe = (s) => String(s || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 80);

async function pdfText(buf) { try { const p = new PDFParse({ data: buf }); const r = await p.getText(); return String(r.text || ''); } catch (e) { return ''; } }

let mongo, col;
const totals = { mails: 0, pdfs: 0, saved: 0 };

async function scanOnce(startSeq) {
  const client = new ImapFlow({ host: C.host || 'imap.gmail.com', port: C.port || 993, secure: true,
    auth: { user: C.email, pass: String(C.appPassword || '').replace(/\s+/g, '') }, logger: false,
    connectionTimeout: 20000, greetingTimeout: 15000, socketTimeout: 120000 });
  client.on('error', (e) => console.error('imap err: ' + (e && e.message || e)));
  await client.connect();
  let lastSeq = startSeq;
  try {
    const mbox = await client.mailboxOpen('INBOX', { readOnly: true });   // EXAMINE
    if (!mbox.exists) return mbox.exists;
    const from = startSeq || Math.max(1, mbox.exists - SCAN_N + 1);
    console.log('scanning seq ' + from + '..' + mbox.exists);
    for await (const msg of client.fetch(from + ':*', { source: true })) {
      lastSeq = msg.seq;
      totals.mails++;
      let parsed; try { parsed = await simpleParser(msg.source); } catch (e) { continue; }
      try {
        const cr = await COAX.extractAndStoreCoas(parsed, col);
        totals.pdfs += cr.pdfs; totals.saved += cr.saved;
        cr.items.forEach(it => console.log('  +COA  ' + it.filename + ' | ' + it.doc_type + ' | params=' + it.params + (it.ocr ? ' [' + it.ocr + ']' : '')));
      } catch (e) { console.error('  coa-extract err: ' + (e && e.message || e)); }
    }
    return mbox.exists;
  } finally { try { await client.logout(); } catch (e) {} }
}

(async () => {
  mongo = new MongoClient(MONGO, { serverSelectionTimeoutMS: 15000 });
  await mongo.connect();
  col = mongo.db('aaziko_jarvis').collection('coa_docs');
  try { await col.createIndex({ key: 1 }, { unique: true, sparse: true }); } catch (e) {}
  try { await col.createIndex({ messageId: 1 }); } catch (e) {}
  console.log('Connected Mongo. READ-ONLY IMAP ' + C.email + ' — last ' + SCAN_N + ' inbox mails for PDF attachments');

  // resilient: a transient TLS/socket blip must not abort the whole scan — reconnect and continue (dedup makes re-scan cheap)
  let resume = 0, done = false;
  for (let attempt = 1; attempt <= 4 && !done; attempt++) {
    try { const total = await scanOnce(resume); done = true; }
    catch (e) {
      console.error('[attempt ' + attempt + '] scan interrupted: ' + (e && e.message || e) + ' — reconnecting from seq ' + (totals.mails + 1));
      resume = Math.max(1, (resume || 1) + totals.mails);   // rough resume; dedup covers overlap
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  await mongo.close();
  console.log('\nDONE — ' + totals.mails + ' mails scanned, ' + totals.pdfs + ' PDF attachments, ' + totals.saved + ' new → aaziko_jarvis.coa_docs (read-only; mailbox untouched).');
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
