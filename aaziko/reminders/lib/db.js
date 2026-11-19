'use strict';
/* Aaziko Reminder Engine — local Mongo helper (for seed / read-back / self-tests / probes).
 *
 * SEPARATE from CGPE (cgpe-connect) and from the Aaziko sales DBs. The admin user in the URI can
 * write to ANY database on 100.70.212.45, and aaziko_jarvis / common-service / outbound_email all
 * live on that same server — so the ONLY thing that keeps this deliverable isolated is the db name.
 * This helper HARD-REFUSES to open any database other than `aaziko_reminders`.
 *
 *   const { withDb, DB, COLL } = require('./lib/db');   // path relative to your script
 *   await withDb(async (client, db) => db.collection(COLL).find({}).toArray());
 */
const path = require('path'), fs = require('fs');
const SEC = path.resolve(__dirname, '..', '..', '.secrets', 'reminders.env');
try {
  fs.readFileSync(SEC, 'utf8').split(/\r?\n/).forEach(l => {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
} catch (e) { /* env optional until creds are filled */ }

const { MongoClient } = require('mongodb');
const DB = process.env.REMINDERS_DB || 'aaziko_reminders';
const COLL = process.env.REMINDERS_COLLECTION || 'reminders';

// The guard that enforces constraint #1/#3: this engine may touch exactly one db, nothing else.
if (DB !== 'aaziko_reminders') {
  throw new Error('REFUSING: reminder engine may only use db "aaziko_reminders", got "' + DB + '"');
}

async function withDb(fn) {
  if (!process.env.REMINDERS_MONGO_URI) {
    throw new Error('REMINDERS_MONGO_URI missing — fill aaziko/.secrets/reminders.env');
  }
  const client = new MongoClient(process.env.REMINDERS_MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  try {
    const db = client.db(DB);                 // db forced; never read from the URI path
    if (db.databaseName !== 'aaziko_reminders') throw new Error('guard: opened wrong db ' + db.databaseName);
    return await fn(client, db);
  } finally { await client.close(); }
}

module.exports = { withDb, DB, COLL, MongoClient };
