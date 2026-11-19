/*
 * learn-report.js — what Jarvis has learned from the ingested mailbox corpus (read-only).
 * Reads aaziko_jarvis.learn_emails and summarises: volume, inbound vs outbound, threads/journeys,
 * top senders, and a few real example journeys. Optional intent classification on a sample.
 *
 * Run:  node aaziko/scripts/learn-report.js [--classify N]
 */
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const ROOT = path.resolve(__dirname, '..');
const MONGO = fs.readFileSync(path.join(ROOT, '.secrets', 'mongo-uri.txt'), 'utf8').trim();
const CLASSIFY = (() => { const i = process.argv.indexOf('--classify'); return i >= 0 ? (Number(process.argv[i + 1]) || 5) : 0; })();

const domain = e => (String(e || '').split('@')[1] || '').toLowerCase();
const threadKey = m => m.gmailThreadId || ('subj:' + m.subjectKey);

(async () => {
  const mongo = new MongoClient(MONGO);
  await mongo.connect();
  const col = mongo.db('aaziko_jarvis').collection('learn_emails');
  const all = await col.find({}).toArray();
  if (!all.length) { console.log('learn_emails is empty — run learn-ingest.js first.'); await mongo.close(); process.exit(0); }

  const inbound = all.filter(m => m.direction === 'inbound');
  const outbound = all.filter(m => m.direction === 'outbound');
  const dates = all.map(m => m.date && new Date(m.date)).filter(d => d && !isNaN(d)).sort((a, b) => a - b);

  // threads
  const threads = {};
  for (const m of all) { const k = threadKey(m); (threads[k] = threads[k] || []).push(m); }
  const tkeys = Object.keys(threads);
  const lens = tkeys.map(k => threads[k].length).sort((a, b) => b - a);
  const multi = tkeys.filter(k => threads[k].length >= 2);
  const avg = (lens.reduce((a, c) => a + c, 0) / (lens.length || 1)).toFixed(1);

  // top inbound sender domains
  const dom = {}; for (const m of inbound) { const d = domain(m.fromEmail); if (d) dom[d] = (dom[d] || 0) + 1; }
  const topDom = Object.entries(dom).sort((a, b) => b[1] - a[1]).slice(0, 8);

  console.log('========== WHAT JARVIS LEARNED (corpus) ==========');
  console.log('Total emails: ' + all.length + '  (inbound ' + inbound.length + ' · outbound ' + outbound.length + ')');
  console.log('Date range  : ' + (dates[0] ? dates[0].toISOString().slice(0, 10) : '?') + ' → ' + (dates[dates.length - 1] ? dates[dates.length - 1].toISOString().slice(0, 10) : '?'));
  console.log('Threads     : ' + tkeys.length + ' (with a back-and-forth: ' + multi.length + ') · avg ' + avg + ' msgs/thread · longest ' + (lens[0] || 0));
  console.log('\nTop inbound sender domains:');
  topDom.forEach(([d, n]) => console.log('  ' + String(n).padStart(4) + '  ' + d));

  // sample real journeys (longest multi-message threads)
  const samples = multi.map(k => threads[k].sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0)))
    .sort((a, b) => b.length - a.length).slice(0, 3);
  console.log('\n========== SAMPLE REAL JOURNEYS ==========');
  samples.forEach((t, i) => {
    console.log('\n--- Journey ' + (i + 1) + '  (' + t.length + ' messages) · "' + (t[0].subject || '').slice(0, 60) + '" ---');
    t.forEach(m => {
      const who = m.direction === 'inbound' ? '📩 BUYER  ' : '🧑 TEAM   ';
      const when = m.date ? new Date(m.date).toISOString().slice(0, 10) : '????-??-??';
      console.log('  ' + who + when + '  ' + (m.fromEmail || '') + '\n           ' + (m.snippet || '').slice(0, 130));
    });
  });

  if (CLASSIFY) {
    const LLM = require(path.join(ROOT, 'service', 'llm'));
    const pick = inbound.slice(-CLASSIFY);
    console.log('\n========== INTENT CLASSIFICATION (sample of ' + pick.length + ' inbound) ==========');
    for (const m of pick) {
      try { const c = await LLM.classifyInbound({ subject: m.subject, bodyText: m.bodyText }); console.log('  [' + c.intent + (c.objection_type && c.objection_type !== 'none' ? '/' + c.objection_type : '') + ']  ' + (m.subject || '').slice(0, 55)); }
      catch (e) { console.log('  [classify-failed] ' + (m.subject || '').slice(0, 55)); }
    }
  }

  await mongo.close();
  console.log('\n(Read-only report. Corpus lives in aaziko_jarvis.learn_emails. Nothing was sent or modified in the mailbox.)');
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
