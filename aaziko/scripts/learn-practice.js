/*
 * learn-practice.js — Jarvis PRACTICES on real threads (read-only; nothing sent).
 * Picks real buyer threads from aaziko_jarvis.learn_emails where the team actually replied,
 * then: given the buyer's message, Jarvis drafts ITS reply and we show it side-by-side with
 * the rep's (Sagar's) REAL reply. This is how we see how close Jarvis is to the real human.
 *
 * Run:  node aaziko/scripts/learn-practice.js [--n 2]
 */
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const ROOT = path.resolve(__dirname, '..');
const MONGO = fs.readFileSync(path.join(ROOT, '.secrets', 'mongo-uri.txt'), 'utf8').trim();
const LLM = require(path.join(ROOT, 'service', 'llm'));
const N = (() => { const i = process.argv.indexOf('--n'); return i >= 0 ? (Number(process.argv[i + 1]) || 2) : 2; })();

const NOISE_FROM = /mailer-daemon|postmaster|no-?reply|notifications?@|security|@google\.com|docs\.google|calendar|accounts\.google/i;
const NOISE_SUBJ = /delivery status|mail delivery|not delivered|undeliverable|security alert|KRA ACD|customs entry|out of office|automatic reply|proforma invoice .* from/i;
const cleanSubject = s => String(s || '').replace(/^\s*(re|fwd|fw)\s*:\s*/gi, '').trim();
const isNoise = m => NOISE_FROM.test(m.fromEmail || '') || NOISE_SUBJ.test(m.subject || '');
// show only the fresh part of an email (cut off the quoted thread below)
const topOnly = s => String(s || '').split(/\n(?:On .{0,90}wrote:|-----\s*Original Message|________+|From: |Sent from )/i)[0].replace(/\r/g, '').trim();

(async () => {
  const mongo = new MongoClient(MONGO); await mongo.connect();
  const all = await mongo.db('aaziko_jarvis').collection('learn_emails').find({}).toArray();
  const T = {}; for (const m of all) { const k = m.gmailThreadId || ('s:' + m.subjectKey); (T[k] = T[k] || []).push(m); }

  // practice point = a real buyer message that the team later replied to, in the same thread
  const cands = [];
  for (const k of Object.keys(T)) {
    const msgs = T[k].sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
    let best = -1, bestReply = null;
    for (let i = 0; i < msgs.length; i++) {
      const b = msgs[i];
      if (b.direction !== 'inbound' || isNoise(b) || topOnly(b.bodyText).length < 40) continue;
      const reply = msgs.slice(i + 1).find(x => x.direction === 'outbound' && topOnly(x.bodyText).length > 20);
      if (!reply) continue;
      best = i; bestReply = reply;            // keep the DEEPEST point (most prior context) for a full-thread test
    }
    if (best < 0) continue;
    const thread = msgs.slice(0, best).map(m => ({ direction: m.direction === 'outbound' ? 'us' : 'buyer', text: topOnly(m.bodyText) })).filter(x => x.text.length > 10);
    cands.push({ buyer: msgs[best], reply: bestReply, thread, score: topOnly(msgs[best].bodyText).length + best * 60 });
  }
  cands.sort((a, b) => b.score - a.score);
  const picks = []; const seen = new Set();
  for (const c of cands) { const d = (c.buyer.fromEmail || '').split('@')[1]; if (seen.has(d)) continue; seen.add(d); picks.push(c); if (picks.length >= N) break; }

  console.log('Found ' + cands.length + ' real practice points; showing top ' + picks.length + ' (distinct buyers).');

  for (const p of picks) {
    const b = p.buyer, real = p.reply;
    const product = cleanSubject(b.subject) || 'their enquiry';
    const ctx = {
      buyer: { name: b.fromName || (b.fromEmail || '').split('@')[0], email: b.fromEmail, country: null, product, hs: null },
      company: { name: b.fromName || ((b.fromEmail || '').split('@')[1] || '') },
      buyerStats: null, tariff: null, intel: [], supplier: [], priorSent: [], unknowns: []
    };
    let r; try { r = await LLM.composeReply(ctx, { subject: b.subject, bodyText: b.bodyText }, p.thread); } catch (e) { console.log('compose failed: ' + e.message); continue; }
    console.log('\n' + '#'.repeat(82));
    console.log('# THREAD: ' + product.slice(0, 66) + '   (' + (b.fromEmail || '') + ')   [' + p.thread.length + ' prior msgs in context]');
    console.log('#'.repeat(82));
    if (p.thread.length) console.log('\n📜 CONVERSATION SO FAR:\n' + p.thread.map(m => '  ' + (m.direction === 'us' ? 'US ' : 'BUY') + ': ' + m.text.replace(/\s+/g, ' ').slice(0, 120)).join('\n'));
    console.log('\n📩 BUYER WROTE:\n' + topOnly(b.bodyText).slice(0, 650));
    console.log('\n🤖 JARVIS WOULD REPLY   [read as: ' + (r.classification && r.classification.intent) + (r.classification && r.classification.objection_type && r.classification.objection_type !== 'none' ? '/' + r.classification.objection_type : '') + ' · QA=' + r.qa.verdict + ']\n' + r.draft.body);
    console.log('\n🧑 SAGAR ACTUALLY REPLIED:\n' + topOnly(real.bodyText).slice(0, 900));
  }
  await mongo.close();
  console.log('\n(Practice only — read-only, nothing sent. Compare Jarvis vs the real rep to see the gap.)');
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
