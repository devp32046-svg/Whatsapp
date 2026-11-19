'use strict';
/* Prove the data path create -> store(UTC) -> load -> decide, against the REAL aaziko_reminders db,
 * with NO WhatsApp/Meta involved. --write inserts 2 test docs, reads them back (confirming the db),
 * runs the fire-logic, then DELETES them so the db is left clean.
 *
 *   node aaziko/reminders/seed-and-check.js            # dry-run: build docs in memory + decide, no DB
 *   node aaziko/reminders/seed-and-check.js --write     # insert -> read back -> decide -> delete
 */
const { withDb, COLL } = require('./lib/db');
const L = require('./lib/fire-logic');

// Build an IST wall-clock string for (now + offsetMin), to exercise istWallToUtcIso like the real create.
function istWall(offsetMin) {
  const p = L.istParts(Date.now() + offsetMin * 60000);
  const z = n => String(n).padStart(2, '0');
  return p.y + '-' + z(p.mo) + '-' + z(p.d) + ' ' + z(p.hour) + ':' + z(p.min);
}
function makeDoc(text, offsetMin) {
  const ist = istWall(offsetMin);
  return {
    text, recipientPhone: '910000000000', setBy: 'selftest', source: 'selftest',
    nextFireAtIST: ist, nextFireAt: L.istWallToUtcIso(ist),
    status: 'active', firedAt: null, wamid: null, createdAt: new Date().toISOString(),
  };
}

(async () => {
  const write = process.argv.includes('--write');
  const docs = [ makeDoc('TEST due 2 min ago', -2), makeDoc('TEST due in 1 day', 24 * 60) ];
  console.log('built docs:');
  docs.forEach(d => console.log('  -', d.text, '| IST', d.nextFireAtIST, '-> UTC', d.nextFireAt));

  if (!write) {
    const dec = L.fireDecision(docs, Date.now());
    console.log('\nfireDecision now: quiet=' + dec.quiet + ' toFire=' + dec.toFire.length +
      ' notDue=' + dec.notDue.length + ' heldQuiet=' + dec.heldQuiet.length);
    console.log('would fire:', dec.toFire.map(d => d.text));
    console.log('\nDRY-RUN only. Re-run with --write to insert -> read back -> delete against aaziko_reminders.');
    return;
  }

  await withDb(async (client, db) => {
    console.log('\nconnected db:', db.databaseName); // guard already asserts this is aaziko_reminders
    await db.collection(COLL).createIndex({ status: 1 });
    const ins = await db.collection(COLL).insertMany(docs);
    const ids = Object.values(ins.insertedIds);
    console.log('inserted', ids.length, 'test docs into', db.databaseName + '.' + COLL);

    const back = await db.collection(COLL).find({ _id: { $in: ids } }).toArray();
    console.log('read back', back.length, 'docs from', db.databaseName);
    const dec = L.fireDecision(back, Date.now());
    console.log('fireDecision now: quiet=' + dec.quiet + ' toFire=' + dec.toFire.length +
      ' notDue=' + dec.notDue.length);
    console.log('would fire:', dec.toFire.map(d => d.text));

    const del = await db.collection(COLL).deleteMany({ _id: { $in: ids } });
    const left = await db.collection(COLL).countDocuments({ source: 'selftest' });
    console.log('deleted', del.deletedCount, 'test docs | selftest docs left in db:', left, '(should be 0)');
  });
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
