'use strict';
/* Seed aaziko_search.bot_config with the Aaziko Brain v1 config doc.
 * node aaziko/brain/deploy/seed-config.js          -- show what will be upserted
 * node aaziko/brain/deploy/seed-config.js --write  -- actually upsert
 */
const { withWriteDb } = require('../lib/db');
const WRITE = process.argv.includes('--write');

const doc = {
  botId: 'aaziko_brain_v1',
  name: 'Aaziko AI Brain',
  version: 1,
  extraPrompt: null,
  createdAt: new Date().toISOString()
};

(async () => {
  if (!WRITE) {
    console.log('Would upsert:', JSON.stringify(doc, null, 2));
    console.log('\n(dry run — pass --write to upsert)');
    return;
  }
  await withWriteDb(async (client, db) => {
    const col = db.collection('bot_config');
    const r = await col.updateOne({ botId: 'aaziko_brain_v1' }, { $set: doc }, { upsert: true });
    console.log('upsertedId:', r.upsertedId, '| modifiedCount:', r.modifiedCount, '| upsertedCount:', r.upsertedCount);
  });
  console.log('✅ bot_config seeded');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
