'use strict';
/*
 * Clear az-anon stale session memory from aaziko_organized.az_chat_memory
 *
 * Problem: UI uses az-anon session key (no sessionId passed).
 * 76 accumulated test turns → brain answers from context without calling tools.
 * India-China FTA returns "nahi mila" because USA-China "nahi mila" is in recent memory.
 *
 * node aaziko/brain/deploy/clear-anon-session.js         -- dry run (count only)
 * node aaziko/brain/deploy/clear-anon-session.js --write -- delete az-anon turns
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') });
const { MongoClient } = require('mongodb');

const WRITE = process.argv.includes('--write');
// aaziko_organized is on the local box — MONGODB_URI points to cgpe-connect Atlas, use AAZIKO_DB_URI
const URI = process.env.AAZIKO_DB_URI || 'mongodb://admin:Aaziko%21%40%23123@100.70.212.45:27017/?authSource=admin&directConnection=true';

(async () => {
  const client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 8000 });
  const col = client.db('aaziko_organized').collection('az_chat_memory');

  // Count before
  const anonCount  = await col.countDocuments({ sessionKey: 'az-anon' });
  const totalCount = await col.countDocuments({});
  console.log('=== az_chat_memory session memory cleanup ===');
  console.log('az-anon turns:', anonCount);
  console.log('Total turns (all sessions):', totalCount);

  if (!WRITE) {
    console.log('\n(dry run — pass --write to delete az-anon turns)');
    await client.close();
    return;
  }

  const r = await col.deleteMany({ sessionKey: 'az-anon' });
  console.log('\nDeleted:', r.deletedCount, 'az-anon turns');

  const afterCount = await col.countDocuments({ sessionKey: 'az-anon' });
  console.log('Remaining az-anon turns:', afterCount);

  if (afterCount === 0) {
    console.log('\n✅ az-anon session clean. UI test karo: "India China ke beech FTA hai kya?"');
    console.log('   Expected: RCEP + APTA (Bangkok Agreement) dono aane chahiye');
  } else {
    console.log('\n❌ Kuch turns abhi bhi bache hain — manually check karo');
  }

  await client.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
