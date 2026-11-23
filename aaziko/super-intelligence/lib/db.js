'use strict';
/*
 * Aaziko Super-Intelligence — shared DB access layer.
 * Single MongoClient per process (lazy connect). All reads are projection + limit.
 * Write operations are forbidden — this is a read-only intelligence layer.
 */
const { MongoClient } = require('mongodb');
const path = require('path');
const fs = require('fs');

const SECRETS_DIR = path.resolve(__dirname, '../../.secrets');
const URI_FILE    = path.join(SECRETS_DIR, 'mongo-uri.txt');

let _client = null;

function getUri() {
  if (process.env.AAZIKO_MONGO_URI) return process.env.AAZIKO_MONGO_URI;
  if (fs.existsSync(URI_FILE)) return fs.readFileSync(URI_FILE, 'utf8').trim();
  throw new Error('Aaziko MongoDB URI not found. Set AAZIKO_MONGO_URI env var or create aaziko/.secrets/mongo-uri.txt');
}

async function connect() {
  if (_client) return _client;
  _client = new MongoClient(getUri(), { serverSelectionTimeoutMS: 10000 });
  await _client.connect();
  return _client;
}

async function close() {
  if (_client) { await _client.close(); _client = null; }
}

/** Safe read-only query — always requires projection + limit to prevent full scans. */
async function query(dbName, collName, filter = {}, { projection = {}, limit = 100, sort = null } = {}) {
  if (!limit || limit > 10000) throw new Error(`query: limit required (max 10000), got ${limit}`);
  const c = await connect();
  const col = c.db(dbName).collection(collName);
  let cursor = col.find(filter, { projection }).limit(limit);
  if (sort) cursor = cursor.sort(sort);
  return cursor.toArray();
}

async function count(dbName, collName, filter = {}) {
  const c = await connect();
  return c.db(dbName).collection(collName).countDocuments(filter);
}

async function aggregate(dbName, collName, pipeline, { maxDocs = 5000 } = {}) {
  if (!Array.isArray(pipeline)) throw new Error('aggregate: pipeline must be array');
  const hasLimit = pipeline.some(s => '$limit' in s);
  if (!hasLimit) throw new Error('aggregate: pipeline MUST include a $limit stage — prevents full scans on 222M-row collections');
  const c = await connect();
  return c.db(dbName).collection(collName).aggregate(pipeline).toArray();
}

async function listDatabases() {
  const c = await connect();
  const result = await c.db('admin').admin().listDatabases();
  return result.databases.map(d => d.name).filter(n => !['admin', 'local', 'config'].includes(n));
}

async function listCollections(dbName) {
  const c = await connect();
  return (await c.db(dbName).listCollections().toArray()).map(x => x.name);
}

/** Safe findOne — no full scan possible */
async function findOne(dbName, collName, filter, projection = {}) {
  const c = await connect();
  return c.db(dbName).collection(collName).findOne(filter, { projection });
}

module.exports = { connect, close, query, count, aggregate, findOne, listDatabases, listCollections };
