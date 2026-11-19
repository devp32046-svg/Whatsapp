'use strict';
/* Exercise the Claim -> Send -> Mark path LIVE, WITHOUT sending any real message, and with >=2 items
 * so it catches the item-pairing bug (a mongoDb node between Decide and Send can break $('Decide').item).
 *
 * SAFE BY CONSTRUCTION:
 *   - aborts unless 0 real active reminders exist (so flipping sendEnabled can fire nobody real);
 *   - uses a FAKE phoneNumberId/token -> Meta returns 401 -> no message can go out;
 *   - restores the config (sendEnabled:false, creds blank) and deletes the test docs in a finally.
 *
 *   node aaziko/reminders/deploy/send-path-test.js
 */
const { withDb, COLL } = require('../lib/db');
const sleep = ms => new Promise(z => setTimeout(z, ms));

(async () => {
  const dueUtc = new Date(Date.now() - 60000).toISOString();
  let seeded = [], snap = null;
  try {
    await withDb(async (client, db) => {
      const realActive = await db.collection(COLL).countDocuments({ status: 'active', source: { $ne: 'engine-sendtest' } });
      if (realActive > 0) throw new Error('ABORT: ' + realActive + ' real active reminder(s) exist — refusing to flip sendEnabled');
      snap = await db.collection('config').findOne({ key: 'engine' });
      console.log('config snapshot taken: sendEnabled=' + snap.sendEnabled);

      const docs = [1, 2].map(n => ({ text: 'SEND-PATH TEST #' + n, recipientPhone: '910000000000', setBy: 'engine-sendtest',
        source: 'engine-sendtest', nextFireAtIST: '(test)', nextFireAt: dueUtc, status: 'active', firedAt: null, wamid: null, createdAt: new Date().toISOString() }));
      const ins = await db.collection(COLL).insertMany(docs);
      seeded = Object.values(ins.insertedIds);
      console.log('seeded', seeded.length, 'due reminders');

      await db.collection('config').updateOne({ key: 'engine' },
        { $set: { sendEnabled: true, channel: 'whatsapp', phoneNumberId: '000000000000', token: 'INVALID_TEST_TOKEN', graphVersion: 'v21.0' } });
      console.log('flipped channel:whatsapp + sendEnabled:true with FAKE creds (Meta will 401 — nothing can send)');
    });

    // poll the DB until both leave 'active' (claimed/sent/failed) or ~110s pass
    let final = [];
    for (let i = 0; i < 13; i++) {
      await sleep(8000);
      await withDb(async (client, db) => { final = await db.collection(COLL).find({ _id: { $in: seeded } }).toArray(); });
      process.stdout.write('.');
      if (final.length && final.every(d => d.status !== 'active' && d.status !== 'sending')) break;
    }
    console.log('');
    for (const d of final) console.log('  ' + d.text + ' -> status=' + d.status + ' | firedAt=' + (d.firedAt || '-') + ' | wamid=' + (d.wamid || '-') + '\n     sendError=' + (d.sendError || '-'));
    const leak = final.filter(d => String(d.sendError || '').includes('INVALID_TEST_TOKEN'));
    console.log(leak.length ? ('\n🔴 TOKEN LEAK: fake token found in ' + leak.length + ' stored sendError(s) — BUILD_MARK must not store request headers') : '\ntoken-leak check: OK — fake token NOT present in any stored sendError');
    let uiRows = 0; await withDb(async (client, db) => { uiRows = await db.collection('ui_inbox').countDocuments({ reminderId: { $in: seeded.map(String) } }); });
    console.log('ui_inbox rows for these (should be 0 — IF routed to whatsapp): ' + uiRows);
    const allFailed = final.length === 2 && final.every(d => d.status === 'failed' && d.firedAt);
    const stuck = final.filter(d => d.status === 'sending' || d.status === 'active');
    if (allFailed && !leak.length && uiRows === 0) console.log('✅ PASS — WhatsApp route: both failed (fake token), 0 ui_inbox rows, no pairing bug, no token leak.');
    else if (stuck.length) console.log('❌ ' + stuck.length + ' stuck in ' + stuck.map(d => d.status).join('/') + ' — likely pairing bug. Fix: Send/Build Mark use $(\'Decide\').all()[$itemIndex].');
    else if (leak.length) console.log('❌ token leak — fix BUILD_MARK sanitising.');
    else console.log('⚠ unexpected end states — inspect above.');
  } finally {
    await withDb(async (client, db) => {
      if (snap) await db.collection('config').updateOne({ key: 'engine' },
        { $set: { sendEnabled: snap.sendEnabled === true, channel: snap.channel || 'ui', phoneNumberId: snap.phoneNumberId || '', token: snap.token || '', graphVersion: snap.graphVersion || 'v21.0' } });
      if (seeded.length) { const del = await db.collection(COLL).deleteMany({ source: 'engine-sendtest' }); await db.collection('ui_inbox').deleteMany({ reminderId: { $in: seeded.map(String) } }); console.log('restored config to snapshot | deleted', del.deletedCount, 'test docs'); }
      const left = await db.collection(COLL).countDocuments({ source: 'engine-sendtest' });
      const cfg = await db.collection('config').findOne({ key: 'engine' });
      console.log('final: channel=' + cfg.channel + ' sendEnabled=' + cfg.sendEnabled + ' | sendtest docs left=' + left);
    });
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
