/*
 * aaziko-jarvis-schema.js — creates Jarvis's OWN net-new collections + indexes.
 * These are SEPARATE from Aaziko's production data (source data is never touched).
 * Run only when a read-write user for the new DBs is provided:
 *     set AAZIKO_JARVIS_RW_URI=mongodb://<rw-user>:<pass>@100.70.212.45:27017/?authSource=admin
 *     node aaziko/scripts/aaziko-jarvis-schema.js
 * Idempotent: skips collections/indexes that already exist.
 */
let MongoClient;
try { ({ MongoClient } = require('mongodb')); }
catch (e) { console.error('mongodb driver missing. Run: npm i mongodb'); process.exit(1); }

const URI = process.env.AAZIKO_JARVIS_RW_URI;
if (!URI) { console.error('Set AAZIKO_JARVIS_RW_URI (read-write) first.'); process.exit(1); }

// { db: { collection: [ {keys}, {keys, opts} ... indexes ] } }
const SCHEMA = {
  aaziko_jarvis: {
    events: [{ sourceMsgId: 1 }, { type: 1 }, { receivedAt: -1 }],
    cases: [{ case_id: 1 }, { entity_id: 1 }, { stage: 1 }, { next_review_at: 1 }, { waiting_on: 1 }],
    tasks: [{ owner: 1 }, { status: 1 }, { due: 1 }, { case_id: 1 }],
    commitments: [{ party: 1 }, { done: 1 }, { dueAt: 1 }, { case_id: 1 }],
    communication_history: [{ case_id: 1 }, { buyer_id: 1 }, { message_ref: 1 }, { direction: 1 }],
    actions: [{ action_id: 1 }, { case_id: 1 }, { idempotencyKey: 1 }, { state: 1 }],
    reviews: [{ case_id: 1 }, { nextReviewAt: 1 }, { status: 1 }],
    outcomes: [{ case_id: 1 }, { label: 1 }, { at: -1 }],
    agent_audit: [{ agent: 1 }, { skill: 1 }, { at: -1 }]
  },
  aaziko_intelligence: {
    entities: [{ entity_id: 1 }, { 'sourceIds.companyId': 1 }, { name: 1 }],
    buyer_profiles: [{ entity_id: 1 }, { version: -1 }],
    opportunities: [{ entity_id: 1 }, { hs: 1 }, { status: 1 }],
    commercial_lanes: [{ hs: 1 }, { destination: 1 }, { asOf: -1 }]
  }
};

// Fields that must be globally unique get unique indexes.
const UNIQUE = {
  'aaziko_jarvis.events': 'sourceMsgId',
  'aaziko_jarvis.cases': 'case_id',
  'aaziko_jarvis.actions': 'idempotencyKey',
  'aaziko_intelligence.entities': 'entity_id'
};

// Per-op server-side timeout so a stuck replica-set index build can NEVER hang the
// script — it returns MaxTimeMSExpired (caught) instead of blocking forever.
const OP_MS = Number(process.env.AAZIKO_OP_MS || 8000);
// AAZIKO_SKIP_INDEXES=1 -> create collections only (do NOT attempt index builds).
// Use when the cluster is blocking index builds, so we don't leave stuck builds behind.
const SKIP_IDX = process.env.AAZIKO_SKIP_INDEXES === '1';

(async () => {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 15000 });
  const made = []; const deferred = [];
  try {
    await client.connect();
    console.log('Connected. (per-op timeout ' + OP_MS + 'ms; indexes are best-effort)');
    for (const [dbName, colls] of Object.entries(SCHEMA)) {
      const db = client.db(dbName);
      const existing = (await db.listCollections().toArray()).map(c => c.name);
      for (const [coll, indexes] of Object.entries(colls)) {
        const fq = dbName + '.' + coll;
        if (!existing.includes(coll)) {
          try { await db.createCollection(coll, { maxTimeMS: OP_MS }); console.log('  created', fq); made.push(fq); }
          catch (e) { console.log('  coll FAIL', fq, '-', e.codeName || e.message); continue; }
        } else { console.log('  exists ', fq); }
        if (SKIP_IDX) { continue; }
        const c = db.collection(coll);
        for (const keys of indexes) {
          const field = Object.keys(keys)[0];
          const unique = (UNIQUE[fq] === field);
          const opts = unique ? { unique: true, maxTimeMS: OP_MS } : { maxTimeMS: OP_MS };
          try { const name = await c.createIndex(keys, opts); console.log('      idx', name, unique ? '(unique)' : ''); }
          catch (e) { console.log('      idx DEFER', JSON.stringify(keys), '-', e.codeName || e.message.split('\n')[0]); deferred.push(fq + ' ' + JSON.stringify(keys) + (unique ? ' UNIQUE' : '')); }
        }
      }
    }
    console.log('\n--- SUMMARY ---');
    console.log('collections created this run:', made.length ? made.join(', ') : '(none new)');
    if (SKIP_IDX) {
      console.log('indexes SKIPPED (AAZIKO_SKIP_INDEXES=1) — collections only. Re-run without the flag,');
      console.log('on a quiet cluster, to add indexes (idempotent).');
    } else if (deferred.length) {
      console.log('indexes DEFERRED (cluster blocked index builds): ' + deferred.length);
      deferred.forEach(d => console.log('  - ' + d));
      console.log('\nCollections exist & are usable NOW. Re-run this script when the cluster is quiet');
      console.log('(it is idempotent) OR have ops create the DEFERRED indexes in a maintenance window.');
    } else {
      console.log('All indexes created. Jarvis DBs fully ready (source data untouched).');
    }
  } catch (e) {
    console.error('FATAL:', e.message);
  } finally {
    await client.close();
  }
})();
