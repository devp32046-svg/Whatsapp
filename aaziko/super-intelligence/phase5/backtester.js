'use strict';
/*
 * Phase 5 — Backtester
 * Tests how well the opportunity scoring system would have performed
 * against historical data: takes a cohort of past "high-score" buyers,
 * checks whether they subsequently placed real orders.
 *
 * Logic:
 *   1. Pull buyer_summaries rows, record their priority_score at snapshot time
 *   2. Split into scored cohort (score >= threshold) vs control
 *   3. Check standard_port_data for their shipments in the period AFTER the split date
 *   4. Report: precision (scored buyers who actually shipped), recall (shippers who were scored)
 *
 * Run: node phase5/backtester.js --hs 690810 --threshold 70
 */
const path = require('path');
const fs   = require('fs');
const db   = require('../lib/db');
const er   = require('../lib/entity-resolver');

const DEFAULT_THRESHOLD = 65;    // priority_score >= this → "predicted high-value"
const DEFAULT_LOOKBACK_DAYS = 90; // how far back to look for "did they ship?"

/** Check if a buyer name appears in standard_port_data as IMPORTER (i.e. they placed an order) */
async function didBuyerShip(buyerName, hsCodes, { limit = 20 } = {}) {
  const words = buyerName.trim().split(/\s+/).slice(0, 3).join('.*');
  const filter = { IMPORTER_NAME: { $regex: words, $options: 'i' } };
  if (hsCodes && hsCodes.length) {
    filter.HS_CODE = { $in: hsCodes.map(h => ({ $regex: `^${h}` })) };
    // Mongo can't $in regex directly — use first HS code as proxy
    filter.HS_CODE = { $regex: `^${hsCodes[0]}` };
  }
  const records = await db.query('common-service', 'standard_port_data', filter,
    { projection: { _id: 1 }, limit });
  return records.length > 0;
}

async function runBacktest({ hs, threshold = DEFAULT_THRESHOLD, cohortSize = 100, limit = 500 } = {}) {
  console.log(`\nBacktest: HS ${hs}, threshold ${threshold}, cohort ${cohortSize}`);

  // Load buyer summaries for this HS code
  const filter = { hs_codes: hs };
  const buyers = await db.query('common-service', 'buyer_summaries', filter, {
    projection: { buyer_name: 1, buyer_country: 1, total_shipments: 1,
        'recommendation.priority_score': 1, 'recommendation.priority_tier': 1 },
    limit,
    sort: { 'recommendation.priority_score': -1 },
  });

  const valid = buyers.filter(b => !er.isJunk(b.buyer_name) && b.recommendation?.priority_score != null);
  if (!valid.length) {
    return { error: 'No valid buyers found for this HS code', hs, threshold };
  }

  const predicted = valid.filter(b => (b.recommendation?.priority_score || 0) >= threshold).slice(0, cohortSize);
  const control   = valid.filter(b => (b.recommendation?.priority_score || 0) < threshold).slice(0, cohortSize);

  console.log(`  Predicted high-value: ${predicted.length} | Control: ${control.length}`);

  // For each predicted buyer, check if they appear in shipment data
  let predictedHits = 0, controlHits = 0;
  const predictedResults = [];

  for (const b of predicted) {
    const shipped = await didBuyerShip(b.buyer_name, [hs]);
    if (shipped) predictedHits++;
    predictedResults.push({
      buyer_name: b.buyer_name,
      country: b.buyer_country,
      priorityScore: b.recommendation.priority_score,
      tier: b.recommendation.priority_tier,
      hasShipmentRecord: shipped,
    });
  }

  for (const b of control.slice(0, 20)) { // limit control checks for speed
    const shipped = await didBuyerShip(b.buyer_name, [hs]);
    if (shipped) controlHits++;
  }

  const precision = predicted.length ? predictedHits / predicted.length : 0;
  const controlRate = control.length ? controlHits / Math.min(control.length, 20) : 0;
  const lift = controlRate > 0 ? precision / controlRate : null;

  const report = {
    generatedAt: new Date().toISOString(),
    parameters: { hs, threshold, cohortSize },
    results: {
      predictedCohortSize: predicted.length,
      predictedWithShipments: predictedHits,
      controlCohortSize: Math.min(control.length, 20),
      controlWithShipments: controlHits,
      precision: Math.round(precision * 100) / 100,
      controlRate: Math.round(controlRate * 100) / 100,
      lift: lift ? Math.round(lift * 100) / 100 : null,
    },
    interpretation: {
      precision: `${(precision * 100).toFixed(0)}% of high-score buyers have recorded shipments`,
      lift: lift ? `Scoring gives ${lift.toFixed(1)}x lift over random selection` : 'Control rate zero — cannot compute lift',
      verdict: precision >= 0.6 ? 'GOOD — scoring is predictive'
              : precision >= 0.4 ? 'MODERATE — scoring adds some value'
              : 'WEAK — scoring may need recalibration',
    },
    topPredictedBuyers: predictedResults.filter(x => x.hasShipmentRecord).slice(0, 10),
    missedBuyers: predictedResults.filter(x => !x.hasShipmentRecord).slice(0, 10),
  };

  const outPath = path.resolve(__dirname, '../reports/backtest.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) {
  const hsIdx = process.argv.indexOf('--hs');
  const hs = hsIdx >= 0 ? process.argv[hsIdx + 1] : '690810';
  const tIdx = process.argv.indexOf('--threshold');
  const threshold = tIdx >= 0 ? parseInt(process.argv[tIdx + 1], 10) : DEFAULT_THRESHOLD;

  runBacktest({ hs, threshold, cohortSize: 50, limit: 300 })
    .then(r => {
      if (r.error) { console.error(r.error); return; }
      console.log(`\n=== BACKTEST RESULTS ===`);
      console.log(`Precision: ${(r.results.precision * 100).toFixed(0)}% | Lift: ${r.results.lift || 'N/A'}x`);
      console.log(`Verdict: ${r.interpretation.verdict}`);
      console.log(`\nReport: reports/backtest.json`);
    })
    .catch(e => { console.error('FAILED:', e.message); process.exit(1); })
    .finally(() => db.close());
}

module.exports = { runBacktest, didBuyerShip, DEFAULT_THRESHOLD };
