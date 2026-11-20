'use strict';
require('dotenv').config();
const { MongoClient } = require('mongodb');
const URI = process.env.AAZIKO_DB_URI || 'mongodb://admin:Aaziko%21%40%23123@100.70.212.45:27017/?authSource=admin&directConnection=true';

(async () => {
  const c = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 8000 });
  const col = c.db('indiamart').collection('products');

  function andQuery(words) {
    return { $and: words.map(w => ({ $or: [
      { product_name: { $regex: w, $options: 'i' } },
      { category:     { $regex: w, $options: 'i' } }
    ]}))};
  }

  // With "India" (what brain passes) - AND requires all 5 words
  const withIndia = await col.countDocuments(andQuery(['stainless','steel','industrial','valves','India']));
  console.log('stainless+steel+industrial+valves+India:', withIndia);

  // Without "India"
  const withoutIndia = await col.countDocuments(andQuery(['stainless','steel','valve']));
  console.log('stainless+steel+valve (3 words):', withoutIndia);

  const withoutIndia2 = await col.countDocuments(andQuery(['stainless','steel','industrial','valve']));
  console.log('stainless+steel+industrial+valve (4 words):', withoutIndia2);

  // Show a sample of what stainless steel valve finds
  const sample = await col.find(andQuery(['stainless','steel','valve'])).limit(3).toArray();
  console.log('\nSample stainless steel valve products:');
  sample.forEach((p,i) => console.log((i+1) + '.', p.product_name, '|', p.category));

  // Check tariff hs6 field format for 730511 neighbors
  const tariff = c.db('aaziko_organized').collection('tp_partner_tariff_organized');
  const hs73 = await tariff.find({ 'applicability.product.hs6': { $regex: '^7305' } }).limit(5).toArray();
  console.log('\nTariff HS 7305xx coverage:');
  hs73.forEach(t => {
    const p = t.applicability && t.applicability.product;
    console.log('  hs6:', p && p.hs6, '| reporter:', t.applicability && t.applicability.reporter);
  });
  if (!hs73.length) console.log('  NO data for HS 7305xx in tariff DB');

  await c.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
