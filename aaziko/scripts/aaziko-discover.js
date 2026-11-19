/*
 * aaziko-discover.js — Phase 0 READ-ONLY discovery for ATES Jarvis.
 * Run the instant a read-only connection string is available:
 *     set AAZIKO_RO_URI=mongodb://<ro-user>:<pass>@100.70.212.45:27017/?authSource=admin
 *     node aaziko/scripts/aaziko-discover.js
 *
 * Does ONLY read ops: listDatabases, listCollections, estimatedDocumentCount, find(limit 3), indexes.
 * NO writes, ever. Writes a local report; raw document VALUES are NOT saved (only field names + types).
 */
const path = require('path');
const fs = require('fs');
let MongoClient;
try { ({ MongoClient } = require('mongodb')); }
catch (e) { console.error('mongodb driver missing. Run: npm i mongodb'); process.exit(1); }

const URI = process.env.AAZIKO_RO_URI;
if (!URI) { console.error('Set AAZIKO_RO_URI (read-only connection string) first.'); process.exit(1); }

// Sales-slice targets from the system inventory. Empty array = enumerate all collections in that DB.
const TARGETS = {
  'common-service': ['companies','buyers','contacts','deals','leads',
    'standard_port_data','shortlist_buyer_seller','buyer_summaries','supplier_summaries',
    'hs_code_summaries','market_medians_by_hs',
    'products','hscodes','orders','quotes','negotiations','samples',
    'messages','inboundemails','messageevents','campaigns','sendingidentities','suppressions','unsubscribes',
    'compliancerequirements','certificates','freightorders','shippinglines','shipmenttrackings','ports'],
  'Dhruval2': [],
  'Dhruval': ['shortlist_buyer_seller'],
  'trade_intelligence': [],
  'outbound_email': [],
  'product-service': [],
  'vendor-service': [],
  'admincrm-service': [],
  'order-service': [],
  'lsq-service': [],
  'custom30': []
};

function inferSchema(docs) {
  const fields = {};
  for (const d of docs) {
    for (const [k, v] of Object.entries(d)) {
      const t = Array.isArray(v) ? 'array' : (v === null ? 'null' : typeof v);
      if (!fields[k]) fields[k] = t;
    }
  }
  return fields; // names + types only — no raw values persisted
}

(async () => {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 15000 });
  const report = {
    host: URI.replace(/\/\/[^@]*@/, '//<redacted>@'),
    at: new Date().toISOString(),
    allDatabases: [],
    databases: {}
  };
  try {
    await client.connect();
    console.log('Connected (read-only).');
    let allDbs = [];
    try { allDbs = (await client.db().admin().listDatabases()).databases.map(d => d.name); }
    catch (e) { allDbs = Object.keys(TARGETS); console.log('listDatabases not permitted; using target list.'); }
    report.allDatabases = allDbs;
    console.log('Databases visible:', allDbs.length);

    for (const [dbName, wanted] of Object.entries(TARGETS)) {
      if (allDbs.length && !allDbs.includes(dbName)) {
        report.databases[dbName] = { MISSING: true };
        console.log('  [MISSING]', dbName);
        continue;
      }
      const db = client.db(dbName);
      let colls = [];
      try { colls = (await db.listCollections().toArray()).map(c => c.name); }
      catch (e) { report.databases[dbName] = { ERROR: e.message }; console.log('  [ERR]', dbName, e.message); continue; }
      const list = wanted.length ? wanted : colls;
      const dbRep = { collectionsTotal: colls.length, collections: {} };
      for (const c of list) {
        if (!colls.includes(c)) { dbRep.collections[c] = { MISSING: true }; continue; }
        const coll = db.collection(c);
        const entry = { count: null, fields: {}, indexes: [] };
        try { entry.count = await coll.estimatedDocumentCount(); } catch (e) { entry.countError = e.message; }
        try { entry.fields = inferSchema(await coll.find({}).limit(3).toArray()); } catch (e) { entry.sampleError = e.message; }
        try { entry.indexes = (await coll.indexes()).map(i => i.name); } catch (e) { entry.indexError = e.message; }
        dbRep.collections[c] = entry;
      }
      report.databases[dbName] = dbRep;
      console.log('  [OK]', dbName, '—', colls.length, 'collections;', list.length, 'inspected');
    }
  } catch (e) {
    console.error('FATAL:', e.message);
    report.fatal = e.message;
  } finally {
    await client.close();
  }
  const out = path.resolve(__dirname, '..', 'discovery-report.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('\nWROTE', out);
  console.log('Next: fill the ⚠ field filters in WIRING-PLAN.md from this report, then wire the n8n nodes.');
})();
