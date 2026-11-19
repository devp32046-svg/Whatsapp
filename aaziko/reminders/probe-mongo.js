'use strict';
/* READ-ONLY probe. Validates the Aaziko Mongo creds + reachability from HERE, lists the databases
 * on the server, and reports whether aaziko_reminders already exists. Creates / writes NOTHING.
 *
 *   node aaziko/reminders/probe-mongo.js          (run from the repo root)
 */
const { withDb, DB, COLL } = require('./lib/db');

(async () => {
  const t0 = Date.now();
  await withDb(async (client, db) => {
    const { databases } = await client.db('admin').admin().listDatabases();
    console.log('OK — reachable in ' + (Date.now() - t0) + ' ms. Databases on 100.70.212.45:');
    for (const d of databases) {
      const mb = d.sizeOnDisk != null ? ' (' + Math.round(d.sizeOnDisk / 1e6) + ' MB)' : '';
      console.log('   - ' + d.name + mb);
    }
    const exists = databases.some(d => d.name === DB);
    console.log('\naaziko_reminders present already? ' + exists);
    const colls = (await db.listCollections().toArray()).map(c => c.name);
    console.log('collections in ' + DB + ': ' + (colls.join(', ') || '(none — db not created yet)'));
    if (colls.includes(COLL)) {
      console.log(COLL + ' doc count: ' + (await db.collection(COLL).countDocuments({})));
    }
  });
})().catch(e => { console.error('PROBE FAILED: ' + e.message); process.exit(1); });
