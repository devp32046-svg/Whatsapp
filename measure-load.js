// #10 Measurement — reads recent gateway executions, classifies every inbound message by the
// path it took (bypass / CRM-slim / full-brain / precheck / claim-forward / other), and reports
// how many AI calls were made and roughly how many prompt-tokens the bypass + CRM router saved.
// Read-only. Run any time:  node measure-load.js [limit]   (default 200 executions)
const https = require('https');
const fs = require('fs');
const KEY = (fs.readFileSync('c:/Users/Inet/Desktop/test-chat-bot/Whatsapp/.env', 'utf8').match(/^N8N_API_KEY=(.+)$/m) || [])[1].trim();
const GW = 'T6JlzF4El2bSb2h3';
const LIMIT = Number(process.argv[2] || 200);

// per-message prompt weight (tokens) BEFORE the user text, from the bot-brain audit
const FULL_BRAIN = 30000;   // ~11.5k system prompt + ~19k for 52 tool schemas
const CRM_SLIM = 17600;     // system prompt + ~6.5k for 16 tools
const BYPASS = 0;           // canned reply, no model call

function api(p) {
  return new Promise(r => {
    https.get({ hostname: 'ai.cgpe.in', path: '/api/v1' + p, headers: { 'X-N8N-API-KEY': KEY } },
      x => { let s = ''; x.on('data', d => s += d); x.on('end', () => { try { r(JSON.parse(s)); } catch (e) { r(null); } }); })
      .on('error', () => r(null));
  });
}

function classify(rd) {
  if (!rd) { return null; }
  if (rd['Bypass Send']) { return 'bypass'; }
  if (rd['Precheck Reply']) { return 'precheck'; }
  if (rd['CRM Brain']) { return 'crm_slim'; }
  if (rd['CGPE AI Brain']) { return 'full_brain'; }
  if (rd['Forward To Claim'] || rd['Claim Router']) { return 'claim'; }
  if (rd['Gate']) { return 'other'; }   // ack/decision/etc.
  return null;
}

(async () => {
  const list = (await api('/executions?workflowId=' + GW + '&limit=' + LIMIT)) || {};
  const rows = (list.data || []);
  const bucket = { bypass: 0, crm_slim: 0, full_brain: 0, precheck: 0, claim: 0, other: 0 };
  let first = null, last = null, classified = 0;

  for (const e of rows) {
    const full = await api('/executions/' + e.id + '?includeData=true');
    const rd = full && full.data && full.data.resultData && full.data.resultData.runData;
    const k = classify(rd);
    if (!k) { continue; }
    bucket[k]++; classified++;
    const t = new Date(e.startedAt).getTime();
    if (!first || t < first) { first = t; }
    if (!last || t > last) { last = t; }
  }

  const ist = t => t ? new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) : '-';
  const aiCalls = bucket.crm_slim + bucket.full_brain;
  // tokens actually spent now vs a world with no bypass + no router (every non-precheck/claim
  // message a full-brain call)
  const spentNow = bucket.crm_slim * CRM_SLIM + bucket.full_brain * FULL_BRAIN;
  const wouldHaveSpent = (bucket.bypass + bucket.crm_slim + bucket.full_brain) * FULL_BRAIN;
  const saved = wouldHaveSpent - spentNow;

  console.log('\n=== CGPE bot load — last ' + classified + ' messages ===');
  console.log('window: ' + ist(first) + '  ->  ' + ist(last) + '\n');
  const pct = n => classified ? Math.round(n / classified * 100) + '%' : '0%';
  [['bypass    (0 AI)', 'bypass'], ['CRM-slim  (light AI)', 'crm_slim'], ['full-brain(heavy AI)', 'full_brain'],
   ['precheck', 'precheck'], ['claim OCR', 'claim'], ['other', 'other']].forEach(([lbl, k]) => {
    console.log('  ' + lbl.padEnd(22) + String(bucket[k]).padStart(4) + '   ' + pct(bucket[k]));
  });
  console.log('\n  AI brain calls (crm+full): ' + aiCalls + '   bypassed entirely: ' + bucket.bypass);
  console.log('  approx prompt tokens spent:   ' + spentNow.toLocaleString());
  console.log('  without bypass+router (est):  ' + wouldHaveSpent.toLocaleString());
  console.log('  approx SAVED by #1 + #3:      ' + saved.toLocaleString() +
    (wouldHaveSpent ? '  (' + Math.round(saved / wouldHaveSpent * 100) + '%)' : ''));
  console.log('');
})();
