'use strict';
/* Mongo connection helpers for Aaziko Brain.
 * WRITE guard: withWriteDb() ONLY connects to aaziko_search — hard refuses any other.
 * READ helpers: withReadDb(dbName) connects to any read DB on the Aaziko Mongo.
 * Both use the same Mongo URI from BRAIN_MONGO_URI in brain.env.
 */
const path = require('path');
const { MongoClient } = require('mongodb');

// Load brain.env
const envPath = path.resolve(__dirname, '..', '..', '.secrets', 'brain.env');
let _envLoaded = false;
function loadEnv() {
  if (_envLoaded) return;
  try {
    require('fs').readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(l => {
      const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
  } catch (e) { /* env already in process.env */ }
  _envLoaded = true;
}

const WRITE_DB = 'aaziko_search';

function getUri() {
  loadEnv();
  const uri = process.env.BRAIN_MONGO_URI;
  if (!uri) throw new Error('BRAIN_MONGO_URI not set');
  return uri;
}

async function withWriteDb(fn) {
  const client = new MongoClient(getUri());
  try {
    await client.connect();
    const db = client.db(WRITE_DB);
    if (db.databaseName !== WRITE_DB) throw new Error('DB guard: expected ' + WRITE_DB + ', got ' + db.databaseName);
    return await fn(client, db);
  } finally {
    await client.close();
  }
}

async function withReadDb(dbName, fn) {
  if (!dbName) throw new Error('dbName required for readDb');
  const client = new MongoClient(getUri());
  try {
    await client.connect();
    const db = client.db(dbName);
    return await fn(client, db);
  } finally {
    await client.close();
  }
}

module.exports = { withWriteDb, withReadDb, WRITE_DB };
