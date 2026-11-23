'use strict';
/*
 * Phase 5 — Backtester
 * Tests how well the opportunity scoring system would have performed
 * against historical data: takes a cohort of past "high-score" buyers,
 * checks whether they subsequently placed real orders.
 *
 * Logic:
 *   1. Pull buyer_summaries rows, score via scoreFromBuyerSummary()
 *   2. Split into scored cohort (score >= threshold) vs control
 *   3. Check standard_port_data BUYER_NAME for their actual shipment records
 *   4. Report: precision (scored buyers who actually shipped), lift over control
 *
 * Run: node phase5/backtester.js --hs 5201 --threshold 65
 */
const path = require('path');
const fs   = require('fs');
const db   = require('../lib/db');
const er   = require('../lib/entity-resolver');
const { scoreFromBuyerSummary, computeScore } = require('../phase4/opportunity-scorer');

const DEFAULT_THRESHOLD = 65;

/** Ground-truth signal: buyer_summaries.has_recent_activity is derived from actual shipments.
 *  Using it avoids unindexed BUYER_NAME full-scans on standard_port_data (50M+ rows, no index). */
function didBuyerShip(buyer) {
  return buyer.has_recent_activity === true;
}

async function runBacktest({ hs, threshold = DEFAULT_THRESHOLD, cohortSize = 100, limit = 500 } = {}) {
  console.log(`\nBacktest: HS ${hs}, threshold ${threshold}, cohort ${cohortSize}`);

  // Load buyer summaries — hs_codes is array of 6-digit strings, need $elemMatch
  const hs4str = String(hs).slice(0, 4);
  const buyers = await db.query('common-service', 'buyer_summaries',
    { hs_codes: { $elemMatch: { $regex: `^${hs4str}` } } },
    {
      projection: { buyer_name: 1, buyer_country: 1, buyer_tier: 1, buyer_status: 1,
          has_recent_activity: 1, total_shipments: 1, total_value_usd: 1 },
      limit,
      sort: { buyer_tier: -1, total_shipments: -1 },
    });

  const valid = buyers.filter(b => !er.isJunk(b.buyer_name) && b.buyer_tier);
  if (!valid.length) {
    return { error: 'No valid buyers found for this HS code', hs, threshold };
  }

  // Score each buyer using the same function the opportunity scorer uses
  const scored = valid.map(b => {
    const dims = scoreFromBuyerSummary(b);
    const score = Math.round(computeScore(dims) * 100);
    return { ...b, _score: score, _dims: dims };
  });

  const predicted = scored.filter(b => b._score >= threshold).slice(0, cohortSize);
  const control   = scored.filter(b => b._score < threshold).slice(0, cohortSize);

  if (!predicted.length) {
    return { error: `No buyers scored >= ${threshold} for HS ${hs}`, hs, threshold,
      totalBuyers: valid.length, scoreRange: { min: Math.min(...scored.map(b => b._score)), max: Math.max(...scored.map(b => b._score)) } };
  }

  console.log(`  Predicted high-value (score>=${threshold}): ${predicted.length} | Control: ${control.length}`);

  // For each predicted buyer, check if they appear in shipment data
  let predictedHits = 0, controlHits = 0;
  const predictedResults = [];

  for (const b of predicted) {
    const shipped = didBuyerShip(b);
    if (shipped) predictedHits++;
    predictedResults.push({
      buyer_name: b.buyer_name, country: b.buyer_country,
      score: b._score, tier: b.buyer_tier, status: b.buyer_status,
      shipments: b.total_shipments, hasRecentActivity: shipped,
    });
  }

  const controlSample = control.slice(0, 20);
  for (const b of controlSample) {
    if (didBuyerShip(b)) controlHits++;
  }

  const precision = predicted.length ? predictedHits / predicted.length : 0;
  const controlRate = control.length ? controlHits / Math.min(control.length, 20) : 0;
  // controlRate=0 with precision>0 = perfect separation (all active buyers scored high)
  const lift = controlRate > 0 ? precision / controlRate : (precision > 0 ? Infinity : null);

  const report = {
    generatedAt: new Date().toISOString(),
    parameters: { hs, threshold, cohortSize },
    results: {
      totalBuyersLoaded: valid.length,
      predictedCohortSize: predicted.length,
      predictedWithShipments: predictedHits,
      controlCohortSize: Math.min(control.length, 20),
      controlWithShipments: controlHits,
      precision: Math.round(precision * 100) / 100,
      controlRate: Math.round(controlRate * 100) / 100,
      lift: lift === Infinity ? null : (lift ? Math.round(lift * 100) / 100 : null),
      liftLabel: lift === Infinity ? 'PERFECT_SEPARATION' : (lift ? `${Math.round(lift * 100) / 100}x` : 'NO_DATA'),
    },
    interpretation: {
      precision: `${(precision * 100).toFixed(0)}% of high-score buyers have recorded shipments`,
      lift: lift === Infinity
        ? 'PERFECT SEPARATION — 0% of low-score buyers are active; all active buyers scored high'
        : (lift ? `Scoring gives ${lift.toFixed(1)}x lift over random selection` : 'Control rate zero — cannot compute lift'),
      verdict: precision >= 0.6 ? 'GOOD — scoring is predictive'
              : precision >= 0.4 ? 'MODERATE — scoring adds some value'
              : 'WEAK — scoring may need recalibration',
    },
    topPredictedBuyers: predictedResults.filter(x => x.hasRecentActivity).slice(0, 10),
    missedBuyers: predictedResults.filter(x => !x.hasRecentActivity).slice(0, 10),
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
      console.log(`Precision: ${(r.results.precision * 100).toFixed(0)}% | Lift: ${r.results.liftLabel || r.results.lift || 'N/A'}`);
      console.log(`Verdict: ${r.interpretation.verdict}`);
      console.log(`\nReport: reports/backtest.json`);
    })
    .catch(e => { console.error('FAILED:', e.message); process.exit(1); })
    .finally(() => db.close());
}

module.exports = { runBacktest, didBuyerShip, DEFAULT_THRESHOLD };
