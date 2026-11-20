'use strict';
/*
 * One-time: aggregate trademapsheet.india_share → aaziko_organized.india_top_markets
 * Result: ~5,100 docs, one per unique HS code, each with top 5 export countries + values.
 *
 * Why: trademapsheet DB has no working n8n credential; aaziko_organized does.
 * After this runs, get_top_markets sub-wf can query india_top_markets via organized credential.
 *
 * node aaziko/brain/deploy/materialize-top-markets.js         -- dry run (count only)
 * node aaziko/brain/deploy/materialize-top-markets.js --write -- materialize
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');
const WRITE = process.argv.includes('--write');
const PREFIX = "India's exports to "; // length = 20

(async () => {
  const client = new MongoClient(process.env.AAZIKO_TRADE_DB_URI);
  await client.connect();

  const src  = client.db('trademapsheet').collection('india_share');
  const dest = client.db('aaziko_organized').collection('india_top_markets');

  // Count source
  const total = await src.countDocuments({ 'tradedescription1.Valuein2025,USDthousand': { $gt: 0 } });
  console.log('Source docs with value > 0:', total);

  // Sample check
  const sample = await src.findOne({ ProductCode: '420310', 'tradedescription1.Valuein2025,USDthousand': { $gt: 0 } });
  if (sample) {
    const td = sample.tradedescription1;
    const country = String(td.title || '').slice(PREFIX.length);
    console.log('Sample 420310:', country, '|', td['Valuein2025,USDthousand'], 'K USD');
  }

  if (!WRITE) {
    // Dry run: just count unique HS codes
    const uniqHS = await src.distinct('ProductCode');
    console.log('\nUnique HS codes in india_share:', uniqHS.length);
    console.log('Estimated india_top_markets docs to create:', uniqHS.length);
    console.log('\n(dry run — pass --write to materialize)');
    await client.close();
    return;
  }

  console.log('\nMaterializing...');

  // Drop old collection if exists
  try { await dest.drop(); console.log('Dropped old india_top_markets'); }
  catch(e) { console.log('No existing collection to drop'); }

  // Stream all docs, group by ProductCode, keep top 5 per code
  const map = {}; // hs_code -> { label, markets[] }

  const cursor = src.find({ 'tradedescription1.Valuein2025,USDthousand': { $gt: 0 } });
  let rowCount = 0;

  for await (const doc of cursor) {
    rowCount++;
    const hs = String(doc.ProductCode || '');
    const td = doc.tradedescription1 || {};
    const title = String(td.title || '');
    if (!title.startsWith(PREFIX)) continue;
    const country = title.slice(PREFIX.length);
    const val = Number(td['Valuein2025,USDthousand'] || 0);
    const growth = td['Annualgrowthinvaluebetween2021-2025,%,p.a.'];

    if (!map[hs]) {
      map[hs] = {
        hs_code: hs,
        label: String(doc.ProductLabel || ''),
        markets: [],
        _seen: {}
      };
    }
    if (!map[hs]._seen[country]) {
      map[hs]._seen[country] = true;
      map[hs].markets.push({ country, value_usd_mn: +(val / 1000).toFixed(1), growth_pct_pa: growth !== undefined && growth !== null ? Number(growth) : null });
    }
  }

  console.log('Rows processed:', rowCount, '| Unique HS codes:', Object.keys(map).length);

  // Sort each HS code's markets by value desc, keep top 5, clean up _seen
  const docs = Object.values(map).map(m => {
    const sorted = m.markets.sort((a, b) => b.value_usd_mn - a.value_usd_mn).slice(0, 5);
    return { hs_code: m.hs_code, label: m.label, markets: sorted };
  });

  // Insert all
  if (docs.length) {
    await dest.insertMany(docs, { ordered: false });
    console.log('✅ Inserted', docs.length, 'docs into aaziko_organized.india_top_markets');
  }

  // Create index on hs_code for fast lookups
  await dest.createIndex({ hs_code: 1 }, { unique: true });
  console.log('✅ Index created on hs_code');

  // Verify
  const checkCount = await dest.countDocuments();
  const check420 = await dest.findOne({ hs_code: '420310' });
  console.log('\nVerify count:', checkCount);
  if (check420) {
    console.log('420310 top markets:', check420.markets.map(m => m.country + ' $' + m.value_usd_mn + 'M').join(', '));
  }

  await client.close();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
