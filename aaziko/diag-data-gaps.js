'use strict';
require('dotenv').config();
const { MongoClient } = require('mongodb');
const URI = process.env.AAZIKO_DB_URI || 'mongodb://admin:Aaziko%21%40%23123@100.70.212.45:27017/?authSource=admin&directConnection=true';

(async () => {
  const c = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 8000 });

  // 1. What hs6 values are in tp_partner_tariff_organized?
  const tariff = c.db('aaziko_organized').collection('tp_partner_tariff_organized');
  const hs730 = await tariff.findOne({ 'applicability.product.hs6': '730511' });
  const hs610 = await tariff.findOne({ 'applicability.product.hs6': '610910' });
  const hs730_alt = await tariff.findOne({ 'applicability.product.hs6': { $regex: '^7305' } });
  console.log('Tariff HS 730511:', hs730 ? 'FOUND' : 'NOT FOUND');
  console.log('Tariff HS 610910:', hs610 ? 'FOUND' : 'NOT FOUND');
  console.log('Any HS 730x:', hs730_alt ? hs730_alt['applicability']['product']['hs6'] : 'NONE');

  // Sample 3 hs6 values in collection
  const hs5 = await tariff.aggregate([
    { $group: { _id: '$applicability.product.hs6' } },
    { $limit: 5 }
  ]).toArray();
  console.log('Sample hs6 in tariff:', hs5.map(h => h._id));

  // 2. indiamart.products - what fields does it have?
  const prod = c.db('indiamart').collection('products');
  const sample = await prod.findOne({});
  if (sample) {
    console.log('\nProduct fields:', Object.keys(sample).join(', '));
    console.log('product_name:', sample.product_name || sample.name || '(no name field)');
    // Try valve search
    const valveByName = await prod.findOne({ product_name: { $regex: 'valve', $options: 'i' } });
    const valveByAny = await prod.findOne({ $or: [
      { product_name: { $regex: 'valve', $options: 'i' } },
      { category: { $regex: 'valve', $options: 'i' } },
      { description: { $regex: 'valve', $options: 'i' } }
    ]});
    console.log('Valve by product_name:', valveByName ? valveByName.product_name : 'NOT FOUND');
    console.log('Valve by any field:', valveByAny ? (valveByAny.product_name || 'found but no name') : 'NOT FOUND');
  }

  // 3. search_products prep uses which field?
  // Looking at prep: keyword matched against product_name and category
  // Check what fields exist in products
  const cnt = await prod.countDocuments({ product_name: { $regex: 'stainless steel', $options: 'i' } });
  console.log('\nstainless steel products:', cnt);
  const cnt2 = await prod.countDocuments({ product_name: { $regex: 'valve', $options: 'i' } });
  console.log('valve products:', cnt2);
  const cntIndustrial = await prod.countDocuments({ product_name: { $regex: 'industrial', $options: 'i' } });
  console.log('industrial products:', cntIndustrial);

  await c.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
