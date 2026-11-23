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
  const words = name.trim().split(/\s+/).slice(0, 3);
  const regex = words.join('.*');

  const [imports, exports_] = await Promise.all([
    db.query('common-service', 'standard_port_data',
      { IMPORTER_NAME: { $regex: regex, $options: 'i' } },
      { projection: { EXPORTER_NAME: 1, HS_CODE: 1, VALUE_USD: 1, ORIGIN_COUNTRY: 1,
          DESTINATION_COUNTRY: 1, DATE: 1 }, limit }),
    db.query('common-service', 'standard_port_data',
      { EXPORTER_NAME: { $regex: regex, $options: 'i' } },
      { projection: { IMPORTER_NAME: 1, HS_CODE: 1, VALUE_USD: 1, ORIGIN_COUNTRY: 1,
          DESTINATION_COUNTRY: 1, DATE: 1 }, limit }),
  ]);

  return { imports, exports: exports_ };
}

function analyzePattern(imports, exports_) {
  const importHs = new Set(imports.map(x => String(x.HS_CODE || '').slice(0, 4)));
  const exportHs = new Set(exports_.map(x => String(x.HS_CODE || '').slice(0, 4)));
  const sourceCountries = new Set(imports.map(x => x.ORIGIN_COUNTRY).filter(Boolean));
  const destCountries = new Set(exports_.map(x => x.DESTINATION_COUNTRY).filter(Boolean));
  const suppliers = new Set(imports.map(x => er.canonicalKey(x.EXPORTER_NAME || '')).filter(k => k && k.length > 2));
  const buyers = new Set(exports_.map(x => er.canonicalKey(x.IMPORTER_NAME || '')).filter(k => k && k.length > 2));

  const overlappingHs = [...importHs].filter(h => exportHs.has(h));
  const totalImportValue = imports.reduce((s, x) => s + (x.VALUE_USD || 0), 0);
  const totalExportValue = exports_.reduce((s, x) => s + (x.VALUE_USD || 0), 0);

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
  const { imports, exports: exports_ } = await getTradePattern(name, { limit });
  const pattern = analyzePattern(imports, exports_);
  const classification = classify(pattern);
  return {
    entityName: name,
    classification: { ...classification, description: ENTITY_TYPES[classification.type] || '' },
    pattern,
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
