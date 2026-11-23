'use strict';
/*
 * Phase 1 — Entity Map Builder
 * Finds companies/buyers/suppliers that appear across multiple DBs.
 * Builds a cross-reference map: canonical_key → {sources, bestName, dbPresence}
 * Output: reports/entity-map.json
 * Run: node aaziko/super-intelligence/phase1/entity-map.js
 */
const path = require('path');
const fs   = require('fs');
const db   = require('../lib/db');
const er   = require('../lib/entity-resolver');

const ENTITY_SOURCES = [
  { db: 'common-service',  coll: 'companies',         nameField: 'companyName', idField: '_id', limit: 2000 },
  { db: 'common-service',  coll: 'buyer_summaries',   nameField: 'buyer_name',  idField: '_id', limit: 5000 },
  { db: 'common-service',  coll: 'supplier_summaries', nameField: 'supplier_name', idField: '_id', limit: 5000 },
  { db: 'outbound_email',  coll: 'companies',         nameField: 'name',        idField: '_id', limit: 2000 },
  { db: 'outbound_email',  coll: 'contacts',          nameField: 'companyName', idField: '_id', limit: 2000 },
];

async function buildEntityMap() {
  const map = new Map(); // canonicalKey → { bestName, sources: [{db, coll, id}], count }

  for (const src of ENTITY_SOURCES) {
    console.log(`Loading ${src.db}.${src.coll}...`);
    let docs;
    try {
      docs = await db.query(src.db, src.coll, {}, {
        projection: { [src.nameField]: 1, [src.idField]: 1 },
        limit: src.limit,
      });
    } catch (e) {
      console.log(`  SKIP (${e.message})`);
      continue;
    }

    let added = 0;
    for (const doc of docs) {
      const name = doc[src.nameField];
      if (er.isJunk(name)) continue;
      const key = er.canonicalKey(name);
      if (!key || key.length < 3) continue;

      if (!map.has(key)) {
        map.set(key, { bestName: name, sources: [], count: 0, dbSet: new Set() });
      }
      const entry = map.get(key);
      entry.count++;
      entry.dbSet.add(`${src.db}.${src.coll}`);
      entry.sources.push({ db: src.db, coll: src.coll, id: String(doc[src.idField]) });
      added++;
    }
    console.log(`  Added ${added} entities (${map.size} unique so far)`);
  }

  // Convert to serializable format, filter to entities with cross-DB presence
  const result = { generatedAt: new Date().toISOString(), entities: {}, stats: {} };
  let crossDb = 0, singleDb = 0;

  for (const [key, entry] of map) {
    const dbPresence = [...entry.dbSet];
    const record = {
      bestName: entry.bestName,
      canonicalKey: key,
      dbPresence,
      totalMentions: entry.count,
      isCrossDb: dbPresence.length > 1,
    };
    result.entities[key] = record;
    if (dbPresence.length > 1) crossDb++;
    else singleDb++;
  }

  result.stats = {
    totalUniqueEntities: map.size,
    crossDbEntities: crossDb,
    singleDbEntities: singleDb,
  };

  const outPath = path.resolve(__dirname, '../reports/entity-map.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nEntity map: ${outPath}`);
  console.log(`Total: ${map.size.toLocaleString()} unique entities`);
  console.log(`Cross-DB: ${crossDb} | Single-DB: ${singleDb}`);

  return result;
}

if (require.main === module) {
  buildEntityMap()
    .catch(e => { console.error('FAILED:', e.message); process.exit(1); })
    .finally(() => db.close());
}

module.exports = { buildEntityMap };
