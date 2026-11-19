'use strict';
/* Live proof of UI-channel delivery: with channel='ui' + sendEnabled, a DUE reminder is delivered to
 * the ui_inbox collection and the reminder is marked 'sent' — no WhatsApp number involved. Seeds one
 * due reminder, waits for the next tick, asserts the ui_inbox row + 'sent', then cleans up (leaves the
 * engine in UI mode, which is the intended demo state).
 *
 *   node aaziko/reminders/deploy/verify-tick.js
 */
const { withDb, COLL } = require('../lib/db');
const sleep = ms => new Promise(z => setTimeout(z, ms));

(async () => {
  const dueUtc = new Date(Date.now() - 60000).toISOString();
  let testId;
  try {
    await withDb(async (client, db) => {
      const cfg = (await db.collection('config').findOne({ key: 'engine' })) || {};
      if (!(cfg.sendEnabled === true && (cfg.channel || 'ui') === 'ui')) {
        console.log('⚠ config is not UI-enabled (sendEnabled=' + cfg.sendEnabled + ' channel=' + (cfg.channel || 'ui') + '). Run: set-meta.js --channel ui --enable');
      }
      const ins = await db.collection(COLL).insertOne({
        text: 'UI SELF-TEST ' + Date.now(), recipientPhone: '910000000000', setBy: 'ui-selftest',
        source: 'ui-selftest', nextFireAtIST: '(due-now test)', nextFireAt: dueUtc,
        status: 'active', firedAt: null, wamid: null, createdAt: new Date().toISOString(),
      });
      testId = ins.insertedId;
      console.log('seeded due reminder', String(testId), '| waiting for the engine tick…');
    });

    let rem = null, inboxRow = null;
    for (let i = 0; i < 13 && !(rem && rem.status !== 'active' && rem.status !== 'sending'); i++) {
      await sleep(8000);
      await withDb(async (client, db) => {
        rem = await db.collection(COLL).findOne({ _id: testId });
        inboxRow = await db.collection('ui_inbox').findOne({ reminderId: String(testId) });
      });
      process.stdout.write('.');
    }
    console.log('');
    console.log('reminder status:', rem && rem.status, '| firedAt:', (rem && rem.firedAt) || '-');
    console.log('ui_inbox row   :', inboxRow ? ('text=' + JSON.stringify(inboxRow.text) + ' channel=' + inboxRow.channel + ' delivered=' + inboxRow.delivered) : '(none)');
    const pass = rem && rem.status === 'sent' && inboxRow && inboxRow.channel === 'ui';
    console.log(pass ? '\n✅ PASS — due reminder delivered to ui_inbox and marked "sent" (no number needed).'
      : '\n❌ FAIL — not delivered as expected. Is the engine active + UI-enabled? (set-meta.js shows state)');
  } finally {
    if (testId) await withDb(async (client, db) => {
      await db.collection(COLL).deleteOne({ _id: testId });
      const di = await db.collection('ui_inbox').deleteMany({ reminderId: String(testId) });
      console.log('cleanup: removed test reminder + ' + di.deletedCount + ' ui_inbox row(s)');
    });
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
