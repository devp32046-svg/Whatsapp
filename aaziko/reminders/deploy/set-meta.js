'use strict';
/* Go-live control for the fire-engine. Edits the aaziko_reminders.config {key:'engine'} doc safely.
 *
 *   node aaziko/reminders/deploy/set-meta.js               # show config + overdue count + status breakdown
 *   node aaziko/reminders/deploy/set-meta.js --channel ui        # deliver fired reminders to the UI inbox (no number)
 *   node aaziko/reminders/deploy/set-meta.js --channel whatsapp  # deliver via Meta (needs creds)
 *   node aaziko/reminders/deploy/set-meta.js --set          # copy META_TEST_* from reminders.env into config
 *   node aaziko/reminders/deploy/set-meta.js --enable       # sendEnabled:true  (whatsapp channel needs creds)
 *   node aaziko/reminders/deploy/set-meta.js --disable      # sendEnabled:false
 *
 * Guard: refuses to store a phoneNumberId/token that matches CGPE's root .env META_* (compared locally,
 * never printed) — so Aaziko can never accidentally send through CGPE's number.
 */
const path = require('path'), fs = require('fs');
const { withDb } = require('../lib/db');
const RROOT = path.resolve(__dirname, '..', '..', '..');

function parseEnv(p) { const o = {}; try { fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach(l => { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) o[m[1]] = m[2]; }); } catch (e) {} return o; }
const rem = parseEnv(path.join(__dirname, '..', '..', '.secrets', 'reminders.env'));
const cgpe = parseEnv(path.join(RROOT, '.env'));
const cgpeMetaValues = new Set(Object.keys(cgpe).filter(k => k.startsWith('META_')).map(k => cgpe[k]).filter(Boolean));

function assertNotCgpe(pnid, token) {
  if (pnid && cgpeMetaValues.has(pnid)) throw new Error('REFUSED: phoneNumberId matches a CGPE META_* value — that is CGPE’s number, not Aaziko’s');
  if (token && cgpeMetaValues.has(token)) throw new Error('REFUSED: token matches a CGPE META_* value');
}

async function overdueCount(db) {
  const act = await db.collection('reminders').find({ status: 'active' }).toArray();
  const now = Date.now();
  return { active: act.length, overdue: act.filter(r => { const t = Date.parse(r.nextFireAt); return !isNaN(t) && t <= now; }).length };
}

(async () => {
  const chIdx = process.argv.indexOf('--channel');
  const chVal = chIdx >= 0 ? (process.argv[chIdx + 1] || '') : '';
  const mode = chIdx >= 0 ? 'channel' : process.argv.includes('--set') ? 'set' : process.argv.includes('--enable') ? 'enable' : process.argv.includes('--disable') ? 'disable' : 'show';
  await withDb(async (client, db) => {
    const cfg = (await db.collection('config').findOne({ key: 'engine' })) || {};
    const oc = await overdueCount(db);

    if (mode === 'show') {
      console.log('config {key:engine}: sendEnabled=' + cfg.sendEnabled + ' | channel=' + (cfg.channel || 'ui') + ' | graphVersion=' + (cfg.graphVersion || '-') +
        ' | phoneNumberId=' + (cfg.phoneNumberId || '(empty)') + ' | token=' + (cfg.token ? 'SET(' + cfg.token.length + ' chars)' : '(empty)'));
      console.log('reminders: active=' + oc.active + ', of which overdue-now=' + oc.overdue + ' (these fire on the next tick once enabled)');
      const byStatus = await db.collection('reminders').aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
      console.log('status breakdown: ' + (byStatus.map(s => s._id + '=' + s.n).join(', ') || '(no reminders)'));
      const sending = (byStatus.find(s => s._id === 'sending') || {}).n || 0;
      if (sending) console.log('⚠ ' + sending + ' stuck in "sending" (claimed but never marked sent/failed) — investigate/reset to active');
      console.log('reminders.env has META_TEST_PHONE_NUMBER_ID=' + (rem.META_TEST_PHONE_NUMBER_ID ? 'set' : 'MISSING') + ', META_TEST_TOKEN=' + (rem.META_TEST_TOKEN ? 'set' : 'MISSING') + ', META_TEST_RECIPIENT=' + (rem.META_TEST_RECIPIENT || 'MISSING'));
      return;
    }

    if (mode === 'set') {
      const pnid = (rem.META_TEST_PHONE_NUMBER_ID || '').trim(), token = (rem.META_TEST_TOKEN || '').trim(), ver = (rem.META_API_VERSION || 'v21.0').trim();
      if (!pnid || !token) throw new Error('fill META_TEST_PHONE_NUMBER_ID and META_TEST_TOKEN in aaziko/.secrets/reminders.env first');
      assertNotCgpe(pnid, token);
      await db.collection('config').updateOne({ key: 'engine' }, { $set: { phoneNumberId: pnid, token: token, graphVersion: ver, updatedAt: new Date().toISOString() } });
      console.log('config updated with Aaziko Meta creds (phoneNumberId len ' + pnid.length + ', token len ' + token.length + ', ' + ver + '). sendEnabled still ' + (cfg.sendEnabled === true) + '.');
      console.log('next: --enable to go live (after opening the 24h window / using a template).');
      return;
    }

    if (mode === 'channel') {
      if (chVal !== 'ui' && chVal !== 'whatsapp') throw new Error('usage: --channel ui | --channel whatsapp');
      await db.collection('config').updateOne({ key: 'engine' }, { $set: { channel: chVal, updatedAt: new Date().toISOString() } });
      console.log('channel=' + chVal + (chVal === 'whatsapp' ? ' (needs phoneNumberId+token + --enable)' : ' (UI inbox; no number needed)'));
      return;
    }

    if (mode === 'enable') {
      const channel = cfg.channel || 'ui';
      if (channel === 'whatsapp') {
        assertNotCgpe(cfg.phoneNumberId, cfg.token);
        if (!cfg.phoneNumberId || !cfg.token) throw new Error('channel=whatsapp but no creds — run --set first (or --channel ui)');
      }
      console.log('⚠ enabling (channel=' + channel + ') will fire ' + oc.overdue + ' overdue reminder(s) on the NEXT tick (~1 min).');
      await db.collection('config').updateOne({ key: 'engine' }, { $set: { sendEnabled: true, updatedAt: new Date().toISOString() } });
      console.log('sendEnabled:true — engine LIVE on channel ' + channel + '.');
      return;
    }

    if (mode === 'disable') {
      await db.collection('config').updateOne({ key: 'engine' }, { $set: { sendEnabled: false, updatedAt: new Date().toISOString() } });
      console.log('sendEnabled:false — engine will no longer send.');
    }
  });
})().catch(e => { console.error(e.message); process.exit(1); });
