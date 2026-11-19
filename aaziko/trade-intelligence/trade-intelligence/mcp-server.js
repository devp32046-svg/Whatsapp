#!/usr/bin/env node
'use strict';
/*
 * Aaziko Trade Intelligence — MCP server (§12), stdio transport, dependency-free.
 * READ-ONLY connection layer: exposes the 8 spec tools over the deterministic
 * snapshot the dashboard service computes (cache/latest.json). It runs no
 * formulas of its own — it only serves what the engine already proved.
 *
 * Register (interactive):  claude mcp add aaziko-trade -- node /home/aaziko/aaziko/trade-intelligence/mcp-server.js
 */
const fs = require('fs');
const path = require('path');
const CACHE = path.join(__dirname, 'cache', 'latest.json');

function snap() { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (e) { return null; } }
function findBuyer(s, k) { return s && s.buyers.find(b => b.buyer_key === k); }

const TOOLS = [
  { name: 'get_company_profile', description: '§1 Company understanding for a buyer_key: name, role, HS/family, active span, txn count, total & annualized value, confidence.', inputSchema: { type: 'object', properties: { buyer_key: { type: 'string' } }, required: ['buyer_key'] } },
  { name: 'get_trade_history', description: '§3 Full normalized shipment events for a buyer_key (date, supplier, value, qty, unit, unit price, event confidence).', inputSchema: { type: 'object', properties: { buyer_key: { type: 'string' } }, required: ['buyer_key'] } },
  { name: 'get_product_history', description: '§2 Product intelligence for a buyer_key: HS, family, orders, avg qty, total value, supplier split.', inputSchema: { type: 'object', properties: { buyer_key: { type: 'string' } }, required: ['buyer_key'] } },
  { name: 'get_supplier_history', description: '§6/§7 Supplier relationship + change signals for a buyer_key: split, dependency class, HHI, detected switches.', inputSchema: { type: 'object', properties: { buyer_key: { type: 'string' } }, required: ['buyer_key'] } },
  { name: 'get_buyer_pattern', description: '§4/§5/§8 Frequency class, intervals, stability, contact window, behaviour labels for a buyer_key.', inputSchema: { type: 'object', properties: { buyer_key: { type: 'string' } }, required: ['buyer_key'] } },
  { name: 'get_opportunity_score', description: '§11 Deterministic opportunity score (0–100) + component breakdown for a buyer_key.', inputSchema: { type: 'object', properties: { buyer_key: { type: 'string' } }, required: ['buyer_key'] } },
  { name: 'get_supplier_match', description: '§9 Indian supplier/product candidates (product, price, MOQ, match %). Optional hs filter.', inputSchema: { type: 'object', properties: { hs: { type: 'string' } } } },
  { name: 'get_cost_comparison', description: '§10 Tariff/duty + compliance (NTMs) + ocean freight for lanes. Optional importing-country filter.', inputSchema: { type: 'object', properties: { country: { type: 'string' } } } },
];

function call(name, args) {
  args = args || {};
  const s = snap();
  if (!s) return { error: 'no snapshot yet — start the dashboard service so it computes cache/latest.json' };
  const b = args.buyer_key ? findBuyer(s, args.buyer_key) : null;
  const nf = () => ({ error: 'buyer_key not found', available: s.buyers.map(x => x.buyer_key) });
  switch (name) {
    case 'get_company_profile': return b ? { buyer_key: b.buyer_key, name: b.name, role: 'importer', hs: b.hs, family: b.family, active_span: b.span, orders: b.orders, total_value_usd: b.value, annualized_usd: b.annualized, confidence: b.conf, _provenance: b._provenance } : nf();
    case 'get_trade_history': return b ? { buyer_key: b.buyer_key, event_count: b.orders, events: b.events_full } : nf();
    case 'get_product_history': return b ? { buyer_key: b.buyer_key, hs: b.hs, family: b.family, orders: b.orders, avg_order_qty: b.avgQty, unit: b.unit, total_value_usd: b.value, supplier_split: b.supplier_split } : nf();
    case 'get_supplier_history': return b ? { buyer_key: b.buyer_key, supplier_split: b.supplier_split, dependency_class: b.dependency, hhi: b.hhi, top1_share: b.top1_share, supplier_changes: b.supplier_changes } : nf();
    case 'get_buyer_pattern': return b ? { buyer_key: b.buyer_key, frequency_class: b.freq, median_interval_days: b.median, mean_interval_days: b.mean_interval, stability: b.stability, intervals: b.intervals, contact_window: b.contact, behaviour: b.behaviour } : nf();
    case 'get_opportunity_score': return b ? { buyer_key: b.buyer_key, score: b.score, components: b.comps, confidence: b.conf, _provenance: b._provenance } : nf();
    case 'get_supplier_match': return { hs: args.hs || 'all', matches: (s.supplier_matches || []).filter(m => !args.hs || m.hs === args.hs) };
    case 'get_cost_comparison': {
      const c = args.country ? String(args.country).toLowerCase() : null;
      return {
        tariff: (s.cost_analysis_results || []).filter(t => !c || t.lane.toLowerCase().includes(c)),
        compliance: (s.compliance || []).filter(x => !c || (x.country || '').toLowerCase().includes(c)),
        freight_sample: (s.freight || []).slice(0, 8),
        note: 'india_advantage stays UNKNOWN until a matching source-lane (e.g. China-origin) rate is available',
      };
    }
    default: return { error: 'unknown tool: ' + name };
  }
}

function send(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
function handle(m) {
  if (m.method === 'initialize') { send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'aaziko-trade-intelligence', version: '1.0.0' } } }); return; }
  if (m.method === 'notifications/initialized' || m.method === 'initialized') return;
  if (m.method === 'tools/list') { send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } }); return; }
  if (m.method === 'tools/call') { const r = call(m.params && m.params.name, m.params && m.params.arguments); send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] } }); return; }
  if (m.method === 'ping') { send({ jsonrpc: '2.0', id: m.id, result: {} }); return; }
  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found: ' + m.method } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; let msg; try { msg = JSON.parse(line); } catch (e) { continue; } handle(msg); } });
process.stdin.on('end', () => process.exit(0));
