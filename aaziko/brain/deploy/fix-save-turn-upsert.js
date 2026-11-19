'use strict';
/*
 * Fix Save Turn: mongoDb insert was inserting empty {_id} only.
 * Root cause: n8n mongoDb `insert` with no `fields` param inserts blank doc.
 *
 * Fix: use `update` with upsert:true + updateKey:'ts'.
 * Each turn has a unique ts (human: now, ai: now+1ms), so ts acts as a unique key.
 * n8n mongoDb `update` correctly maps all item JSON fields to the document.
 *
 * Also clear the broken empty docs from az_chat_memory.
 *
 * node aaziko/brain/deploy/fix-save-turn-upsert.js          -- dry run
 * node aaziko/brain/deploy/fix-save-turn-upsert.js --write  -- apply
 */
const path = require('path');
const fs   = require('fs');
const { MongoClient } = require('mongodb');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const WRITE      = process.argv.includes('--write');
const BRAIN_ID   = 'w7no6uCJkz7lfaah';
const BACKUP_DIR = path.resolve(__dirname, '../../../backups');
const MONGO_URI  = process.env.AAZIKO_MONGO_URI ||
  'mongodb://admin:Aaziko%21%40%23123@100.70.212.45:27017/?authSource=admin&directConnection=true';

(async () => {
  require('dotenv').config();
  console.log('=== Fix: Save Turn empty-doc bug ===');
  console.log('Problem: mongoDb insert with no fields param → {_id} only');
  console.log('Fix: operation:update + upsert:true + updateKey:ts\n');

  const wf = await getWf(BRAIN_ID);
  const st = wf.nodes.find(n => n.name === 'Save Turn');
  if (!st) { console.log('❌ Save Turn not found'); process.exit(1); }

  console.log('Current Save Turn operation:', st.parameters.operation);

  // ── Check broken docs in MongoDB ─────────────────────────────────────────
  const mc = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await mc.connect();
  const coll = mc.db('aaziko_organized').collection('az_chat_memory');

  const total = await coll.countDocuments({});
  const broken = await coll.countDocuments({ sessionKey: { $exists: false } });
  console.log('az_chat_memory total:', total, '| broken (no sessionKey):', broken);

  if (!WRITE) {
    await mc.close();
    console.log('\n(dry run — pass --write to apply)');
    return;
  }

  // ── 1. Delete broken empty docs ───────────────────────────────────────────
  if (broken > 0) {
    const del = await coll.deleteMany({ sessionKey: { $exists: false } });
    console.log('Deleted', del.deletedCount, 'broken empty docs');
  }
  await mc.close();

  // ── 2. Patch Save Turn node ───────────────────────────────────────────────
  const bk = path.join(BACKUP_DIR, BRAIN_ID + '_before_save-turn-upsert.json');
  fs.writeFileSync(bk, JSON.stringify(wf, null, 2), 'utf8');
  console.log('Backup:', bk);

  // Switch from insert → update with upsert
  // n8n mongoDb update: updateKey = field used as filter, upsert = true
  // All other item fields get written to the document automatically
  st.parameters = {
    operation: 'update',
    collection: 'az_chat_memory',
    updateKey: 'ts',
    upsert: true
  };

  const settings = Object.assign({}, wf.settings);
  delete settings.binaryMode;

  const r = await putWf(BRAIN_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings });
  if (r.status !== 200) {
    console.log('❌ PUT failed (' + r.status + '):', JSON.stringify(r.body).slice(0, 200));
    process.exit(1);
  }
  await activate(BRAIN_ID);

  const check = await getWf(BRAIN_ID);
  const live = check.nodes.find(n => n.name === 'Save Turn');
  const ok = live.parameters.operation === 'update' && live.parameters.upsert === true;
  console.log(ok ? '✅ Save Turn → update + upsert:true live' : '❌ VERIFY FAILED');
  console.log('  updateKey:', live.parameters.updateKey);
  console.log('  upsert:', live.parameters.upsert);

  if (ok) {
    console.log('\n✅ Fix applied. Next turn saved will have sessionKey, role, content, ts in MongoDB.');
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
