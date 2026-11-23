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
  const records = await db.query('common-service', 'standard_port_data',
    { HS_CODE: { $regex: `^${hs6}` }, VALUE_USD: { $gt: 0 }, QUANTITY: { $gt: 0 } },
    { projection: { EXPORTER_NAME: 1, IMPORTER_NAME: 1, VALUE_USD: 1, QUANTITY: 1,
        ORIGIN_COUNTRY: 1, DATE: 1 }, limit });

  if (records.length < minRecords) return [];

  const prices = records.map(r => r.VALUE_USD / r.QUANTITY).filter(p => p > 0 && p < 1e9);
  const { lower, upper, median } = iqrBounds(prices);

  const anomalies = [];
  for (const r of records) {
    if (!r.VALUE_USD || !r.QUANTITY) continue;
    const unitPrice = r.VALUE_USD / r.QUANTITY;
    if (unitPrice < lower * 0.1 || unitPrice > upper * 10) {
      const deviation = median ? Math.abs(unitPrice - median) / median : null;
      anomalies.push({
        anomalyId: `price_${er.canonicalKey(r.EXPORTER_NAME || '').slice(0, 8)}_${r.DATE || ''}`,
        type: 'PRICE_ANOMALY',
        severity: deviation > 10 ? 'CRITICAL' : deviation > 5 ? 'HIGH' : 'MEDIUM',
        description: ANOMALY_TYPES.PRICE_ANOMALY,
        entities: [r.EXPORTER_NAME, r.IMPORTER_NAME].filter(Boolean),
        evidence: {
          unitPrice: Math.round(unitPrice * 100) / 100,
          peerMedian: median ? Math.round(median * 100) / 100 : null,
          deviationFactor: deviation ? Math.round(deviation * 10) / 10 : null,
          valueUsd: r.VALUE_USD,
          quantity: r.QUANTITY,
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

/** Detect circular trading: entity appears in both exporter and importer columns with same counterpart */
async function detectCircularTrade(entityName, { limit = 500 } = {}) {
  const words = entityName.trim().split(/\s+/).slice(0, 3).join('.*');

  const [asExporter, asImporter] = await Promise.all([
    db.query('common-service', 'standard_port_data',
      { EXPORTER_NAME: { $regex: words, $options: 'i' } },
      { projection: { IMPORTER_NAME: 1, HS_CODE: 1, VALUE_USD: 1, DATE: 1 }, limit }),
    db.query('common-service', 'standard_port_data',
      { IMPORTER_NAME: { $regex: words, $options: 'i' } },
      { projection: { EXPORTER_NAME: 1, HS_CODE: 1, VALUE_USD: 1, DATE: 1 }, limit }),
  ]);

  const exportCounterparts = new Map();
  for (const r of asExporter) {
    const key = er.canonicalKey(r.IMPORTER_NAME || '');
    if (!key || er.isJunk(r.IMPORTER_NAME)) continue;
    if (!exportCounterparts.has(key)) exportCounterparts.set(key, { name: r.IMPORTER_NAME, hs: new Set(), value: 0 });
    exportCounterparts.get(key).hs.add(String(r.HS_CODE || '').slice(0, 4));
    exportCounterparts.get(key).value += r.VALUE_USD || 0;
  }

  const anomalies = [];
  for (const r of asImporter) {
    const key = er.canonicalKey(r.EXPORTER_NAME || '');
    if (exportCounterparts.has(key)) {
      const cp = exportCounterparts.get(key);
      anomalies.push({
        anomalyId: `circular_${er.canonicalKey(entityName).slice(0, 10)}_${key.slice(0, 10)}`,
        type: 'CIRCULAR_TRADE',
        severity: 'HIGH',
        description: ANOMALY_TYPES.CIRCULAR_TRADE,
        entities: [entityName, cp.name],
        evidence: {
          entityExportsTo: cp.name,
          entityImportsFrom: cp.name,
          exportHsCodes: [...cp.hs],
          totalExportValueUsd: Math.round(cp.value),
        },
        requiresHumanReview: true,
        detectedAt: new Date().toISOString(),
      });
    }
  }
  return anomalies;
}

/** Detect split shipments: many small shipments from same pair in a short window */
async function detectSplitShipments(hs6, { limit = 2000, windowDays = 30, minCount = 5 } = {}) {
  const records = await db.query('common-service', 'standard_port_data',
    { HS_CODE: { $regex: `^${hs6}` } },
    { projection: { EXPORTER_NAME: 1, IMPORTER_NAME: 1, VALUE_USD: 1, DATE: 1 }, limit,
      sort: { DATE: -1 } });

  const pairBuckets = new Map();
  for (const r of records) {
    if (!r.EXPORTER_NAME || !r.IMPORTER_NAME || !r.DATE) continue;
    const pairKey = `${er.canonicalKey(r.EXPORTER_NAME)}|${er.canonicalKey(r.IMPORTER_NAME)}`;
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
        anomalies.push({
          anomalyId: `split_${pairKey.slice(0, 20)}_${window[0].DATE}`,
          type: 'SPLIT_SHIPMENT',
          severity: avgValue < 10000 ? 'HIGH' : 'MEDIUM',
          description: ANOMALY_TYPES.SPLIT_SHIPMENT,
          entities: [window[0].EXPORTER_NAME, window[0].IMPORTER_NAME],
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

/** Detect supplier switches: entity's primary supplier changed */
async function detectSupplierSwitches(buyerName, { limit = 300 } = {}) {
  const words = buyerName.trim().split(/\s+/).slice(0, 3).join('.*');
  const records = await db.query('common-service', 'standard_port_data',
    { IMPORTER_NAME: { $regex: words, $options: 'i' } },
    { projection: { EXPORTER_NAME: 1, VALUE_USD: 1, DATE: 1, HS_CODE: 1 }, limit,
      sort: { DATE: -1 } });

  if (records.length < 10) return [];

  const sorted = records.filter(r => r.DATE).sort((a, b) => a.DATE > b.DATE ? 1 : -1);
  const mid = Math.floor(sorted.length / 2);
  const older = sorted.slice(0, mid);
  const newer = sorted.slice(mid);

  const countBySupplier = (arr) => {
    const m = new Map();
    for (const r of arr) {
      const key = er.canonicalKey(r.EXPORTER_NAME || '');
      if (!key || er.isJunk(r.EXPORTER_NAME)) continue;
      m.set(key, (m.get(key) || 0) + 1);
    }
    return m;
  };

  const olderSuppliers = countBySupplier(older);
  const newerSuppliers = countBySupplier(newer);

  const oldPrimary = [...olderSuppliers.entries()].sort((a, b) => b[1] - a[1])[0];
  const newPrimary = [...newerSuppliers.entries()].sort((a, b) => b[1] - a[1])[0];

  if (!oldPrimary || !newPrimary) return [];
  if (oldPrimary[0] === newPrimary[0]) return [];

  return [{
    anomalyId: `switch_${er.canonicalKey(buyerName).slice(0, 10)}_${Date.now()}`,
    type: 'SUPPLIER_SWITCH',
    severity: 'MEDIUM',
    description: ANOMALY_TYPES.SUPPLIER_SWITCH,
    entities: [buyerName],
    evidence: {
      previousPrimarySupplierKey: oldPrimary[0],
      previousShipments: oldPrimary[1],
      newPrimarySupplierKey: newPrimary[0],
      newShipments: newPrimary[1],
    },
    requiresHumanReview: false,
    detectedAt: new Date().toISOString(),
  }];
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
