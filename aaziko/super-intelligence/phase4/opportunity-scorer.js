'use strict';
/*
 * Phase 4 — Opportunity Scorer
 * Scores and ranks trade opportunities by: commercial value, probability,
 * timing urgency, data quality, margin potential, and competitive advantage.
 * Input: entity profiles, commodity trends, news events.
 * Output: ranked opportunity list with full evidence trail.
 *
 * Run: node phase4/opportunity-scorer.js --hs 690810 --origin IN
 */
const path = require('path');
const fs   = require('fs');
const db   = require('../lib/db');
const er   = require('../lib/entity-resolver');

const SCORE_DIMENSIONS = {
  commercial_value:    { weight: 0.25, label: 'Commercial value' },
  probability:         { weight: 0.20, label: 'Probability of success' },
  timing_urgency:      { weight: 0.15, label: 'Timing urgency' },
  data_quality:        { weight: 0.10, label: 'Data quality' },
  margin_potential:    { weight: 0.15, label: 'Margin potential' },
  competitive_adv:     { weight: 0.10, label: 'Competitive advantage' },
  execution_ease:      { weight: 0.05, label: 'Execution ease' },
};

const OPPORTUNITY_TYPES = {
  EMERGING_BUYER:      'A buyer showing rapid growth in imports for this product category',
  SUPPLIER_SWITCH:     'A buyer changing suppliers — opportunity to get listed',
  NEW_MARKET:          'India exporter has no presence in a destination that is actively importing',
  ARBITRAGE:           'Price gap between source and target market suggests margin opportunity',
  REGULATORY_WINDOW:   'Tariff reduction or FTA creates temporary advantage',
  VOLUME_GAP:          'Demand exceeds currently visible supply in the data',
  RELATIONSHIP_EXPAND: 'Existing buyer relationship can be expanded into adjacent HS codes',
};

function computeScore(dimensions) {
  let total = 0, weightUsed = 0;
  for (const [dim, { weight }] of Object.entries(SCORE_DIMENSIONS)) {
    const val = dimensions[dim];
    if (val == null) continue;
    total += Math.max(0, Math.min(1, val)) * weight;
    weightUsed += weight;
  }
  return weightUsed > 0 ? Math.round(total / weightUsed * 100) / 100 : 0;
}

function scoreFromBuyerSummary(buyer) {
  if (!buyer) return null;

  // buyer_tier: B4=highest value, B3=medium, B2=moderate, B1=common
  const tierScore = { B4: 0.90, B3: 0.65, B2: 0.45, B1: 0.20 }[buyer.buyer_tier] ?? 0.30;
  // buyer_status: HOT=active buyer, WARM=warming, COLD=inactive
  const statusScore = { HOT: 0.90, WARM: 0.65, COLD: 0.20 }[buyer.buyer_status] ?? 0.35;

  const totalValue = buyer.total_value_usd || 0;
  // Cap at $500M to prevent corrupt trillion-dollar rows from skewing score
  const cappedValue = Math.min(totalValue, 500_000_000);
  const commercialValue = Math.min(1, cappedValue / 1_000_000); // $1M+ = max

  return {
    commercial_value: commercialValue,
    probability:      tierScore,
    timing_urgency:   buyer.has_recent_activity ? statusScore : statusScore * 0.4,
    data_quality:     buyer.total_shipments > 20 ? 0.9 : buyer.total_shipments > 10 ? 0.7 : 0.4,
    margin_potential: 0.5,
    competitive_adv:  tierScore > 0.6 ? 0.6 : 0.4,
    execution_ease:   0.6,
  };
}

/** Find top emerging buyers for a given HS code, optionally filtered by destination country */
async function findEmergingBuyers(hs6, { destCountry = null, limit = 100, minShipments = 3,
    statusFilter = null } = {}) {
  // hs_codes is an array of 6-digit strings like ["520100","520110"] — use $elemMatch + prefix
  const hs4 = String(hs6).slice(0, 4);
  const filter = {
    hs_codes: { $elemMatch: { $regex: `^${hs4}` } },
    total_shipments: { $gte: minShipments },
  };
  if (destCountry) filter.buyer_country = destCountry;
  if (statusFilter) filter.buyer_status = { $in: statusFilter };

  const buyers = await db.query('common-service', 'buyer_summaries', filter, {
    projection: { buyer_name: 1, buyer_country: 1, total_shipments: 1, total_value_usd: 1,
        annual_volume: 1, buyer_tier: 1, buyer_status: 1, has_recent_activity: 1,
        recent_frequency: 1, product_descriptions: 1 },
    limit,
    sort: { buyer_tier: -1, total_shipments: -1 },
  });

  return buyers
    .filter(b => (b.total_shipments || 0) >= minShipments && !er.isJunk(b.buyer_name))
    .map(b => {
      const dimScores = scoreFromBuyerSummary(b);
      const score = computeScore(dimScores);
      return {
        opportunityId: `opp_${er.canonicalKey(b.buyer_name).slice(0, 12)}_${hs6}`,
        type: 'EMERGING_BUYER',
        typeDesc: OPPORTUNITY_TYPES.EMERGING_BUYER,
        entity: b.buyer_name,
        country: b.buyer_country,
        hsCodes: [hs6],
        evidence: {
          totalShipments: b.total_shipments,
          totalValueUsd: b.total_value_usd,
          buyerTier: b.buyer_tier,
          buyerStatus: b.buyer_status,
          hasRecentActivity: b.has_recent_activity,
          recentFrequency: b.recent_frequency,
          products: b.product_descriptions?.slice(0, 5),
        },
        score,
        dimensionScores: dimScores,
        confidence: b.total_shipments > 20 ? 'HIGH' : b.total_shipments > 5 ? 'MEDIUM' : 'LOW',
        dataFreshness: 'UNKNOWN',
        requiresHumanVerification: true,
        recommendedAction: `Contact ${b.buyer_name} with product samples and competitive pricing for HS ${hs6}`,
        generatedAt: new Date().toISOString(),
      };
    })
    .sort((a, b) => b.score - a.score);
}

/** Find HS codes where the country has export capability but limited recorded shipments (gap = opportunity) */
async function findVolumeGaps(originCountry, hsCodes, { limit = 50 } = {}) {
  const opportunities = [];
  for (const hs of hsCodes) {
    const hs4p = String(hs).slice(0, 4);
    const hsFilter = { $elemMatch: { $regex: `^${hs4p}` } };
    const [suppliers, buyers] = await Promise.all([
      db.query('common-service', 'supplier_summaries',
        { hs_codes: hsFilter, supplier_country: originCountry },
        { projection: { supplier_name: 1, total_value_usd: 1 }, limit: 20 }),
      db.query('common-service', 'buyer_summaries',
        { hs_codes: hsFilter },
        { projection: { buyer_name: 1, buyer_country: 1, total_value_usd: 1,
            buyer_tier: 1 }, limit: 50 }),
    ]);

    if (!suppliers.length || !buyers.length) continue;

    const totalSupplyUsd = suppliers.reduce((s, x) => s + (x.total_value_usd || 0), 0);
    const totalDemandUsd = buyers.reduce((s, x) => s + (x.total_value_usd || 0), 0);

    if (totalDemandUsd > totalSupplyUsd * 2) {
      opportunities.push({
        opportunityId: `gap_${originCountry}_${hs}`,
        type: 'VOLUME_GAP',
        typeDesc: OPPORTUNITY_TYPES.VOLUME_GAP,
        hsCodes: [hs],
        originCountry,
        evidence: {
          visibleSupplyUsd: Math.round(totalSupplyUsd),
          visibleDemandUsd: Math.round(totalDemandUsd),
          gap: Math.round(totalDemandUsd - totalSupplyUsd),
          supplierCount: suppliers.length,
          buyerCount: buyers.length,
        },
        score: computeScore({
          commercial_value: Math.min(1, (totalDemandUsd - totalSupplyUsd) / 1_000_000),
          probability: 0.6, timing_urgency: 0.5, data_quality: 0.6,
          margin_potential: 0.7, competitive_adv: 0.6, execution_ease: 0.5,
        }),
        confidence: 'MEDIUM',
        requiresHumanVerification: true,
        recommendedAction: `Develop export capability for HS ${hs} from ${originCountry} — demand significantly exceeds visible supply`,
        generatedAt: new Date().toISOString(),
      });
    }
  }
  return opportunities.sort((a, b) => b.score - a.score);
}

async function runOpportunityScorer({ hs, originCountry = 'IN', destCountry = null, limit = 50 }) {
  const results = [];

  if (hs) {
    console.log(`Finding emerging buyers for HS ${hs}...`);
    const buyers = await findEmergingBuyers(hs, { destCountry, limit });
    results.push(...buyers.slice(0, 10));
    console.log(`  Found ${buyers.length} opportunities`);
  }

  if (originCountry && hs) {
    console.log(`Checking volume gaps for ${originCountry}...`);
    const gaps = await findVolumeGaps(originCountry, [hs]);
    results.push(...gaps);
  }

  results.sort((a, b) => b.score - a.score);

  const report = {
    generatedAt: new Date().toISOString(),
    parameters: { hs, originCountry, destCountry },
    opportunities: results,
    summary: {
      total: results.length,
      highScore: results.filter(x => x.score >= 0.7).length,
      byType: results.reduce((m, x) => { m[x.type] = (m[x.type] || 0) + 1; return m; }, {}),
    },
  };

  const outPath = path.resolve(__dirname, '../reports/opportunities.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) {
  const hsIdx = process.argv.indexOf('--hs');
  const hs = hsIdx >= 0 ? process.argv[hsIdx + 1] : '690810';
  const cIdx = process.argv.indexOf('--origin');
  const origin = cIdx >= 0 ? process.argv[cIdx + 1] : 'IN';

  runOpportunityScorer({ hs, originCountry: origin, limit: 50 })
    .then(r => {
      console.log(`\n=== TOP OPPORTUNITIES ===`);
      r.opportunities.slice(0, 5).forEach((o, i) =>
        console.log(`${i + 1}. [Score:${(o.score * 100).toFixed(0)}] ${o.type}: ${o.entity || o.hsCodes.join(',')} (${o.confidence})`));
    })
    .catch(e => { console.error('FAILED:', e.message); process.exit(1); })
    .finally(() => db.close());
}

module.exports = { findEmergingBuyers, findVolumeGaps, runOpportunityScorer, computeScore, SCORE_DIMENSIONS };
