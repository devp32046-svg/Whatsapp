'use strict';
/*
 * Phase 1 — Data Inventory Agent
 * Enumerates all accessible databases, collections, record counts, and schema snapshots.
 * Output: structured inventory object + writes reports/inventory.json.
 * Run: node aaziko/super-intelligence/phase1/inventory.js
 */
const path = require('path');
const fs   = require('fs');
const db   = require('../lib/db');

// Key DBs for Super-Intelligence (from WIRING-PLAN.md + discovery-report.json)
const PRIORITY_DBS = {
  'common-service':    ['buyer_summaries', 'supplier_summaries', 'standard_port_data', 'companies'],
  'outbound_email':    ['contacts', 'companies', 'messages', 'inboundemails', 'suppressions', 'campaigns', 'sendingidentities'],
  'Dhruval2':          ['macmap_tariff', 'macmap_regulatory'],
  'trade_intelligence':['entity_product_profiles'],
  'indiamart':         ['products', 'leads'],
  'tradeindia_db':     ['products'],
  'service-provider':  ['freightservicepricings'],
};

async function sampleSchema(dbName, collName, sampleSize = 3) {
  try {
    const docs = await db.query(dbName, collName, {}, { limit: sampleSize });
    if (!docs.length) return { fields: {}, sample: [] };
    const fields = {};
    for (const doc of docs) {
      for (const [k, v] of Object.entries(doc)) {
        if (fields[k]) continue;
        fields[k] = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
      }
    }
    return { fields, recordCount: null };
  } catch (e) {
    return { error: e.message };
  }
}

async function runInventory({ priorityOnly = false } = {}) {
  const report = {
    generatedAt: new Date().toISOString(),
    databases: {},
  };

  let dbList;
  if (priorityOnly) {
    dbList = Object.keys(PRIORITY_DBS);
  } else {
    dbList = await db.listDatabases();
  }

  console.log(`Inventorying ${dbList.length} databases...`);

  for (const dbName of dbList) {
    report.databases[dbName] = { collections: {} };
    const collNames = priorityOnly && PRIORITY_DBS[dbName]
      ? PRIORITY_DBS[dbName]
      : await db.listCollections(dbName);

    for (const collName of collNames) {
      process.stdout.write(`  ${dbName}.${collName} ... `);
      try {
        const cnt = await db.count(dbName, collName, {});
        const schema = await sampleSchema(dbName, collName);
        report.databases[dbName].collections[collName] = {
          count: cnt,
          ...schema,
        };
        console.log(`${cnt.toLocaleString()} docs`);
      } catch (e) {
        report.databases[dbName].collections[collName] = { error: e.message };
        console.log(`ERROR: ${e.message}`);
      }
    }
  }

  // Write report
  const outPath = path.resolve(__dirname, '../reports/inventory.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nInventory written to ${outPath}`);

  return report;
}

function summarize(report) {
  const lines = [`\n=== SUPER-INTELLIGENCE DATA INVENTORY ===`];
  lines.push(`Generated: ${report.generatedAt}`);
  for (const [dbName, dbData] of Object.entries(report.databases)) {
    const colls = Object.entries(dbData.collections);
    const totalDocs = colls.reduce((s, [, v]) => s + (v.count || 0), 0);
    lines.push(`\n${dbName} (${colls.length} collections, ${totalDocs.toLocaleString()} total docs)`);
    for (const [collName, cData] of colls) {
      if (cData.error) {
        lines.push(`  ✗ ${collName}: ERROR — ${cData.error}`);
      } else {
        const fieldCount = Object.keys(cData.fields || {}).length;
        lines.push(`  ✓ ${collName}: ${(cData.count || 0).toLocaleString()} docs, ${fieldCount} fields`);
      }
    }
  }
  return lines.join('\n');
}

if (require.main === module) {
  const priorityOnly = process.argv.includes('--priority');
  runInventory({ priorityOnly })
    .then(r => console.log(summarize(r)))
    .catch(e => { console.error('FAILED:', e.message); process.exit(1); })
    .finally(() => db.close());
}

module.exports = { runInventory, summarize, PRIORITY_DBS };
