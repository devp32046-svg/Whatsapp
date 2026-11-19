/*
 * learn-examples.js — mine the corpus for the BEST (buyer -> Sagar-reply) pairs and save them
 * as anonymised few-shot STYLE examples for Jarvis's reply prompt (aaziko/service/reply-examples.json).
 * Read-only on learn_emails; PII (emails/phones/names/urls) stripped — we transfer STYLE, not customer data.
 *
 * Run:  node aaziko/scripts/learn-examples.js [--keep 4]
 */
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const ROOT = path.resolve(__dirname, '..');
const MONGO = fs.readFileSync(path.join(ROOT, '.secrets', 'mongo-uri.txt'), 'utf8').trim();
const KEEP = (() => { const i = process.argv.indexOf('--keep'); return i >= 0 ? (Number(process.argv[i + 1]) || 4) : 4; })();

const NOISE_FROM = /mailer-daemon|postmaster|no-?reply|notifications?@|security|@google\.com|docs\.google|calendar|accounts\.google/i;
const NOISE_SUBJ = /delivery status|mail delivery|not delivered|undeliverable|security alert|KRA ACD|customs entry|out of office|automatic reply|proforma invoice .* from/i;
const isNoise = m => NOISE_FROM.test(m.fromEmail || '') || NOISE_SUBJ.test(m.subject || '');
const topOnly = s => String(s || '').split(/\n(?:On .{0,90}wrote:|-----\s*Original Message|________+|From: |Sent from )/i)[0].replace(/\r/g, '').trim();
const stripSig = s => String(s || '').split(/\n\s*(?:best regards|thanks\s*(?:&|and)\s*regards|kind regards|warm regards|regards,|sincerely)\b/i)[0].trim();
function anon(s) {
  return String(s || '')
    .replace(/https?:\/\/\S+/g, '[link]')
    .replace(/[\w.+-]+@[\w.-]+\.\w{2,}/g, '[email]')
    .replace(/(\+?\d[\d().\-\s]{7,}\d)/g, '[phone]')
    .replace(/^\s*(dear|hi|hello)\s+[^,\n]+/i, '$1 [Buyer]')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
const DEAL = /(quantit|\bSKU|target|indication|gap|priority|first[- ]order|proceed|offer|arrange|sample)/i;
const CONCRETE = /(TDS|COA|SDS|MSDS|ISO|GMP|Halal|Kosher|FOB|CFR|CIF|manufacturer|specification|lead time|packing|certificate)/i;

(async () => {
  const mongo = new MongoClient(MONGO); await mongo.connect();
  const all = await mongo.db('aaziko_jarvis').collection('learn_emails').find({}).toArray();
  const T = {}; for (const m of all) { const k = m.gmailThreadId || ('s:' + m.subjectKey); (T[k] = T[k] || []).push(m); }

  const pairs = [];
  for (const k of Object.keys(T)) {
    const msgs = T[k].sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
    for (let i = 0; i < msgs.length; i++) {
      const b = msgs[i];
      if (b.direction !== 'inbound' || isNoise(b)) continue;
      const bm = topOnly(b.bodyText); if (bm.length < 40) continue;
      const reply = msgs.slice(i + 1).find(x => x.direction === 'outbound');
      if (!reply) continue;
      const rm = stripSig(topOnly(reply.bodyText)); if (rm.length < 120 || rm.length > 1600) continue;
      let score = 0;
      if (DEAL.test(rm)) score += 3;
      if (CONCRETE.test(rm)) score += 2;
      if (rm.length >= 250 && rm.length <= 1200) score += 1;
      if (/\?\s*$|\?\s*\n/.test(rm)) score += 1;            // ends by asking something
      pairs.push({ score, subject: b.subject || '', domain: (b.fromEmail || '').split('@')[1] || '', buyer: anon(bm).slice(0, 320), reply: anon(rm).slice(0, 620) });
      break;
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const picks = []; const seen = new Set();
  for (const p of pairs) { if (seen.has(p.domain)) continue; seen.add(p.domain); picks.push(p); if (picks.length >= KEEP) break; }

  const out = picks.map(p => ({ buyer: p.buyer, reply: p.reply }));
  const file = path.join(ROOT, 'service', 'reply-examples.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log('Scanned ' + pairs.length + ' real buyer->reply pairs. Saved top ' + out.length + ' (anonymised) to ' + file + '\n');
  picks.forEach((p, i) => console.log('EXAMPLE ' + (i + 1) + ' [score ' + p.score + ' · ' + p.domain + '] "' + p.subject.slice(0, 50) + '"\n  BUYER: ' + p.buyer.slice(0, 110).replace(/\n/g, ' ') + '\n  SAGAR: ' + p.reply.slice(0, 150).replace(/\n/g, ' ') + '\n'));
  await mongo.close(); process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
