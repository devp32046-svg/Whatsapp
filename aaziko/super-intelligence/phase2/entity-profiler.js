'use strict';
/*
 * Phase 2 — Entity Profiler
 * Builds a comprehensive profile for a company/buyer/supplier by aggregating data
 * from buyer_summaries, supplier_summaries, standard_port_data, and outbound_email.
 * Returns: entityProfile object with trade history, relationships, behavior classification.
 *
 * Usage:
 *   node phase2/entity-profiler.js "LAMINAM SPA"
 *   const { buildProfile } = require('./entity-profiler'); await buildProfile('LAMINAM SPA');
 */
const db = require('../lib/db');
const er = require('../lib/entity-resolver');

const BEHAVIOR_THRESHOLDS = {
  MANUFACTURER_SUPPLIER_RATIO: 5,  // supplierShipments >> buyerShipments → manufacturer
  TRADER_MAX_SUPPLIERS: 20,        // too many suppliers = trader/intermediary
  DISTRIBUTOR_MIN_DEST: 5,         // ships to 5+ countries = distributor
};

async function findBuyerSummary(name) {
  const key = er.canonicalKey(name);
  try {
    const docs = await db.query('common-service', 'buyer_summaries',
      { buyer_name: { $regex: name.split(/\s+/).slice(0, 3).join('.*'), $options: 'i' } },
      { projection: { buyer_name: 1, buyer_country: 1, total_shipments: 1, total_value_usd: 1,
          annual_volume: 1, hs_codes: 1, buyer_tier: 1, 'recommendation.priority_score': 1,
          'recommendation.priority_tier': 1 }, limit: 5 }
    );
    if (!docs.length) return null;
    // Pick closest canonical match
    return docs.sort((a, b) => {
      const scoreA = er.isSameEntity(a.buyer_name, name) ? 1 : 0;
      const scoreB = er.isSameEntity(b.buyer_name, name) ? 1 : 0;
      return scoreB - scoreA;
    })[0];
  } catch (e) {
    return null;
  }
}

async function findSupplierSummary(name) {
  try {
    const docs = await db.query('common-service', 'supplier_summaries',
      { supplier_name: { $regex: name.split(/\s+/).slice(0, 3).join('.*'), $options: 'i' } },
      { projection: { supplier_name: 1, supplier_country: 1, hs_codes: 1, total_value_usd: 1, dest_countries: 1 }, limit: 5 }
    );
    return docs.length ? docs[0] : null;
  } catch (e) {
    return null;
  }
}

async function getShipmentHistory(name, { limit = 50 } = {}) {
  const words = name.trim().split(/\s+/).slice(0, 3);
  const regex = words.join('.*');
  try {
    const [asImporter, asExporter] = await Promise.all([
      db.query('common-service', 'standard_port_data',
        { IMPORTER_NAME: { $regex: regex, $options: 'i' } },
        { projection: { IMPORTER_NAME: 1, EXPORTER_NAME: 1, HS_CODE: 1, VALUE_USD: 1,
            QUANTITY: 1, DATE: 1, ORIGIN_COUNTRY: 1, DESTINATION_COUNTRY: 1, PORT_OF_LOADING: 1 },
          limit, sort: { DATE: -1 } }),
      db.query('common-service', 'standard_port_data',
        { EXPORTER_NAME: { $regex: regex, $options: 'i' } },
        { projection: { IMPORTER_NAME: 1, EXPORTER_NAME: 1, HS_CODE: 1, VALUE_USD: 1,
            QUANTITY: 1, DATE: 1, ORIGIN_COUNTRY: 1, DESTINATION_COUNTRY: 1, PORT_OF_LOADING: 1 },
          limit, sort: { DATE: -1 } }),
    ]);
    return { asImporter, asExporter };
  } catch (e) {
    return { asImporter: [], asExporter: [], error: e.message };
  }
}

async function getOutreachHistory(name, email = null) {
  try {
    const filter = email ? { toEmail: email } : { companyName: { $regex: name.split(/\s+/)[0], $options: 'i' } };
    const msgs = await db.query('outbound_email', 'messages', filter,
      { projection: { toEmail: 1, subject: 1, sentAt: 1, status: 1, openCount: 1, clickCount: 1 },
        limit: 20, sort: { sentAt: -1 } });
    return msgs;
  } catch (e) {
    return [];
  }
}

function classifyBehavior(profile) {
  const { asImporter = [], asExporter = [] } = profile.shipmentHistory || {};
  const importCount = asImporter.length;
  const exportCount = asExporter.length;

  const uniqueSuppliers = new Set(asImporter.map(s => er.canonicalKey(s.EXPORTER_NAME || ''))).size;
  const uniqueDestinations = new Set(asExporter.map(s => s.DESTINATION_COUNTRY || '')).size;

  let classification = 'UNKNOWN';
  let confidence = 0.5;

  if (exportCount > 0 && importCount === 0) {
    classification = 'EXPORTER_ONLY'; confidence = 0.8;
  } else if (importCount > 0 && exportCount === 0) {
    if (uniqueSuppliers <= 3) { classification = 'END_BUYER'; confidence = 0.75; }
    else { classification = 'TRADER_IMPORTER'; confidence = 0.70; }
  } else if (exportCount > 0 && importCount > 0) {
    const ratio = exportCount / Math.max(importCount, 1);
    if (ratio >= BEHAVIOR_THRESHOLDS.MANUFACTURER_SUPPLIER_RATIO) {
      classification = 'MANUFACTURER'; confidence = 0.80;
    } else if (uniqueSuppliers >= BEHAVIOR_THRESHOLDS.TRADER_MAX_SUPPLIERS) {
      classification = 'TRADER_INTERMEDIARY'; confidence = 0.75;
    } else if (uniqueDestinations >= BEHAVIOR_THRESHOLDS.DISTRIBUTOR_MIN_DEST) {
      classification = 'DISTRIBUTOR'; confidence = 0.70;
    } else {
      classification = 'MANUFACTURER_TRADER'; confidence = 0.60;
    }
  }

  return { classification, confidence, importCount, exportCount, uniqueSuppliers, uniqueDestinations };
}

async function buildProfile(entityName, { includeShipments = true } = {}) {
  console.log(`Building profile: "${entityName}"`);
  const profile = {
    entityName,
    canonicalKey: er.canonicalKey(entityName),
    generatedAt: new Date().toISOString(),
  };

  const [buyerSummary, supplierSummary] = await Promise.all([
    findBuyerSummary(entityName),
    findSupplierSummary(entityName),
  ]);

  profile.buyerProfile = buyerSummary;
  profile.supplierProfile = supplierSummary;

  if (includeShipments) {
    profile.shipmentHistory = await getShipmentHistory(entityName);
  }

  profile.outreachHistory = await getOutreachHistory(entityName);
  profile.behaviorClassification = classifyBehavior(profile);

  // Compute key metrics
  const totalImportValue = (profile.shipmentHistory?.asImporter || [])
    .reduce((s, x) => s + (x.VALUE_USD || 0), 0);
  const totalExportValue = (profile.shipmentHistory?.asExporter || [])
    .reduce((s, x) => s + (x.VALUE_USD || 0), 0);

  profile.metrics = {
    totalImportValueUsd: Math.round(totalImportValue),
    totalExportValueUsd: Math.round(totalExportValue),
    priorityScore: buyerSummary?.recommendation?.priority_score || null,
    priorityTier: buyerSummary?.recommendation?.priority_tier || null,
    hsCodes: buyerSummary?.hs_codes || supplierSummary?.hs_codes || [],
    country: buyerSummary?.buyer_country || supplierSummary?.supplier_country || null,
    outreachCount: profile.outreachHistory.length,
  };

  return profile;
}

if (require.main === module) {
  const name = process.argv[2] || 'LAMINAM SPA';
  buildProfile(name)
    .then(p => {
      console.log('\n=== ENTITY PROFILE ===');
      console.log(JSON.stringify(p, null, 2));
    })
    .catch(e => { console.error('FAILED:', e.message); process.exit(1); })
    .finally(() => db.close());
}

module.exports = { buildProfile, classifyBehavior, findBuyerSummary, findSupplierSummary };
