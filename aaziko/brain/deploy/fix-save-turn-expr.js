'use strict';
/*
 * Fix Save Turn: use pure {{ }} expressions for query and update — same pattern
 * as Load History's aggregate query.
 *
 * WRONG (embedded expression inside JSON string — n8n ignores it):
 *   query: '{"ts": "={{ $json.ts }}"}'
 *
 * RIGHT (full expression — n8n evaluates the whole value):
 *   query: '={{ JSON.stringify({ts: $json.ts}) }}'
 *
 * node aaziko/brain/deploy/fix-save-turn-expr.js          -- dry run
 * node aaziko/brain/deploy/fix-save-turn-expr.js --write  -- apply
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

// Pure expression format: entire value is an expression (matches Load History pattern)
const SAVE_TURN_PARAMS = {
  operation: 'findOneAndUpdate',
  collection: 'az_chat_memory',
  // Full expression: build query JSON from current item
  query: '={{ JSON.stringify({ts: $json.ts}) }}',
  // Full expression: build $set update from all current item fields
  update: '={{ JSON.stringify({"$set": {sessionKey: $json.sessionKey, role: $json.role, content: $json.content, ts: $json.ts}}) }}',
  upsert: true
};

(async () => {
  require('dotenv').config();
  console.log('=== Fix: Save Turn — pure expression query/update ===');
  console.log('Previous: embedded {{ }} inside JSON string (n8n ignores it)');
  console.log('Fix: entire value = ={{ JSON.stringify({...}) }} (matches Load History pattern)\n');

  const wf = await getWf(BRAIN_ID);
  const st = wf.nodes.find(n => n.name === 'Save Turn');
  if (!st) { console.log('❌ Save Turn not found'); process.exit(1); }

  console.log('Current query:', st.parameters.query);
  console.log('Current update (truncated):', String(st.parameters.update || '').slice(0, 60));

  // ── Check broken docs ─────────────────────────────────────────────────────
  const mc = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await mc.connect();
  const coll = mc.db('aaziko_organized').collection('az_chat_memory');
  const total = await coll.countDocuments({});
  const good  = await coll.countDocuments({ sessionKey: { $exists: true }, role: { $exists: true } });
  console.log('\naz_chat_memory total:', total, '| good (sessionKey+role):', good);

  if (!WRITE) { await mc.close(); console.log('\n(dry run — pass --write)'); return; }

  // Clear any broken docs
  if (total > good) {
    const del = await coll.deleteMany({
      $or: [{ sessionKey: { $exists: false } }, { role: { $exists: false } }]
    });
    console.log('Deleted', del.deletedCount, 'broken docs');
  }
  await mc.close();

  // ── Patch Save Turn ───────────────────────────────────────────────────────
  const bk = path.join(BACKUP_DIR, BRAIN_ID + '_before_save-turn-expr.json');
  fs.writeFileSync(bk, JSON.stringify(wf, null, 2), 'utf8');
  console.log('Backup:', bk);

  st.parameters = SAVE_TURN_PARAMS;

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
  const ok = live.parameters.operation === 'findOneAndUpdate'
          && live.parameters.query.startsWith('={{ JSON.stringify')
          && live.parameters.update.startsWith('={{ JSON.stringify')
          && live.parameters.upsert === true;

  console.log(ok ? '✅ Save Turn — pure expression query/update live' : '❌ VERIFY FAILED');
  console.log('  query:', live.parameters.query);
  console.log('  update:', live.parameters.update);
  if (!ok) process.exit(1);
  console.log('\n✅ Now send a test message and check MongoDB for full docs.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
