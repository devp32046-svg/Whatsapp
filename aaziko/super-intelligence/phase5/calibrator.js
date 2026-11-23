'use strict';
/*
 * Phase 5 — Score Calibrator
 * Adjusts scoring weights based on backtesting results.
 * Uses a simple hill-climbing approach: varies each weight dimension ±20%,
 * re-runs backtest precision, keeps the direction that improved.
 *
 * Also produces a calibration report showing which dimensions matter most.
 *
 * Run: node phase5/calibrator.js --hs 690810
 */
const path = require('path');
const fs   = require('fs');
const db   = require('../lib/db');
const er   = require('../lib/entity-resolver');
const { didBuyerShip, DEFAULT_THRESHOLD } = require('./backtester');
const { SCORE_DIMENSIONS, computeScore }  = require('../phase4/opportunity-scorer');

const STEP_SIZE = 0.1;  // ±10% weight adjustment per step
const MAX_ITERS = 20;   // max hill-climbing iterations

/** Score buyers using a given weight override and check precision against shipment data */
async function evalWeights(buyers, hsCodes, weights) {
  const scored = buyers.map(b => {
    const rec = b.recommendation || {};
    const priorityScore = rec.priority_score != null ? rec.priority_score / 100 : 0.5;
    const totalValue = b.total_value_usd || 0;
    const dims = {
      commercial_value: Math.min(1, totalValue / 1_000_000),
      probability:      priorityScore,
      timing_urgency:   rec.priority_tier === 'A' ? 0.9 : rec.priority_tier === 'B' ? 0.6 : 0.3,
      data_quality:     (b.total_shipments || 0) > 10 ? 0.8 : 0.4,
      margin_potential: 0.5,
      competitive_adv:  0.5,
      execution_ease:   0.6,
    };

    // Apply custom weights
    let total = 0, weightUsed = 0;
    for (const [dim, val] of Object.entries(dims)) {
      const w = weights[dim] != null ? weights[dim] : SCORE_DIMENSIONS[dim]?.weight || 0;
      total += Math.max(0, Math.min(1, val)) * w;
      weightUsed += w;
    }
    const score = weightUsed > 0 ? total / weightUsed : 0;
    return { ...b, _score: score };
  });

  scored.sort((a, b) => b._score - a._score);
  const topN = scored.slice(0, Math.min(30, Math.floor(scored.length * 0.3)));

  let hits = 0;
  for (const b of topN.slice(0, 20)) { // limit checks for speed
    const shipped = await didBuyerShip(b.buyer_name, hsCodes);
    if (shipped) hits++;
  }
  return topN.length ? hits / Math.min(topN.length, 20) : 0;
}

async function calibrate({ hs, maxIters = MAX_ITERS, cohortLimit = 200 } = {}) {
  console.log(`\nCalibrating scoring weights for HS ${hs}...`);

  const buyers = await db.query('common-service', 'buyer_summaries',
    { hs_codes: hs, 'recommendation.priority_score': { $gt: 0 } },
    { projection: { buyer_name: 1, total_value_usd: 1, total_shipments: 1,
        'recommendation.priority_score': 1, 'recommendation.priority_tier': 1 },
      limit: cohortLimit });

  const valid = buyers.filter(b => !er.isJunk(b.buyer_name));
  if (valid.length < 20) {
    return { error: `Only ${valid.length} valid buyers — need >= 20 for calibration`, hs };
  }

  console.log(`  Cohort: ${valid.length} buyers`);

  // Start with current weights
  const currentWeights = Object.fromEntries(
    Object.entries(SCORE_DIMENSIONS).map(([k, v]) => [k, v.weight])
  );

  let bestWeights = { ...currentWeights };
  let bestPrecision = await evalWeights(valid, [hs], bestWeights);
  console.log(`  Baseline precision: ${(bestPrecision * 100).toFixed(1)}%`);

  const history = [{ iter: 0, precision: bestPrecision, weights: { ...bestWeights } }];
  const dimensions = Object.keys(currentWeights);

  for (let iter = 0; iter < maxIters; iter++) {
    let improved = false;

    for (const dim of dimensions) {
      for (const direction of [+STEP_SIZE, -STEP_SIZE]) {
        const candidate = { ...bestWeights };
        candidate[dim] = Math.max(0.01, Math.min(0.5, (candidate[dim] || 0) + direction));

        // Normalize weights to sum to 1
        const total = Object.values(candidate).reduce((s, v) => s + v, 0);
        for (const k of Object.keys(candidate)) candidate[k] = candidate[k] / total;

        const precision = await evalWeights(valid, [hs], candidate);
        if (precision > bestPrecision + 0.01) {
          bestPrecision = precision;
          bestWeights = { ...candidate };
          improved = true;
          console.log(`  Iter ${iter + 1}: improved ${dim} ${direction > 0 ? '+' : ''}${(direction * 100).toFixed(0)}% → precision ${(precision * 100).toFixed(1)}%`);
          history.push({ iter: iter + 1, dim, direction, precision, weights: { ...bestWeights } });
          break;
        }
      }
      if (improved) break;
    }

    if (!improved) {
      console.log(`  Converged after ${iter + 1} iterations`);
      break;
    }
  }

  // Dimension importance: how much each weight changed
  const importance = Object.fromEntries(
    dimensions.map(dim => [dim, {
      originalWeight: currentWeights[dim],
      calibratedWeight: bestWeights[dim],
      delta: Math.round((bestWeights[dim] - currentWeights[dim]) * 1000) / 1000,
      label: SCORE_DIMENSIONS[dim]?.label || dim,
    }])
  );

  const report = {
    generatedAt: new Date().toISOString(),
    parameters: { hs, cohortSize: valid.length },
    calibration: {
      baselinePrecision: Math.round(history[0].precision * 100) / 100,
      finalPrecision: Math.round(bestPrecision * 100) / 100,
      improvement: Math.round((bestPrecision - history[0].precision) * 100) / 100,
      iterations: history.length - 1,
    },
    recommendedWeights: bestWeights,
    dimensionImportance: importance,
    convergenceHistory: history,
    verdict: bestPrecision > history[0].precision + 0.05
      ? 'SIGNIFICANT_IMPROVEMENT — apply recommended weights'
      : bestPrecision > history[0].precision + 0.01
        ? 'MINOR_IMPROVEMENT — optional weight update'
        : 'NO_IMPROVEMENT — current weights are near-optimal for this HS code',
  };

  const outPath = path.resolve(__dirname, '../reports/calibration.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) {
  const hsIdx = process.argv.indexOf('--hs');
  const hs = hsIdx >= 0 ? process.argv[hsIdx + 1] : '690810';

  calibrate({ hs, maxIters: 15, cohortLimit: 200 })
    .then(r => {
      if (r.error) { console.error(r.error); return; }
      console.log(`\n=== CALIBRATION RESULTS ===`);
      console.log(`Precision: ${(r.calibration.baselinePrecision * 100).toFixed(1)}% → ${(r.calibration.finalPrecision * 100).toFixed(1)}%`);
      console.log(`Verdict: ${r.verdict}`);
      console.log(`\nTop dimension shifts:`);
      Object.entries(r.dimensionImportance)
        .sort((a, b) => Math.abs(b[1].delta) - Math.abs(a[1].delta))
        .slice(0, 4)
        .forEach(([k, v]) => console.log(`  ${v.label}: ${(v.originalWeight * 100).toFixed(0)}% → ${(v.calibratedWeight * 100).toFixed(0)}% (${v.delta > 0 ? '+' : ''}${(v.delta * 100).toFixed(1)}%)`));
      console.log(`\nReport: reports/calibration.json`);
    })
    .catch(e => { console.error('FAILED:', e.message); process.exit(1); })
    .finally(() => db.close());
}

module.exports = { calibrate, evalWeights };
