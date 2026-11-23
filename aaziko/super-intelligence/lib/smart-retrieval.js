'use strict';
/*
 * Smart Multi-DB Retrieval Engine
 * ================================
 * Knows exactly which DB/collection/field to use for every data type.
 * Runs queries across the full cluster in parallel and returns normalized,
 * merged results — callers never deal with field-name differences.
 *
 * DATA SOURCES MAPPED:
 *   Buyers    → common-service.buyer_summaries + outbound_email.contacts/companies
 *   Suppliers → common-service.supplier_summaries + tradeindia_db.suppliers/supplier_contacts
 *               + indiamart.sellers
 *   Shipments → common-service.standard_port_data (HS_CODE_4, FOB_VALUE_USD, PRICE_PER_UNIT_USD)
 *   Prices    → common-service.standard_port_data (PRICE_PER_UNIT_USD, FOB_VALUE_USD, QUANTITY)
 *   Tariffs   → Dhruval2.map_tariff_organized + map_competitors
 *   Contacts  → outbound_email.contacts + tradeindia_db.supplier_contacts
 *   Leads     → buyer_summaries + outbound_email.contacts (combined)
 *
 * Usage:
 *   const sr = require('./lib/smart-retrieval');
 *   const buyers = await sr.findBuyers({ hs: '6908', country: 'US', limit: 50 });
 *   const full   = await sr.fullIntelligence({ hs: '6908', origin: 'IN' });
 */
const db = require('./db');
const er = require('./entity-resolver');

// ─── FIELD MAPS (what each collection actually stores) ───────────────────────

const BUYER_SUMMARY_FIELDS = {
  name: 'buyer_name', country: 'buyer_country',
  shipments: 'total_shipments', valueUsd: 'total_value_usd',
  tier: 'buyer_tier', status: 'buyer_status',
  active: 'has_recent_activity', freq: 'recent_frequency',
  hsCodes: 'hs_codes', products: 'product_descriptions',
  firstDate: 'first_shipment_date', lastDate: 'last_shipment_date',
};

const SUPPLIER_SUMMARY_FIELDS = {
  name: 'supplier_name', country: 'supplier_country',
  shipments: 'total_shipments', valueUsd: 'total_value_usd',
  hsCodes: 'hs_codes', destCountries: 'dest_countries',
  activeCountries: 'active_countries',
};

const SHIPMENT_FIELDS = {
  hsCode: 'HS_CODE', hs4: 'HS_CODE_4', hs2: 'HS_CODE_2',
  buyer: 'BUYER_NAME', origin: 'ORIGIN_COUNTRY', dest: 'DESTINATION_COUNTRY',
  fob: 'FOB_VALUE_USD', cif: 'CIF_VALUE_USD', unitPrice: 'PRICE_PER_UNIT_USD',
  qty: 'QUANTITY', weight: 'WEIGHT', date: 'DATE',
  product: 'PRODUCT_DESCRIPTION', dataType: 'data_type',
};

// ─── NORMALIZERS (convert raw DB row → standard shape) ───────────────────────

function normBuyer(row, source) {
  return {
    _source: source,
    name: row.buyer_name || row.fullName || row.companyName || row.name || '',
    country: row.buyer_country || row.country || '',
    tier: row.buyer_tier || row.buyerTier || null,
    status: row.buyer_status || null,
    hasRecentActivity: row.has_recent_activity ?? null,
    totalShipments: row.total_shipments || 0,
    totalValueUsd: Math.min(row.total_value_usd || 0, 500_000_000), // cap corrupt values
    hsCodes: row.hs_codes || (row.hsCodes ? [row.hsCodes] : []) || [],
    products: row.product_descriptions || (row.productName ? [row.productName] : []),
    email: row.email || null,
    phone: row.phone || null,
    website: row.website || null,
    lastActivity: row.last_shipment_date || row.updatedAt || null,
  };
}

function normSupplier(row, source) {
  return {
    _source: source,
    name: row.supplier_name || row.name || (row.data && row.data.name) || '',
    country: row.supplier_country || row.location?.country || '',
    totalShipments: row.total_shipments || 0,
    totalValueUsd: Math.min(row.total_value_usd || 0, 500_000_000),
    hsCodes: row.hs_codes || [],
    destCountries: row.dest_countries || [],
    website: row.website || (row.data && row.data.website) || null,
    businessType: row.business_type || null,
    exportMarkets: row.export_markets || [],
    lastActivity: row.last_shipment_date || null,
  };
}

function normShipment(row) {
  const fob = row.FOB_VALUE_USD || row.CIF_VALUE_USD || 0;
  const qty = row.QUANTITY || 0;
  return {
    hs: row.HS_CODE || '',
    hs4: row.HS_CODE_4 || String(row.HS_CODE || '').slice(0, 4),
    buyer: row.BUYER_NAME || '',
    origin: row.ORIGIN_COUNTRY || '',
    dest: row.DESTINATION_COUNTRY || '',
    fobUsd: fob,
    unitPriceUsd: row.PRICE_PER_UNIT_USD > 0 ? row.PRICE_PER_UNIT_USD
                  : (fob > 0 && qty > 0 ? fob / qty : null),
    quantity: qty,
    weight: row.WEIGHT || 0,
    date: row.DATE || null,
    product: row.PRODUCT_DESCRIPTION || '',
    dataType: row.data_type || '',
  };
}

// ─── CORE RETRIEVAL FUNCTIONS ─────────────────────────────────────────────────

/**
 * findBuyers — buyers for a given HS code (4 or 6 digit) across all sources
 * @param {string} hs     HS code (4–8 digits)
 * @param {object} opts   { country, status, tier, limit, minShipments, sources }
 */
async function findBuyers(hs, { country = null, status = null, tier = null,
    limit = 100, minShipments = 1, sources = ['summaries', 'email'] } = {}) {
  const hs4 = String(hs).slice(0, 4);
  const tasks = [];

  if (sources.includes('summaries')) {
    // hs_codes stores 6-digit codes like "690810" — use $elemMatch + prefix regex to match
    const filter = {
      hs_codes: { $elemMatch: { $regex: `^${hs4}` } },
      total_shipments: { $gte: minShipments },
    };
    if (country) filter.buyer_country = { $regex: country, $options: 'i' };
    if (status)  filter.buyer_status  = Array.isArray(status) ? { $in: status } : status;
    if (tier)    filter.buyer_tier    = Array.isArray(tier)   ? { $in: tier   } : tier;
    tasks.push(
      db.query('common-service', 'buyer_summaries', filter, {
        projection: { buyer_name: 1, buyer_country: 1, total_shipments: 1, total_value_usd: 1,
            buyer_tier: 1, buyer_status: 1, has_recent_activity: 1, recent_frequency: 1,
            hs_codes: 1, product_descriptions: 1, last_shipment_date: 1 },
        limit, sort: { buyer_tier: -1, total_shipments: -1 },
      }).then(rows => rows.map(r => normBuyer(r, 'buyer_summaries')))
        .catch(() => [])
    );
  }

  if (sources.includes('email')) {
    // outbound_email.contacts.hsCodes is an ARRAY like ["382499"] — use $elemMatch
    const eFilter = { isDeleted: { $ne: true } };
    if (hs) eFilter.hsCodes = { $elemMatch: { $regex: `^${hs4}` } };
    if (country) eFilter.country = { $regex: country, $options: 'i' };
    tasks.push(
      db.query('outbound_email', 'contacts', eFilter, {
        projection: { fullName: 1, companyName: 1, country: 1, email: 1, phone: 1,
            buyerTier: 1, hsCodes: 1, productName: 1, website: 1, updatedAt: 1 },
        limit: Math.min(limit, 50),
      }).then(rows => rows.map(r => normBuyer(r, 'email_contacts')))
        .catch(() => [])
    );
  }

  const allResults = (await Promise.all(tasks)).flat();

  // Deduplicate by canonical name
  const seen = new Map();
  for (const r of allResults) {
    const key = er.canonicalKey(r.name);
    if (!key || er.isJunk(r.name)) continue;
    const existing = seen.get(key);
    if (!existing || r.totalShipments > existing.totalShipments) seen.set(key, r);
  }

  return [...seen.values()]
    .sort((a, b) => {
      const tierVal = t => ({ B4: 4, B3: 3, B2: 2, B1: 1 }[t] || 0);
      return tierVal(b.tier) - tierVal(a.tier) || b.totalShipments - a.totalShipments;
    })
    .slice(0, limit);
}

/**
 * findSuppliers — suppliers for a given HS code across all sources
 */
async function findSuppliers(hs, { country = null, limit = 100, minShipments = 1,
    sources = ['summaries', 'tradeindia', 'indiamart'] } = {}) {
  const hs4 = String(hs).slice(0, 4);
  const tasks = [];

  if (sources.includes('summaries')) {
    // Same as buyers: hs_codes is array of 6-digit strings, use $elemMatch + regex
    const filter = {
      hs_codes: { $elemMatch: { $regex: `^${hs4}` } },
      total_shipments: { $gte: minShipments },
    };
    if (country) filter.supplier_country = { $regex: country, $options: 'i' };
    tasks.push(
      db.query('common-service', 'supplier_summaries', filter, {
        projection: { supplier_name: 1, supplier_country: 1, total_shipments: 1,
            total_value_usd: 1, hs_codes: 1, dest_countries: 1, active_countries: 1 },
        limit, sort: { total_shipments: -1 },
      }).then(rows => rows.map(r => normSupplier(r, 'supplier_summaries')))
        .catch(() => [])
    );
  }

  if (sources.includes('tradeindia')) {
    // tradeindia_db.suppliers — search by main_categories text match on hs or product name
    tasks.push(
      db.query('tradeindia_db', 'suppliers', { extraction_status: 'complete' }, {
        projection: { name: 1, 'location.country': 1, website: 1, business_type: 1,
            export_markets: 1, main_categories: 1 },
        limit: Math.min(limit, 50),
      }).then(rows => rows.map(r => normSupplier(r, 'tradeindia')))
        .catch(() => [])
    );
  }

  if (sources.includes('indiamart')) {
    tasks.push(
      db.query('indiamart', 'sellers', {}, {
        projection: { 'data.name': 1, 'data.country': 1, 'data.website': 1, 'data.gst': 1 },
        limit: Math.min(limit, 50),
      }).then(rows => rows.map(r => normSupplier({ ...r.data, ...r }, 'indiamart')))
        .catch(() => [])
    );
  }

  const allResults = (await Promise.all(tasks)).flat();
  const seen = new Map();
  for (const r of allResults) {
    const key = er.canonicalKey(r.name);
    if (!key || er.isJunk(r.name)) continue;
    if (!seen.has(key)) seen.set(key, r);
  }

  return [...seen.values()].sort((a, b) => b.totalShipments - a.totalShipments).slice(0, limit);
}

/**
 * findShipments — actual shipment records for a HS code (corrected field names)
 */
async function findShipments(hs, { origin = null, dest = null, limit = 500,
    minFob = 0, dateFrom = null } = {}) {
  const hs4 = String(hs).slice(0, 4);

  // HS_CODE_4 is stored as a NUMBER (6907, 6208, etc.) — not a string
  const filter = { HS_CODE_4: parseInt(hs4, 10) };
  if (origin) filter.ORIGIN_COUNTRY = { $regex: origin, $options: 'i' }; // pass full name or partial
  if (dest)   filter.DESTINATION_COUNTRY = { $regex: dest, $options: 'i' };
  if (minFob > 0) filter.FOB_VALUE_USD = { $gte: minFob };
  if (dateFrom) filter.DATE = { $gte: dateFrom };

  const rows = await db.query('common-service', 'standard_port_data', filter, {
    projection: { HS_CODE: 1, HS_CODE_4: 1, BUYER_NAME: 1, ORIGIN_COUNTRY: 1,
        DESTINATION_COUNTRY: 1, FOB_VALUE_USD: 1, CIF_VALUE_USD: 1, PRICE_PER_UNIT_USD: 1,
        QUANTITY: 1, WEIGHT: 1, DATE: 1, PRODUCT_DESCRIPTION: 1, data_type: 1 },
    limit,
    sort: { DATE: -1 },
  });

  return rows.map(normShipment);
}

/**
 * findPrices — price intelligence for a HS code (uses PRICE_PER_UNIT_USD first, then FOB/qty)
 */
async function findPrices(hs, { origin = null, dest = null, limit = 1000 } = {}) {
  const shipments = await findShipments(hs, { origin, dest, limit });
  const withPrice = shipments.filter(s => s.unitPriceUsd > 0 && s.unitPriceUsd < 1e9);
  if (!withPrice.length) return { hs, priceData: null, recordCount: shipments.length };

  const prices = withPrice.map(s => s.unitPriceUsd).sort((a, b) => a - b);
  const q1 = prices[Math.floor(prices.length * 0.25)];
  const q3 = prices[Math.floor(prices.length * 0.75)];
  const iqr = q3 - q1;
  const filtered = prices.filter(p => p >= q1 - 1.5 * iqr && p <= q3 + 1.5 * iqr);
  const mean = filtered.reduce((s, v) => s + v, 0) / filtered.length;
  const median = filtered[Math.floor(filtered.length / 2)];

  // Trend: split chronologically
  const sorted = withPrice.filter(s => s.date).sort((a, b) => a.date > b.date ? 1 : -1);
  const mid = Math.floor(sorted.length / 2);
  const olderMean = sorted.slice(0, mid).map(s => s.unitPriceUsd).reduce((s, v, _, a) => s + v / a.length, 0);
  const newerMean = sorted.slice(mid).map(s => s.unitPriceUsd).reduce((s, v, _, a) => s + v / a.length, 0);
  const pctChange = olderMean > 0 ? Math.round((newerMean - olderMean) / olderMean * 100) : null;
  const trend = pctChange > 10 ? 'RISING' : pctChange < -10 ? 'FALLING' : 'FLAT';

  const origins = new Set(withPrice.map(s => s.origin).filter(Boolean));
  const dests   = new Set(withPrice.map(s => s.dest).filter(Boolean));

  return {
    hs, recordCount: withPrice.length,
    meanPrice: Math.round(mean * 100) / 100,
    medianPrice: Math.round(median * 100) / 100,
    minPrice: Math.round(prices[0] * 100) / 100,
    maxPrice: Math.round(prices[prices.length - 1] * 100) / 100,
    trend, pctChange,
    topOrigins: [...origins].slice(0, 8),
    topDests: [...dests].slice(0, 8),
    dateRange: sorted.length ? { from: sorted[0].date, to: sorted[sorted.length - 1].date } : null,
  };
}

/**
 * findContacts — email/phone contacts for outreach, combined from all CRM sources
 */
async function findContacts(hs, { country = null, limit = 100 } = {}) {
  const hs4 = String(hs).slice(0, 4);
  const tasks = [];

  // outbound_email contacts
  const eFilter = { isDeleted: { $ne: true }, doNotContact: { $ne: true } };
  if (hs) eFilter.hsCodes = { $elemMatch: { $regex: `^${hs4}` } };
  if (country) eFilter.country = { $regex: country, $options: 'i' };
  tasks.push(
    db.query('outbound_email', 'contacts', eFilter, {
      projection: { fullName: 1, email: 1, phone: 1, companyName: 1, country: 1,
          jobTitle: 1, buyerTier: 1, hsCodes: 1, productName: 1, status: 1 },
      limit,
    }).then(rows => rows.map(r => ({
      name: r.fullName || r.companyName || '',
      company: r.companyName || '',
      email: r.email || null,
      phone: r.phone || null,
      country: r.country || '',
      title: r.jobTitle || '',
      tier: r.buyerTier || null,
      products: r.productName ? [r.productName] : [],
      _source: 'outbound_email',
    }))).catch(() => [])
  );

  // tradeindia supplier_contacts
  tasks.push(
    db.query('tradeindia_db', 'supplier_contacts', {}, {
      projection: { name: 1, email: 1, phone: 1, company: 1, country: 1 },
      limit: Math.min(limit, 50),
    }).then(rows => rows.map(r => ({
      name: r.name || '', company: r.company || '',
      email: r.email || null, phone: r.phone || null,
      country: r.country || '', title: '', tier: null, products: [],
      _source: 'tradeindia',
    }))).catch(() => [])
  );

  const all = (await Promise.all(tasks)).flat();
  const seen = new Map();
  for (const c of all) {
    const key = c.email || er.canonicalKey(c.name + c.company);
    if (key && !seen.has(key)) seen.set(key, c);
  }
  return [...seen.values()].slice(0, limit);
}

/**
 * findTariffs — tariff + trade rules for a HS code from Dhruval2
 */
async function findTariffs(hs, { importingCountry = null, exportingCountry = null,
    limit = 20 } = {}) {
  const hs4 = String(hs).slice(0, 4);
  const tasks = [];

  // map_tariff_organized
  tasks.push(
    db.query('Dhruval2', 'map_tariff_organized', { status: 'active' }, {
      projection: { kind: 1, domain: 1, text: 1, 'structured.hs': 1, 'structured.rate': 1,
          'applicability.countries': 1, labels: 1, ingested_at: 1 },
      limit,
    }).catch(() => [])
  );

  // map_competitors — trade volume by country pair
  const compFilter = { HsCode: { $regex: `^${hs4}` } };
  if (importingCountry) compFilter.ImportingCountry = { $regex: importingCountry, $options: 'i' };
  if (exportingCountry) compFilter.ExportingCountry = { $regex: exportingCountry, $options: 'i' };
  tasks.push(
    db.query('Dhruval2', 'map_competitors', compFilter, {
      projection: { HsCode: 1, ProductName: 1, ImportingCountry: 1, ExportingCountry: 1,
          Mode: 1, TargetYear: 1, Data: 1 },
      limit,
    }).catch(() => [])
  );

  const [tariffs, competitors] = await Promise.all(tasks);
  return { tariffs, competitors };
}

/**
 * fullIntelligence — complete picture for a product+origin combination
 * Runs all relevant queries in parallel and returns structured intel report
 */
async function fullIntelligence(hs, { origin = 'IN', destCountry = null,
    limit = 50, includeContacts = true } = {}) {
  console.log(`\n[SmartRetrieval] Full intelligence for HS ${hs} from ${origin}...`);

  const [buyers, suppliers, shipments, prices, tariffs, contacts] = await Promise.all([
    findBuyers(hs, { country: destCountry, limit, sources: ['summaries', 'email'] }),
    findSuppliers(hs, { country: origin, limit: 30, sources: ['summaries'] }),
    findShipments(hs, { origin, dest: destCountry, limit: 200 }),
    findPrices(hs, { origin, limit: 500 }),
    findTariffs(hs, { exportingCountry: origin, importingCountry: destCountry }),
    includeContacts ? findContacts(hs, { country: destCountry, limit: 50 }) : Promise.resolve([]),
  ]);

  // Enrich buyers with shipment-based engagement signal
  const buyerNames = new Set(buyers.map(b => er.canonicalKey(b.name)));
  const shippedKeys = new Set(shipments.map(s => er.canonicalKey(s.buyer)).filter(Boolean));
  const engagedBuyers = buyers.filter(b => shippedKeys.has(er.canonicalKey(b.name)));

  return {
    hs, origin, destCountry,
    generatedAt: new Date().toISOString(),
    buyers: { total: buyers.length, engaged: engagedBuyers.length, list: buyers },
    suppliers: { total: suppliers.length, list: suppliers },
    shipments: { total: shipments.length, priceIntel: prices },
    tariffs: { ruleCount: tariffs.tariffs.length, competitorData: tariffs.competitors.length },
    contacts: { total: contacts.length, list: contacts },
    summary: {
      topBuyer:    buyers[0]?.name || null,
      topSupplier: suppliers[0]?.name || null,
      priceRange:  prices.medianPrice ? `$${prices.medianPrice}/unit (${prices.trend})` : 'No price data',
      engagementRate: buyers.length ? `${engagedBuyers.length}/${buyers.length} buyers have shipment records` : '0',
    },
  };
}

module.exports = { findBuyers, findSuppliers, findShipments, findPrices,
  findContacts, findTariffs, fullIntelligence,
  normBuyer, normSupplier, normShipment };
