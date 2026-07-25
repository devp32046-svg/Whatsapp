#!/usr/bin/env node
/**
 * CGPE bot usage check — run:  node check-usage.js
 *
 * Shows how much load the bot is taking and whether Gemini is rate-limiting us.
 * Gemini free tier limits are per-MINUTE and per-DAY *requests*, and one user
 * message costs several requests (the agent calls the model again for every
 * tool step), so the peak-minute number matters more than the daily total.
 */
require('dotenv').config({ quiet: true });
const { MongoClient } = require('mongodb');
const https = require('https');

const N8N_KEY = process.env.N8N_API_KEY;
const WORKFLOWS = { 'Main bot': 'T6JlzF4El2bSb2h3', 'Reminder engine': 'KL9WetH0w1Sr6Ddf', 'Report generator': '5POkiNLDhKOuVadg' };
// requests-per-message multiplier: agent turns = 1 model call each (tool steps add more)
const CALLS_PER_MSG = 3;

function api(path) {
  return new Promise((res) => {
    https.get({ hostname: 'ai.cgpe.in', path: '/api/v1' + path, headers: { 'X-N8N-API-KEY': N8N_KEY } }, r => {
      let s = ''; r.on('data', d => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { res({ data: [] }); } });
    }).on('error', () => res({ data: [] }));
  });
}

(async () => {
  console.log('\n=== CGPE BOT USAGE ===\n');

  // ---------- 1. volume from our own message log ----------
  const c = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  await c.connect();
  const rows = await c.db().collection('wa_messages').find({}).sort({ _id: -1 }).limit(3000).project({ ts: 1 }).toArray();
  await c.close();

  const byDay = {}, byMin = {};
  rows.forEach(r => {
    const t = String(r.ts || ''); if (t.length < 16) return;
    byDay[t.slice(0, 10)] = (byDay[t.slice(0, 10)] || 0) + 1;
    byMin[t.slice(0, 16)] = (byMin[t.slice(0, 16)] || 0) + 1;
  });
  const days = Object.entries(byDay).sort();
  console.log('Messages per day (last 7):');
  days.slice(-7).forEach(([d, n]) => console.log('   ' + d + '   ' + String(n).padStart(4) + '   ~' + (n * CALLS_PER_MSG) + ' Gemini calls'));

  const today = new Date().toISOString().slice(0, 10);
  const todayN = byDay[today] || 0;
  const peakMin = Object.entries(byMin).sort((a, b) => b[1] - a[1])[0];
  const avg = Math.round(days.reduce((s, [, n]) => s + n, 0) / (days.length || 1));
  console.log('\n   today: ' + todayN + ' msgs (~' + todayN * CALLS_PER_MSG + ' calls)   |   daily average: ' + avg);
  if (peakMin) console.log('   busiest MINUTE ever: ' + peakMin[1] + ' msgs (~' + peakMin[1] * CALLS_PER_MSG + ' calls/min) at ' + peakMin[0]);

  // ---------- 2. the real signal: is anything actually being throttled? ----------
  console.log('\nRecent failures per workflow:');
  let gemini429 = 0, openaiOld = 0;
  for (const [name, id] of Object.entries(WORKFLOWS)) {
    const j = await api('/executions?workflowId=' + id + '&status=error&limit=20&includeData=true');
    const list = j.data || [];
    let g = 0, o = 0, other = 0;
    list.forEach(ex => {
      const rd = (ex.data && ex.data.resultData) || {};
      const blob = JSON.stringify(rd.error || '') + JSON.stringify(rd.runData || '').slice(0, 4000);
      if (/RESOURCE_EXHAUSTED|429/i.test(blob)) g++;
      else if (/Insufficient quota|Payment required/i.test(blob)) o++;   // legacy OpenAI, pre-Gemini
      else other++;
    });
    gemini429 += g; openaiOld += o;
    console.log('   ' + name.padEnd(18) + ' errors=' + String(list.length).padStart(3) +
      '   gemini-429=' + g + '   old-openai=' + o + '   other=' + other +
      (list[0] ? '   latest ' + String(list[0].startedAt).slice(0, 16) : ''));
  }

  // ---------- 3. verdict ----------
  console.log('\n--- VERDICT ---');
  if (gemini429 > 0) {
    console.log('   ⚠️  Gemini IS rate-limiting us (' + gemini429 + ' hits). Options: switch the brain to');
    console.log('      gemini-flash-latest, spread the load, or route simple chats to a local model.');
  } else {
    console.log('   ✅ No Gemini rate-limit errors. Free tier is coping fine.');
    if (openaiOld) console.log('   (the ' + openaiOld + ' "insufficient quota" errors are OLD OpenAI ones from before the Gemini switch - ignore)');
  }
  console.log('\n   Official quota page: https://aistudio.google.com/  (API keys -> usage)');
  console.log('   Watch the busiest-MINUTE number above - the free tier caps requests per minute.\n');
})().catch(e => console.log('ERR', e.message));
