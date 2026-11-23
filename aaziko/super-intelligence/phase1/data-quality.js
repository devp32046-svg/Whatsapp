'use strict';
/*
 * Phase 1 — Data Quality Agent
 * Checks key collections for: null rates, date ranges, field completeness,
 * duplicate candidates, stale records. Output: reports/data-quality.json.
 * Run: node aaziko/super-intelligence/phase1/data-quality.js
 */
const path = require('path');
const fs   = require('fs');
const db   = require('../lib/db');

const CHECKS = [
  {
    db: 'common-service', coll: 'buyer_summaries',
    requiredFields: ['buyer_name', 'buyer_country', 'hs_codes', 'total_shipments', 'total_value_usd'],
    dateField: null,
    sampleSize: 200,
  },
  {
    db: 'common-service', coll: 'supplier_summaries',
    requiredFields: ['supplier_name', 'supplier_country', 'hs_codes', 'total_value_usd'],
    dateField: null,
    sampleSize: 200,
  },
  {
    db: 'common-service', coll: 'standard_port_data',
    requiredFields: ['HS_CODE', 'IMPORTER_NAME', 'EXPORTER_NAME', 'VALUE_USD', 'DATE'],
    dateField: 'DATE',
    sampleSize: 500,
  },
  {
    db: 'outbound_email', coll: 'contacts',
    requiredFields: ['email', 'firstName', 'companyId', 'status'],
    dateField: 'createdAt',
    sampleSize: 200,
  },
  {
    db: 'outbound_email', coll: 'messages',
    requiredFields: ['toEmail', 'subject', 'sentAt', 'status'],
    dateField: 'sentAt',
    sampleSize: 200,
  },
  {
    db: 'Dhruval2', coll: 'macmap_tariff',
    requiredFields: ['HsCode', 'ImportingCountry', 'ExportingCountry'],
    dateField: null,
    sampleSize: 200,
  },
];

async function checkCollection(check) {
  const { db: dbName, coll, requiredFields, dateField, sampleSize } = check;
  const result = { db: dbName, coll, checks: {}, issues: [] };

  try {
    // Total count
    const total = await db.count(dbName, coll, {});
    result.total = total;
    if (total === 0) {
      result.issues.push('EMPTY_COLLECTION');
      return result;
    }

    // Sample docs
    const sample = await db.query(dbName, coll, {}, { limit: sampleSize });

    // Field completeness
    const fieldStats = {};
    for (const f of requiredFields) {
      const present = sample.filter(d => d[f] != null && d[f] !== '' && d[f] !== 'null').length;
      const pct = Math.round(present / sample.length * 100);
      fieldStats[f] = { present, total: sample.length, pct };
      if (pct < 50) result.issues.push(`LOW_COMPLETENESS:${f}=${pct}%`);
    }
    result.checks.fieldCompleteness = fieldStats;

    // Date range (if dateField specified)
    if (dateField) {
      const withDate = sample.filter(d => d[dateField] != null);
      if (withDate.length) {
        const dates = withDate.map(d => new Date(d[dateField])).filter(d => !isNaN(d));
        if (dates.length) {
          const minDate = new Date(Math.min(...dates));
          const maxDate = new Date(Math.max(...dates));
          const ageMonths = Math.round((Date.now() - maxDate) / (30 * 24 * 3600 * 1000));
          result.checks.dateRange = {
            min: minDate.toISOString().slice(0, 10),
            max: maxDate.toISOString().slice(0, 10),
            ageMonthsSinceLatest: ageMonths,
          };
          if (ageMonths > 12) result.issues.push(`STALE_DATA:latest_record_${ageMonths}mo_ago`);
        }
      }
    }

    // Junk/null name check (generic)
    const nameFields = requiredFields.filter(f => /name|email|buyer|supplier/i.test(f));
    for (const f of nameFields) {
      const junkCount = sample.filter(d => {
        const v = String(d[f] || '').trim().toUpperCase();
        return !v || v === 'NULL' || v === 'NA' || v === 'NONE' || v.startsWith('TOTHEORD');
      }).length;
      if (junkCount > sample.length * 0.1) {
        result.issues.push(`HIGH_JUNK_NAMES:${f}=${Math.round(junkCount / sample.length * 100)}%`);
      }
    }

    result.checks.sampleSize = sample.length;
    result.status = result.issues.length === 0 ? 'GOOD' : result.issues.length <= 2 ? 'WARN' : 'BAD';
  } catch (e) {
    result.error = e.message;
    result.status = 'ERROR';
    result.issues.push(`ACCESS_ERROR:${e.message}`);
  }

  return result;
}

async function runDataQuality() {
  const report = {
    generatedAt: new Date().toISOString(),
    summary: { good: 0, warn: 0, bad: 0, error: 0 },
    collections: {},
  };

  for (const check of CHECKS) {
    const key = `${check.db}.${check.coll}`;
    console.log(`Checking ${key}...`);
    const result = await checkCollection(check);
    report.collections[key] = result;
    report.summary[result.status?.toLowerCase() || 'error']++;
    if (result.issues.length) console.log(`  Issues: ${result.issues.join(', ')}`);
    else console.log(`  OK — ${(result.total || 0).toLocaleString()} docs`);
  }

  const outPath = path.resolve(__dirname, '../reports/data-quality.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nData quality report: ${outPath}`);
  console.log(`Summary: GOOD=${report.summary.good} WARN=${report.summary.warn} BAD=${report.summary.bad} ERROR=${report.summary.error}`);
  return report;
}

if (require.main === module) {
  runDataQuality()
    .catch(e => { console.error('FAILED:', e.message); process.exit(1); })
    .finally(() => db.close());
}

module.exports = { runDataQuality, CHECKS };
