'use strict';
/* Export RAW standard_port_data rows + every processed layer for the buyers on the console. */
const XLSX = require('xlsx');
const db = require('./db.js');
const OUT = process.argv[2] || '/tmp/aaziko-raw-and-processed.xlsx';
const RAW_FIELDS = ['IMPORTER_NAME','STD_BUYER_NAME','BUYER_NAME','CONSIGNEE_NAME','HS_CODE','HS_CODE_DESCRIPTION',
  'DATE_ISO','DATE','MONTH_YEAR','TOTAL_VALUE_USD','VALUE_USD','INVOICE_VALUE_USD','TOTAL_QUANTITY','QUANTITY','NET_WEIGHT',
  'QUANTITY_UNIT','STD_UNIT','STD_SUPPLIER_NAME','EXPORTER_NAME','SUPPLIER_NAME','SHIPPER_NAME',
  'DESTINATION_COUNTRY','ORIGIN_COUNTRY','COUNTRY','data_type'];
const get = async u => (await (await fetch('http://localhost:3077' + u)).json());
(async () => {
  const s = (await get('/api/state')).snapshot;
  const buyers = s.buyers;
  const coll = (await db.getClient()).db('common-service').collection('standard_port_data');
  const RAW = [], EVENTS = [], PRODUCTS = [], SUPPLIERS = [], MONTHLY = [], SWITCHES = [], SUMMARY = [];
  for (const b of buyers) {
    const name = b.importer_name || b.name;
    SUMMARY.push({ buyer: b.name, buyer_key: b.buyer_key, importer_name: name, country: b.country, score: b.score,
      frequency_class: b.freq, median_gap_days: b.median, stability: b.stability, dependency: b.dependency, hhi: b.hhi,
      orders_tracked_hs: b.orders, value_tracked_hs: b.value, annualized: b.annualized, confidence: b.conf, conf_band: b.band,
      product_fit: b.comps.product_fit, c_frequency: b.comps.frequency, c_volume: b.comps.volume, c_supplier: b.comps.supplier, c_india: b.comps.india_adv,
      confidence_basis: b.conf_basis });
    // ---- RAW rows straight from Mongo (no processing) ----
    const rows = await coll.find({ IMPORTER_NAME: name },
      { projection: Object.fromEntries(RAW_FIELDS.map(k => [k, 1])) }).toArray();
    for (const r of rows) {
      const o = { _buyer: b.name, _id: String(r._id), HS_CODE_TYPE: typeof r.HS_CODE };
      for (const f of RAW_FIELDS) o[f] = r[f] instanceof Date ? r[f].toISOString().slice(0, 10) : (r[f] ?? '');
      RAW.push(o);
    }
    // ---- PROCESSED ----
    const full = await get('/api/buyer_full?name=' + encodeURIComponent(name));
    for (const p of (full.products || [])) {
      PRODUCTS.push({ buyer: b.name, hs6: p.hs6, product: p.desc, orders: p.orders, total_value_usd: p.value, unit: p.unit,
        annualized_usd: p.annualized, avg_unit_price: p.avg_unit_price, frequency_class: p.frequency_class,
        median_gap_days: p.median, mean_gap_days: p.mean_interval, stability: p.stability, dependency: p.dependency, hhi: p.hhi,
        n_suppliers: (p.supplier_patterns || []).length, sourcing_type: (p.switching_pattern || {}).type,
        sourcing_summary: (p.switching_pattern || {}).summary, switches: (p.supplier_changes || []).length,
        first_order: p.span[0], last_order: p.span[1], behaviour: (p.behaviour || []).join('; '),
        contact_window: p.contact && p.contact.emitted ? p.contact.statement : (p.contact || {}).reason });
      for (const e of (p.events_full || []))
        EVENTS.push({ buyer: b.name, hs6: p.hs6, date: e.date, supplier: e.supplier, value_usd: e.value, qty: e.qty,
          unit: e.unit, unit_price: e.unit_price, event_confidence: e.conf });
      for (const r of (p.supplier_patterns || []))
        SUPPLIERS.push({ buyer: b.name, hs6: p.hs6, supplier: r.supplier, role: r.role, status: r.status,
          orders: r.shipments, total_qty: r.total_qty, avg_qty_per_order: r.avg_qty, value_usd: r.value,
          share_pct: r.share != null ? +(r.share * 100).toFixed(1) : null, avg_unit_price: r.avg_unit_price,
          cadence_class: r.cadence_class, median_gap_days: r.median_gap, first: r.first, last: r.last,
          days_since_last: r.days_since_last, qty_trend: r.qty_trend, qty_trend_pct: r.qty_trend_pct,
          price_trend: r.price_trend, price_trend_pct: r.price_trend_pct });
      const mo = p.monthly;
      if (mo) for (const t of mo.totals) {
        const row = { buyer: b.name, hs6: p.hs6, month: t.month, buyer_orders: t.orders, buyer_qty: t.qty, buyer_value_usd: t.value };
        for (const sup of mo.by_supplier) { const c = sup.cells.find(c => c.month === t.month) || {};
          row[sup.supplier.slice(0, 28) + ' | orders'] = c.orders || 0; row[sup.supplier.slice(0, 28) + ' | value'] = c.value || 0; }
        MONTHLY.push(row);
      }
      for (const c of (p.supplier_changes || []))
        SWITCHES.push({ buyer: b.name, hs6: p.hs6, date: c.date, from_supplier: c.from, to_supplier: c.to,
          gap_days: c.gap_days, from_unit_price: c.from_unit_price, to_unit_price: c.to_unit_price,
          price_change_pct: c.price_change_pct, qty_change_pct: c.qty_change_pct,
          signals_supported_by_data: (c.supported_reasons || []).join('; ') || 'none',
          candidate_reasons: (c.candidate_reasons || []).join('; ') });
    }
    console.log('  ' + b.name.slice(0, 38).padEnd(39) + 'raw=' + rows.length + ' products=' + (full.products || []).length);
  }
  const README = [
    { A: 'AAZIKO TRADE INTELLIGENCE — RAW + PROCESSED EXPORT' }, { A: '' },
    { A: 'Run', B: s.run_id }, { A: 'as_of', B: s.as_of }, { A: 'Generated from the live service on :3077' }, { A: '' },
    { A: 'SOURCE OF RAW DATA' },
    { A: 'Database', B: 'common-service' }, { A: 'Collection', B: 'standard_port_data (222,282,898 rows total)' },
    { A: 'Query per buyer', B: '{ IMPORTER_NAME: "<buyer>" }  — IMPORTER_NAME is indexed (IMPORTER_NAME_1)' },
    { A: 'Note', B: 'STD_BUYER_NAME is NOT indexed (a query on it collscans 222M rows and times out)' },
    { A: 'Console discovery query', B: '{ HS_CODE: {$in: ["69072100", 69072100]} } grouped by STD_BUYER_NAME — HS_CODE exists as BOTH string and number for the same code; both must be matched' }, { A: '' },
    { A: 'SHEETS' },
    { A: 'RAW_ROWS', B: 'Untouched rows as stored in Mongo (only the fields the engine reads). HS_CODE_TYPE shows string vs number.' },
    { A: 'EVENTS_NORMALIZED', B: 'After §03 field-coalescing + de-duplication — the actual input to every calculation.' },
    { A: 'PRODUCTS', B: 'One row per buyer x HS6: cadence, frequency class, sourcing type, dependency.' },
    { A: 'SUPPLIERS', B: 'One row per buyer x HS6 x supplier: how the buyer buys from each (qty, price, cadence, trends, role, status).' },
    { A: 'MONTHLY', B: 'One row per buyer x HS6 x month: buyer totals + per-supplier orders/value in that month.' },
    { A: 'SWITCHES', B: 'Supplier changes with price/qty deltas and which candidate reasons the data supports (signals only).' },
    { A: 'BUYERS_SUMMARY', B: 'Console-level score and its components per buyer.' }, { A: '' },
    { A: 'PROCESSING APPLIED TO RAW -> EVENTS' },
    { A: '1. Field coalesce', B: 'value=TOTAL_VALUE_USD>VALUE_USD>...; qty=TOTAL_QUANTITY>QUANTITY>NET_WEIGHT; date=DATE_ISO>DATE>MONTH_YEAR; supplier=STD_SUPPLIER_NAME>EXPORTER_NAME>...' },
    { A: '2. Supplier canonicalization', B: '"LAMINAM S P A" = "LAMINAM SPA"; PRIVATE LIMITED = PVT LTD' },
    { A: '3. De-duplication', B: 'same supplier + same date + value AND qty within +/-2% = one shipment counted once (the same shipment appears under both HS_CODE forms)' },
    { A: '4. Drop', B: 'rows with no usable date, or with neither value nor quantity' },
    { A: '', B: '' }, { A: 'READ-ONLY', B: 'Nothing was written to MongoDB.' },
  ];
  const wb = XLSX.utils.book_new();
  const add = (name, data) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), name);
  add('README', README); add('BUYERS_SUMMARY', SUMMARY); add('RAW_ROWS', RAW); add('EVENTS_NORMALIZED', EVENTS);
  add('PRODUCTS', PRODUCTS); add('SUPPLIERS', SUPPLIERS); add('MONTHLY', MONTHLY); add('SWITCHES', SWITCHES);
  XLSX.writeFile(wb, OUT);
  console.log('\nWROTE ' + OUT);
  console.log('  RAW_ROWS=' + RAW.length + '  EVENTS=' + EVENTS.length + '  PRODUCTS=' + PRODUCTS.length +
    '  SUPPLIERS=' + SUPPLIERS.length + '  MONTHLY=' + MONTHLY.length + '  SWITCHES=' + SWITCHES.length);
  await db.close(); process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
