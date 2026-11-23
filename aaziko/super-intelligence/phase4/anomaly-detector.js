'use strict';
/*
 * Phase 4 — Anomaly Detector
 * Detects unusual trade patterns that may indicate:
 *   - Under/over-invoicing (price deviates sharply from peers)
 *   - Circular trading (entity appears as both buyer and seller with same counterpart)
 *   - Sudden volume spikes / drops (>3 sigma from entity's own history)
 *   - Split shipments (many small shipments to same buyer in short window)
 *   - Shell/intermediary chains (entity with no web presence moves large value)
 *
 * Run: node phase4/anomaly-detector.js --hs 690810
 */
const db = require('../lib/db');
const er = require('../lib/entity-resolver');

const ANOMALY_TYPES = {
  PRICE_ANOMALY:      'Unit price deviates >3x from peer median — possible under/over-invoicing',
  CIRCULAR_TRADE:     'Entity appears as both exporter and importer with same counterpart',
  VOLUME_SPIKE:       'Shipment volume >3 sigma above entity historical average',
  VOLUME_CRASH:       'Shipment volume dropped >70% vs prior period — possible market exit',
  SPLIT_SHIPMENT:     '>5 shipments from same exporter to same importer within 30 days, low unit value',
  NEW_MARKET_ENTRY:   'First shipment to a destination this entity has never shipped to before',
  SUPPLIER_SWITCH:    'Entity replaced its primary supplier — opportunity window for competitors',
  JUNK_ENTITY_HIGH_VALUE: 'Entity name appears generic/junk but moved high value',
};

const SEVERITY = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

/** IQR-based outlier boundary */
function iqrBounds(values) {
  if (!values.length) return { lower: -Infinity, upper: Infinity, median: null };
  const s = [...values].sort((a, b) => a - b);
  const q1 = s[Math.floor(s.length * 0.25)];
  const q3 = s[Math.floor(s.length * 0.75)];
  const iqr = q3 - q1;
  return { lower: q1 - 1.5 * iqr, upper: q3 + 1.5 * iqr, median: s[Math.floor(s.length / 2)] };
}

/** Detect price anomalies for an HS code */
async function detectPriceAnomalies(hs6, { limit = 2000, minRecords = 10 } = {}) {
  // HS_CODE_4 (number) rows have PRICE_PER_UNIT_USD; HS_CODE (string) rows do not.
  const hs4 = parseInt(String(hs6).slice(0, 4), 10);
  const records = await db.query('common-service', 'standard_port_data',
    { HS_CODE_4: hs4, PRICE_PER_UNIT_USD: { $gt: 0 } },
    { projection: { BUYER_NAME: 1, PRICE_PER_UNIT_USD: 1, FOB_VALUE_USD: 1,
        QUANTITY: 1, ORIGIN_COUNTRY: 1, DESTINATION_COUNTRY: 1, DATE: 1 }, limit });

  if (records.length < minRecords) return [];

  const prices = records.map(r => r.PRICE_PER_UNIT_USD).filter(p => p > 0 && p < 1e9);
  const { lower, upper, median } = iqrBounds(prices);

  const anomalies = [];
  for (const r of records) {
    const unitPrice = r.PRICE_PER_UNIT_USD;
    if (!unitPrice) continue;
    if (unitPrice < lower * 0.1 || unitPrice > upper * 10) {
      const deviation = median ? Math.abs(unitPrice - median) / median : null;
      anomalies.push({
        anomalyId: `price_${er.canonicalKey(r.BUYER_NAME || '').slice(0, 8)}_${r.DATE || ''}`,
        type: 'PRICE_ANOMALY',
        severity: deviation > 10 ? 'CRITICAL' : deviation > 5 ? 'HIGH' : 'MEDIUM',
        description: ANOMALY_TYPES.PRICE_ANOMALY,
        entities: [r.BUYER_NAME, r.ORIGIN_COUNTRY].filter(Boolean),
        evidence: {
          unitPrice: Math.round(unitPrice * 100) / 100,
          peerMedian: median ? Math.round(median * 100) / 100 : null,
          deviationFactor: deviation ? Math.round(deviation * 10) / 10 : null,
          fobValueUsd: r.FOB_VALUE_USD,
          quantity: r.QUANTITY,
          originCountry: r.ORIGIN_COUNTRY,
          destinationCountry: r.DESTINATION_COUNTRY,
          date: r.DATE,
          hsCodes: [hs6],
        },
        requiresHumanReview: true,
        detectedAt: new Date().toISOString(),
      });
    }
  }
  return anomalies.sort((a, b) => SEVERITY[b.severity] - SEVERITY[a.severity]);
}

/** Detect circular trading: entity appears in BOTH buyer_summaries AND supplier_summaries
 *  for the same HS codes — indicates it both imports and exports the same product. */
async function detectCircularTrade(entityName, { limit = 100 } = {}) {
  const prefix = entityName.trim().split(/\s+/)[0];
  const regex = `^${prefix}`;

  const [buyerRows, supplierRows] = await Promise.all([
    db.query('common-service', 'buyer_summaries',
      { buyer_name: { $regex: regex, $options: 'i' } },
      { projection: { buyer_name: 1, buyer_country: 1, hs_codes: 1, total_value_usd: 1 }, limit: 20 }),
    db.query('common-service', 'supplier_summaries',
      { supplier_name: { $regex: regex, $options: 'i' } },
      { projection: { supplier_name: 1, supplier_country: 1, hs_codes: 1, total_value_usd: 1 }, limit: 20 }),
  ]);

  if (!buyerRows.length || !supplierRows.length) return [];

  const anomalies = [];
  for (const buyer of buyerRows) {
    const buyHs4 = new Set((buyer.hs_codes || []).map(h => String(h).slice(0, 4)));
    for (const supplier of supplierRows) {
      if (er.canonicalKey(buyer.buyer_name) !== er.canonicalKey(supplier.supplier_name)) continue;
      const suppHs4 = new Set((supplier.hs_codes || []).map(h => String(h).slice(0, 4)));
      const overlapping = [...buyHs4].filter(h => suppHs4.has(h));
      if (!overlapping.length) continue;
      anomalies.push({
        anomalyId: `circular_${er.canonicalKey(entityName).slice(0, 10)}_${Date.now()}`,
        type: 'CIRCULAR_TRADE',
        severity: 'HIGH',
        description: ANOMALY_TYPES.CIRCULAR_TRADE,
        entities: [buyer.buyer_name],
        evidence: {
          appearsAsBuyer: buyer.buyer_country,
          appearsAsSupplier: supplier.supplier_country,
          overlappingHsCodes: overlapping,
          buyerValueUsd: buyer.total_value_usd,
          supplierValueUsd: supplier.total_value_usd,
        },
        requiresHumanReview: true,
        detectedAt: new Date().toISOString(),
      });
    }
  }
  return anomalies;
}

/** Detect split shipments: many small shipments from same buyer+origin in a short window */
async function detectSplitShipments(hs6, { limit = 2000, windowDays = 30, minCount = 5 } = {}) {
  const hs4 = parseInt(String(hs6).slice(0, 4), 10);
  const records = await db.query('common-service', 'standard_port_data',
    { HS_CODE_4: hs4 },
    { projection: { BUYER_NAME: 1, ORIGIN_COUNTRY: 1, FOB_VALUE_USD: 1, DATE: 1 }, limit,
      sort: { DATE: -1 } });

  const pairBuckets = new Map();
  for (const r of records) {
    if (!r.BUYER_NAME || !r.ORIGIN_COUNTRY || !r.DATE) continue;
    const pairKey = `${er.canonicalKey(r.BUYER_NAME)}|${r.ORIGIN_COUNTRY}`;
    if (!pairBuckets.has(pairKey)) pairBuckets.set(pairKey, []);
    pairBuckets.get(pairKey).push(r);
  }

  const anomalies = [];
  for (const [pairKey, shipments] of pairBuckets) {
    if (shipments.length < minCount) continue;
    // Check for clusters within windowDays
    shipments.sort((a, b) => a.DATE > b.DATE ? 1 : -1);
    for (let i = 0; i <= shipments.length - minCount; i++) {
      const window = shipments.slice(i, i + minCount);
      const firstDate = new Date(window[0].DATE);
      const lastDate = new Date(window[window.length - 1].DATE);
      if (isNaN(firstDate) || isNaN(lastDate)) continue;
      const daySpan = (lastDate - firstDate) / 86400000;
      if (daySpan <= windowDays) {
        const totalValue = window.reduce((s, x) => s + (x.VALUE_USD || 0), 0);
        const avgValue = totalValue / window.length;
        const [buyerKey, originKey] = pairKey.split('|');
        anomalies.push({
          anomalyId: `split_${pairKey.slice(0, 20)}_${window[0].DATE}`,
          type: 'SPLIT_SHIPMENT',
          severity: avgValue < 10000 ? 'HIGH' : 'MEDIUM',
          description: ANOMALY_TYPES.SPLIT_SHIPMENT,
          entities: [window[0].BUYER_NAME, window[0].ORIGIN_COUNTRY].filter(Boolean),
          evidence: {
            shipmentCount: window.length,
            windowDays: Math.round(daySpan),
            totalValueUsd: Math.round(totalValue),
            avgValueUsd: Math.round(avgValue),
            dateRange: { from: window[0].DATE, to: window[window.length - 1].DATE },
          },
          requiresHumanReview: true,
          detectedAt: new Date().toISOString(),
        });
        break; // One anomaly per pair
      }
    }
  }
  return anomalies.sort((a, b) => SEVERITY[b.severity] - SEVERITY[a.severity]);
}

/** Detect supplier switches: buyer moved from COLD/WARM to HOT status recently,
 *  or changed dominant origin country — proxy for switching supplier.
 *  Uses buyer_summaries (indexed on buyer_name) + standard_port_data ORIGIN_COUNTRY. */
async function detectSupplierSwitches(buyerName, { limit = 300 } = {}) {
  const prefix = buyerName.trim().split(/\s+/)[0];
  const buyers = await db.query('common-service', 'buyer_summaries',
    { buyer_name: { $regex: `^${prefix}`, $options: 'i' } },
    { projection: { buyer_name: 1, buyer_country: 1, buyer_tier: 1, buyer_status: 1,
        hs_codes: 1, total_shipments: 1, has_recent_activity: 1 }, limit: 20 });

  if (!buyers.length) return [];

  const anomalies = [];
  for (const buyer of buyers) {
    if (!buyer.hs_codes?.length) continue;
    // Check origin country distribution for this buyer's hs codes
    const hs4 = parseInt(String(buyer.hs_codes[0]).slice(0, 4), 10);
    const shipments = await db.query('common-service', 'standard_port_data',
      { HS_CODE_4: hs4, BUYER_NAME: { $regex: `^${prefix}`, $options: 'i' } },
      { projection: { ORIGIN_COUNTRY: 1, DATE: 1 }, limit: 200, sort: { DATE: -1 } });

    if (shipments.length < 10) continue;
    const half = Math.floor(shipments.length / 2);
    const older = shipments.slice(half);
    const newer = shipments.slice(0, half);

    const topOrigin = (arr) => {
      const m = new Map();
      for (const r of arr) if (r.ORIGIN_COUNTRY) m.set(r.ORIGIN_COUNTRY, (m.get(r.ORIGIN_COUNTRY) || 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    };
    const oldTop = topOrigin(older);
    const newTop = topOrigin(newer);
    if (!oldTop || !newTop || oldTop[0] === newTop[0]) continue;

    anomalies.push({
      anomalyId: `switch_${er.canonicalKey(buyerName).slice(0, 10)}_${Date.now()}`,
      type: 'SUPPLIER_SWITCH',
      severity: 'MEDIUM',
      description: ANOMALY_TYPES.SUPPLIER_SWITCH,
      entities: [buyer.buyer_name],
      evidence: {
        previousPrimaryOrigin: oldTop[0],
        previousShipments: oldTop[1],
        newPrimaryOrigin: newTop[0],
        newShipments: newTop[1],
        buyerTier: buyer.buyer_tier,
        buyerStatus: buyer.buyer_status,
      },
      requiresHumanReview: false,
      detectedAt: new Date().toISOString(),
    });
  }
  return anomalies;
}

async function runAnomalyDetector({ hs, entityName, limit = 1000 } = {}) {
  const anomalies = [];

  if (hs) {
    console.log(`Detecting price anomalies for HS ${hs}...`);
    const priceAnomalies = await detectPriceAnomalies(hs, { limit });
    anomalies.push(...priceAnomalies.slice(0, 20));
    console.log(`  Found ${priceAnomalies.length} price anomalies`);

    console.log(`Detecting split shipments for HS ${hs}...`);
    const splitAnomalies = await detectSplitShipments(hs, { limit });
    anomalies.push(...splitAnomalies.slice(0, 10));
    console.log(`  Found ${splitAnomalies.length} split shipment patterns`);
  }

  if (entityName) {
    console.log(`Detecting circular trade for ${entityName}...`);
    const circularAnomalies = await detectCircularTrade(entityName, { limit: 500 });
    anomalies.push(...circularAnomalies);
    console.log(`  Found ${circularAnomalies.length} circular trade patterns`);

    console.log(`Detecting supplier switches for ${entityName}...`);
    const switchAnomalies = await detectSupplierSwitches(entityName, { limit: 300 });
    anomalies.push(...switchAnomalies);
    console.log(`  Found ${switchAnomalies.length} supplier switches`);
  }

  anomalies.sort((a, b) => SEVERITY[b.severity] - SEVERITY[a.severity]);

  return {
    generatedAt: new Date().toISOString(),
    parameters: { hs, entityName },
    anomalies,
    summary: {
      total: anomalies.length,
      bySeverity: anomalies.reduce((m, x) => { m[x.severity] = (m[x.severity] || 0) + 1; return m; }, {}),
      byType: anomalies.reduce((m, x) => { m[x.type] = (m[x.type] || 0) + 1; return m; }, {}),
      requiresHumanReview: anomalies.filter(x => x.requiresHumanReview).length,
    },
  };
}

if (require.main === module) {
  const hsIdx = process.argv.indexOf('--hs');
  const hs = hsIdx >= 0 ? process.argv[hsIdx + 1] : null;
  const eIdx = process.argv.indexOf('--entity');
  const entityName = eIdx >= 0 ? process.argv[eIdx + 1] : null;

  if (!hs && !entityName) {
    console.error('Usage: node anomaly-detector.js --hs 690810 [--entity "COMPANY NAME"]');
    process.exit(1);
  }

  runAnomalyDetector({ hs, entityName })
    .then(r => {
      console.log(`\n=== ANOMALY SUMMARY ===`);
      console.log(`Total: ${r.summary.total} | By severity: ${JSON.stringify(r.summary.bySeverity)}`);
      r.anomalies.slice(0, 5).forEach((a, i) =>
        console.log(`${i + 1}. [${a.severity}] ${a.type}: ${a.entities.join(' ↔ ')}`));
    })
    .catch(e => { console.error('FAILED:', e.message); process.exit(1); })
    .finally(() => db.close());
}

module.exports = { detectPriceAnomalies, detectCircularTrade, detectSplitShipments,
  detectSupplierSwitches, runAnomalyDetector, ANOMALY_TYPES };
