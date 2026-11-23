'use strict';
/*
 * Phase 2 — Entity Behavior Classifier
 * Classifies entities as: MANUFACTURER, TRADER, DISTRIBUTOR, END_BUYER, INTERMEDIARY
 * Uses trade pattern analysis from standard_port_data.
 * Run: node phase2/behavior-classifier.js "LAMINAM SPA"
 */
const db = require('../lib/db');
const er = require('../lib/entity-resolver');

const ENTITY_TYPES = {
  MANUFACTURER:         'Produces goods; exports more than imports; few input suppliers',
  TRADER_EXPORTER:      'Buys domestically and exports; many suppliers, diverse HS codes',
  TRADER_IMPORTER:      'Imports for domestic distribution; buys from many source countries',
  DISTRIBUTOR:          'Imports and re-exports; ships to multiple destinations',
  END_BUYER:            'Imports for own use; does not export; stable supplier set',
  INTERMEDIARY:         'Both importer and exporter of same/similar HS codes — classic middleman',
  CONGLOMERATE:         'Operates across many HS codes and countries',
  UNKNOWN:              'Insufficient data to classify',
};

async function getTradePattern(name, { limit = 500 } = {}) {
  // Use first word anchored prefix for index scan; additional words filter in-flight
  const words = name.trim().split(/\s+/).filter(Boolean);
  const prefix = words[0];
  const regex = words.length > 1 ? `^${prefix}.*${words.slice(1).join('.*')}` : `^${prefix}`;

  // Use pre-aggregated summaries: indexed on buyer_name / supplier_name — fast.
  // standard_port_data.BUYER_NAME has no index → full scan on 50M+ rows; skip it.
  const [buyerSummaries, supplierSummaries] = await Promise.all([
    db.query('common-service', 'buyer_summaries',
      { buyer_name: { $regex: regex, $options: 'i' } },
      { projection: { buyer_name: 1, buyer_country: 1, buyer_tier: 1, buyer_status: 1,
          total_shipments: 1, total_value_usd: 1, hs_codes: 1, product_descriptions: 1 }, limit: 20 }),
    db.query('common-service', 'supplier_summaries',
      { supplier_name: { $regex: regex, $options: 'i' } },
      { projection: { supplier_name: 1, supplier_country: 1, total_shipments: 1,
          total_value_usd: 1, hs_codes: 1, buyer_countries: 1 }, limit: 20 }),
  ]);

  const imports = buyerSummaries.flatMap(b =>
    (b.hs_codes || []).map(hs => ({
      HS_CODE: hs, FOB_VALUE_USD: (b.total_value_usd || 0) / Math.max((b.hs_codes || []).length, 1),
      ORIGIN_COUNTRY: null, DESTINATION_COUNTRY: b.buyer_country, DATE: null,
    }))
  );

  const exports_ = supplierSummaries.flatMap(s =>
    (s.hs_codes || []).map(hs => ({
      HS_CODE: hs, FOB_VALUE_USD: (s.total_value_usd || 0) / Math.max((s.hs_codes || []).length, 1),
      ORIGIN_COUNTRY: s.supplier_country,
      DESTINATION_COUNTRY: (s.buyer_countries || [])[0] || null, DATE: null,
    }))
  );

  return { imports, exports: exports_, buyerSummaries, supplierSummaries };
}

function analyzePattern(imports, exports_) {
  const importHs = new Set(imports.map(x => String(x.HS_CODE || '').slice(0, 4)));
  const exportHs = new Set(exports_.map(x => String(x.HS_CODE || '').slice(0, 4)));
  const sourceCountries = new Set(imports.map(x => x.ORIGIN_COUNTRY).filter(Boolean));
  const destCountries = new Set(exports_.map(x => x.DESTINATION_COUNTRY).filter(Boolean));
  const suppliers = new Set(imports.map(x => er.canonicalKey(x.ORIGIN_COUNTRY || '')).filter(k => k && k.length > 2));
  const buyers = new Set(exports_.map(x => er.canonicalKey(x.DESTINATION_COUNTRY || '')).filter(k => k && k.length > 2));

  const overlappingHs = [...importHs].filter(h => exportHs.has(h));
  const totalImportValue = imports.reduce((s, x) => s + (x.FOB_VALUE_USD || x.CIF_VALUE_USD || 0), 0);
  const totalExportValue = exports_.reduce((s, x) => s + (x.FOB_VALUE_USD || x.CIF_VALUE_USD || 0), 0);

  return {
    importCount: imports.length, exportCount: exports_.length,
    importValueUsd: Math.round(totalImportValue), exportValueUsd: Math.round(totalExportValue),
    uniqueSuppliers: suppliers.size, uniqueBuyers: buyers.size,
    sourceCountries: [...sourceCountries], destCountries: [...destCountries],
    importHsCodes: [...importHs], exportHsCodes: [...exportHs],
    overlappingHsCodes: overlappingHs,
    exportToImportRatio: imports.length ? exports_.length / imports.length : null,
  };
}

function classify(pattern) {
  const { importCount, exportCount, uniqueSuppliers, uniqueBuyers,
          sourceCountries, destCountries, overlappingHsCodes,
          importHsCodes, exportHsCodes, exportToImportRatio } = pattern;

  // No data
  if (!importCount && !exportCount) return { type: 'UNKNOWN', confidence: 0, reason: 'No shipment records found' };

  // Only exports
  if (!importCount && exportCount > 0) {
    if (exportHsCodes.length <= 3) return { type: 'MANUFACTURER', confidence: 0.80, reason: 'Only exports, focused HS codes' };
    return { type: 'TRADER_EXPORTER', confidence: 0.70, reason: 'Only exports, diverse HS codes' };
  }

  // Only imports
  if (importCount > 0 && !exportCount) {
    if (uniqueSuppliers <= 3 && sourceCountries.length <= 2) return { type: 'END_BUYER', confidence: 0.80, reason: 'Only imports, stable supplier base' };
    return { type: 'TRADER_IMPORTER', confidence: 0.70, reason: 'Only imports, diverse suppliers' };
  }

  // Both imports and exports
  if (overlappingHsCodes.length > 0) {
    return { type: 'INTERMEDIARY', confidence: 0.85,
      reason: `Imports and exports same HS codes: ${overlappingHsCodes.join(', ')}` };
  }

  if (exportToImportRatio >= 5) return { type: 'MANUFACTURER', confidence: 0.75, reason: 'Exports >> Imports — produces from raw materials' };

  if (destCountries.length >= 5) return { type: 'DISTRIBUTOR', confidence: 0.75, reason: `Ships to ${destCountries.length} countries` };

  if (uniqueSuppliers >= 15) return { type: 'TRADER_IMPORTER', confidence: 0.70, reason: `Many suppliers (${uniqueSuppliers}) suggests trading` };

  if (importHsCodes.length >= 10 && exportHsCodes.length >= 10) return { type: 'CONGLOMERATE', confidence: 0.65, reason: 'Diverse HS codes both directions' };

  return { type: 'MANUFACTURER_TRADER', confidence: 0.55, reason: 'Mixed import/export pattern' };
}

async function classifyEntity(name, { limit = 500 } = {}) {
  const { imports, exports: exports_, buyerSummaries, supplierSummaries } = await getTradePattern(name, { limit });
  const pattern = analyzePattern(imports, exports_);
  const classification = classify(pattern);
  return {
    entityName: name,
    classification: { ...classification, description: ENTITY_TYPES[classification.type] || '' },
    pattern,
    buyerProfile: buyerSummaries[0] || null,
    supplierProfile: supplierSummaries[0] || null,
  };
}

if (require.main === module) {
  const name = process.argv[2];
  if (!name) { console.error('Usage: node behavior-classifier.js "<entity name>"'); process.exit(1); }
  classifyEntity(name)
    .then(r => {
      console.log(`\nEntity: ${r.entityName}`);
      console.log(`Classification: ${r.classification.type} (confidence: ${(r.classification.confidence * 100).toFixed(0)}%)`);
      console.log(`Description: ${r.classification.description}`);
      console.log(`Reason: ${r.classification.reason}`);
      console.log(`\nPattern: imports=${r.pattern.importCount}, exports=${r.pattern.exportCount}, suppliers=${r.pattern.uniqueSuppliers}, buyers=${r.pattern.uniqueBuyers}`);
    })
    .catch(e => { console.error('FAILED:', e.message); process.exit(1); })
    .finally(() => db.close());
}

module.exports = { classifyEntity, classify, analyzePattern, ENTITY_TYPES };
