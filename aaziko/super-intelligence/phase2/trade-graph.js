'use strict';
/*
 * Phase 2 — Trade Relationship Graph Builder
 * Builds a supplier→buyer trade graph for a given HS code or company name.
 * Detects: direct relationships, intermediaries, circular routes, and volume shifts.
 * Run: node phase2/trade-graph.js --hs 690810 --country IN
 */
const db = require('../lib/db');
const er = require('../lib/entity-resolver');

async function buildHsGraph(hs6, { originCountry = null, limit = 500 } = {}) {
  const filter = { HS_CODE: { $regex: `^${hs6}`, $options: 'i' } };
  if (originCountry) filter.ORIGIN_COUNTRY = originCountry;

  const shipments = await db.query('common-service', 'standard_port_data', filter, {
    projection: { IMPORTER_NAME: 1, EXPORTER_NAME: 1, HS_CODE: 1, VALUE_USD: 1,
        DATE: 1, ORIGIN_COUNTRY: 1, DESTINATION_COUNTRY: 1, QUANTITY: 1 },
    limit,
    sort: { DATE: -1 },
  });

  return buildGraph(shipments);
}

async function buildCompanyGraph(companyName, { limit = 300 } = {}) {
  const words = companyName.trim().split(/\s+/).slice(0, 3);
  const regex = words.join('.*');

  const [asExporter, asImporter] = await Promise.all([
    db.query('common-service', 'standard_port_data',
      { EXPORTER_NAME: { $regex: regex, $options: 'i' } },
      { projection: { IMPORTER_NAME: 1, EXPORTER_NAME: 1, HS_CODE: 1, VALUE_USD: 1,
          DATE: 1, ORIGIN_COUNTRY: 1, DESTINATION_COUNTRY: 1 }, limit }),
    db.query('common-service', 'standard_port_data',
      { IMPORTER_NAME: { $regex: regex, $options: 'i' } },
      { projection: { IMPORTER_NAME: 1, EXPORTER_NAME: 1, HS_CODE: 1, VALUE_USD: 1,
          DATE: 1, ORIGIN_COUNTRY: 1, DESTINATION_COUNTRY: 1 }, limit }),
  ]);

  return buildGraph([...asExporter, ...asImporter]);
}

function buildGraph(shipments) {
  const nodes = new Map();  // canonicalKey → { name, role, totalValueUsd, shipmentCount, countries }
  const edges = new Map();  // `${from}→${to}` → { count, totalValueUsd, hsCodes, lastDate }

  for (const s of shipments) {
    const exporterKey = er.canonicalKey(s.EXPORTER_NAME);
    const importerKey = er.canonicalKey(s.IMPORTER_NAME);
    if (!exporterKey || !importerKey || er.isJunk(s.EXPORTER_NAME) || er.isJunk(s.IMPORTER_NAME)) continue;

    // Nodes
    if (!nodes.has(exporterKey)) nodes.set(exporterKey, { name: s.EXPORTER_NAME, role: 'exporter', totalValueUsd: 0, shipmentCount: 0, countries: new Set() });
    if (!nodes.has(importerKey)) nodes.set(importerKey, { name: s.IMPORTER_NAME, role: 'importer', totalValueUsd: 0, shipmentCount: 0, countries: new Set() });

    const val = s.VALUE_USD || 0;
    nodes.get(exporterKey).totalValueUsd += val;
    nodes.get(exporterKey).shipmentCount++;
    if (s.ORIGIN_COUNTRY) nodes.get(exporterKey).countries.add(s.ORIGIN_COUNTRY);

    nodes.get(importerKey).totalValueUsd += val;
    nodes.get(importerKey).shipmentCount++;
    if (s.DESTINATION_COUNTRY) nodes.get(importerKey).countries.add(s.DESTINATION_COUNTRY);

    // Edges
    const edgeKey = `${exporterKey}→${importerKey}`;
    if (!edges.has(edgeKey)) edges.set(edgeKey, { from: exporterKey, to: importerKey,
        fromName: s.EXPORTER_NAME, toName: s.IMPORTER_NAME,
        count: 0, totalValueUsd: 0, hsCodes: new Set(), lastDate: null });
    const edge = edges.get(edgeKey);
    edge.count++;
    edge.totalValueUsd += val;
    if (s.HS_CODE) edge.hsCodes.add(String(s.HS_CODE).slice(0, 6));
    if (s.DATE && (!edge.lastDate || s.DATE > edge.lastDate)) edge.lastDate = s.DATE;
  }

  // Detect intermediaries: entities that are both importer AND exporter
  const exporters = new Set(shipments.map(s => er.canonicalKey(s.EXPORTER_NAME)));
  const importers = new Set(shipments.map(s => er.canonicalKey(s.IMPORTER_NAME)));
  const intermediaries = [...exporters].filter(k => importers.has(k));
  for (const k of intermediaries) {
    if (nodes.has(k)) nodes.get(k).role = 'intermediary';
  }

  // Serialize
  const result = {
    shipmentCount: shipments.length,
    nodeCount: nodes.size,
    edgeCount: edges.size,
    intermediaryCount: intermediaries.length,
    nodes: {},
    edges: [],
    topEdges: [],
  };

  for (const [k, n] of nodes) {
    result.nodes[k] = { ...n, countries: [...n.countries] };
  }

  result.edges = [...edges.values()].map(e => ({ ...e, hsCodes: [...e.hsCodes] }));
  result.topEdges = [...edges.values()]
    .sort((a, b) => b.totalValueUsd - a.totalValueUsd)
    .slice(0, 20)
    .map(e => ({ from: e.fromName, to: e.toName, count: e.count,
        totalValueUsd: Math.round(e.totalValueUsd), hsCodes: [...e.hsCodes] }));

  return result;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const hsIdx = args.indexOf('--hs');
  const hs = hsIdx >= 0 ? args[hsIdx + 1] : null;
  const companyIdx = args.indexOf('--company');
  const company = companyIdx >= 0 ? args[companyIdx + 1] : null;

  if (!hs && !company) {
    console.error('Usage: --hs <hs6> [--country <iso2>]  OR  --company "<name>"');
    process.exit(1);
  }

  const run = hs ? buildHsGraph(hs) : buildCompanyGraph(company);
  run.then(g => {
    console.log(`\n=== TRADE GRAPH ===`);
    console.log(`Nodes: ${g.nodeCount} | Edges: ${g.edgeCount} | Intermediaries: ${g.intermediaryCount}`);
    console.log(`\nTop 10 trade relationships by value:`);
    g.topEdges.slice(0, 10).forEach((e, i) =>
      console.log(`  ${i + 1}. ${e.from} → ${e.to}: $${(e.totalValueUsd / 1000).toFixed(0)}K (${e.count} shipments)`));
  }).catch(e => { console.error('FAILED:', e.message); process.exit(1); })
    .finally(() => db.close());
}

module.exports = { buildHsGraph, buildCompanyGraph, buildGraph };
