'use strict';
/*
 * Phase 3 — Commodity Price & Shipping Tracker
 * Monitors commodity prices and freight rates from internal DB data +
 * detects trends that may indicate trade opportunities or risks.
 *
 * Data sources:
 *  - Internal: common-service.standard_port_data (VALUE_USD / QUANTITY gives implicit price)
 *  - Freight: service-provider.freightservicepricings (route confirmations)
 * Run: node phase3/commodity-tracker.js --hs 690810
 */
const db = require('../lib/db');

// Key commodity HS code groups
const COMMODITY_GROUPS = {
  ceramics:    { hs: ['6908', '6907', '6914'], unit: 'sqm' },
  marble:      { hs: ['2515', '6802'], unit: 'sqm_or_kg' },
  textiles:    { hs: ['5208', '5209', '5210', '5513', '5407'], unit: 'kg_or_m' },
  leather:     { hs: ['4107', '4112', '4113', '4114'], unit: 'sqm' },
  chemicals:   { hs: ['2814', '2815', '2905', '2932'], unit: 'kg' },
  steel:       { hs: ['7208', '7209', '7210', '7217'], unit: 'kg' },
  cotton:      { hs: ['5201', '5203', '5205'], unit: 'kg' },
  pharma:      { hs: ['3002', '3003', '3004', '3006'], unit: 'kg' },
  gems:        { hs: ['7102', '7103', '7104'], unit: 'carat' },
};

/** Calculate implicit unit price from shipment records */
function calcImplicitPrice(records) {
  // Use PRICE_PER_UNIT_USD directly if available; fall back to FOB/CIF divided by quantity
  const withBoth = records.filter(r => {
    if (r.PRICE_PER_UNIT_USD > 0) return true;
    return (r.FOB_VALUE_USD > 0 || r.CIF_VALUE_USD > 0) && r.QUANTITY > 0;
  });
  if (!withBoth.length) return null;
  const prices = withBoth.map(r => {
    if (r.PRICE_PER_UNIT_USD > 0) return r.PRICE_PER_UNIT_USD;
    return (r.FOB_VALUE_USD || r.CIF_VALUE_USD) / r.QUANTITY;
  }).filter(p => p > 0 && p < 1e9);
  if (!prices.length) return null;
  const sorted = prices.sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const filtered = sorted.filter(p => p >= q1 - 1.5 * iqr && p <= q3 + 1.5 * iqr);
  const mean = filtered.reduce((s, x) => s + x, 0) / filtered.length;
  return { mean: Math.round(mean * 100) / 100, min: sorted[0], max: sorted[sorted.length - 1], n: filtered.length };
}

async function trackHsCodePrice(hs6, { originCountry = null, limit = 1000 } = {}) {
  // HS_CODE_4 (number) is the field that co-exists with FOB/price/country data.
  // HS_CODE (string) rows lack those fields — using HS_CODE_4 gives real pricing data.
  const hs4 = parseInt(String(hs6).slice(0, 4), 10);
  const filter = { HS_CODE_4: hs4 };
  if (originCountry) filter.ORIGIN_COUNTRY = originCountry;

  const records = await db.query('common-service', 'standard_port_data', filter, {
    projection: { FOB_VALUE_USD: 1, CIF_VALUE_USD: 1, PRICE_PER_UNIT_USD: 1, QUANTITY: 1,
      DATE: 1, ORIGIN_COUNTRY: 1, DESTINATION_COUNTRY: 1 },
    limit,
    sort: { DATE: -1 },
  });

  if (!records.length) return { hs: hs6, error: 'No records found' };

  // Split into two halves by date to detect trend
  const sorted = records.filter(r => r.DATE).sort((a, b) => a.DATE > b.DATE ? 1 : -1);
  const mid = Math.floor(sorted.length / 2);
  const older = sorted.slice(0, mid);
  const newer = sorted.slice(mid);

  const olderPrice = calcImplicitPrice(older);
  const newerPrice = calcImplicitPrice(newer);

  let trend = 'FLAT';
  let pctChange = null;
  if (olderPrice?.mean && newerPrice?.mean) {
    pctChange = Math.round((newerPrice.mean - olderPrice.mean) / olderPrice.mean * 100);
    if (pctChange > 10) trend = 'RISING';
    else if (pctChange < -10) trend = 'FALLING';
  }

  const destinations = new Set(records.map(r => r.DESTINATION_COUNTRY).filter(Boolean));
  const origins = new Set(records.map(r => r.ORIGIN_COUNTRY).filter(Boolean));

  return {
    hs: hs6, recordCount: records.length,
    currentPrice: newerPrice, historicalPrice: olderPrice,
    trend, pctChange,
    topOrigins: [...origins].slice(0, 5),
    topDestinations: [...destinations].slice(0, 5),
    dateRange: {
      earliest: sorted[0]?.DATE || null,
      latest: sorted[sorted.length - 1]?.DATE || null,
    },
  };
}

async function trackFreightRoutes({ limit = 100 } = {}) {
  try {
    const routes = await db.query('service-provider', 'freightservicepricings', {},
      { projection: { polName: 1, podName: 1, containerTypeSize: 1, cargoType: 1, status: 1 },
        limit });
    const activeRoutes = routes.filter(r => r.status === 'active');
    const portPairs = new Map();
    for (const r of activeRoutes) {
      const key = `${r.polName || ''}→${r.podName || ''}`;
      portPairs.set(key, (portPairs.get(key) || 0) + 1);
    }
    return {
      totalRoutes: activeRoutes.length,
      uniquePortPairs: portPairs.size,
      topRoutes: [...portPairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
        .map(([route, count]) => ({ route, serviceProviders: count })),
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function runCommodityTracker({ hsGroups = null } = {}) {
  const toTrack = hsGroups
    ? Object.fromEntries(Object.entries(COMMODITY_GROUPS).filter(([k]) => hsGroups.includes(k)))
    : COMMODITY_GROUPS;

  const report = { generatedAt: new Date().toISOString(), commodities: {}, freightRoutes: {} };

  for (const [group, { hs }] of Object.entries(toTrack)) {
    console.log(`Tracking ${group} (${hs[0]})...`);
    try {
      report.commodities[group] = await trackHsCodePrice(hs[0]);
      const p = report.commodities[group];
      if (p.currentPrice) {
        console.log(`  Price: $${p.currentPrice.mean}/unit | Trend: ${p.trend} (${p.pctChange > 0 ? '+' : ''}${p.pctChange || 0}%)`);
      } else {
        console.log(`  No pricing data`);
      }
    } catch (e) {
      report.commodities[group] = { error: e.message };
    }
  }

  console.log('Tracking freight routes...');
  report.freightRoutes = await trackFreightRoutes();

  return report;
}

if (require.main === module) {
  const hsIdx = process.argv.indexOf('--hs');
  if (hsIdx >= 0) {
    const hs = process.argv[hsIdx + 1];
    trackHsCodePrice(hs, { limit: 500 })
      .then(r => console.log(JSON.stringify(r, null, 2)))
      .catch(e => console.error('FAILED:', e.message))
      .finally(() => db.close());
  } else {
    runCommodityTracker()
      .then(r => { console.log('\nDone.'); console.log(JSON.stringify(r.freightRoutes, null, 2)); })
      .catch(e => { console.error('FAILED:', e.message); process.exit(1); })
      .finally(() => db.close());
  }
}

module.exports = { trackHsCodePrice, trackFreightRoutes, runCommodityTracker, COMMODITY_GROUPS };
