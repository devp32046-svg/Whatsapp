'use strict';
/*
 * Fix Save Turn: switch from `update` (doesn't map item fields) to
 * `findOneAndUpdate` with explicit $set expressions.
 *
 * Both `insert` and `update` operations in n8n mongoDb typeVersion 1
 * fail to write all item fields — only partial data ends up in MongoDB.
 *
 * `findOneAndUpdate` with an explicit $set lets us control exactly which
 * fields get written via n8n expression syntax inside the JSON strings.
 *
 * Also clears the residual broken docs from previous fix attempts.
 *
 * node aaziko/brain/deploy/fix-save-turn-findoneandupdate.js          -- dry run
 * node aaziko/brain/deploy/fix-save-turn-findoneandupdate.js --write  -- apply
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

// findOneAndUpdate with explicit $set expressions:
// - query: match by ts (unique per turn)
// - update: $set all fields explicitly using n8n expression syntax
// - upsert: true → create if not found
const SAVE_TURN_PARAMS = {
  operation: 'findOneAndUpdate',
  collection: 'az_chat_memory',
  query: '{"ts": "={{ $json.ts }}"}',
  update: '{"$set": {"sessionKey": "={{ $json.sessionKey }}", "role": "={{ $json.role }}", "content": "={{ $json.content }}", "ts": "={{ $json.ts }}"}}',
  upsert: true
};

(async () => {
  require('dotenv').config();
  console.log('=== Fix: Save Turn → findOneAndUpdate ===');
  console.log('Problem: mongoDb insert/update both fail to write all item fields');
  console.log('Fix: findOneAndUpdate + explicit $set expressions per field\n');

  const wf = await getWf(BRAIN_ID);
  const st = wf.nodes.find(n => n.name === 'Save Turn');
  if (!st) { console.log('❌ Save Turn not found'); process.exit(1); }

  console.log('Current operation:', st.parameters.operation);
  console.log('Credential:', st.credentials && st.credentials.mongoDb && st.credentials.mongoDb.name);

  // ── Check broken docs in MongoDB ─────────────────────────────────────────
  const mc = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await mc.connect();
  const coll = mc.db('aaziko_organized').collection('az_chat_memory');

  const total = await coll.countDocuments({});
  const good  = await coll.countDocuments({ sessionKey: { $exists: true }, role: { $exists: true } });
  const broken = total - good;
  console.log('\naz_chat_memory total:', total, '| good (has sessionKey+role):', good, '| broken:', broken);

  if (!WRITE) {
    await mc.close();
    console.log('\n(dry run — pass --write to apply)');
    return;
  }

  // ── 1. Delete broken docs (no sessionKey OR no role) ─────────────────────
  if (broken > 0) {
    const del = await coll.deleteMany({
      $or: [{ sessionKey: { $exists: false } }, { role: { $exists: false } }]
    });
    console.log('Deleted', del.deletedCount, 'broken docs');
  }
  await mc.close();

  // ── 2. Patch Save Turn node ───────────────────────────────────────────────
  const bk = path.join(BACKUP_DIR, BRAIN_ID + '_before_save-turn-findoneandupdate.json');
  fs.writeFileSync(bk, JSON.stringify(wf, null, 2), 'utf8');
  console.log('Backup:', bk);

  st.parameters = SAVE_TURN_PARAMS;
  // keep existing credential (already set correctly to 9hyaSxc0saIzUgsX)

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
          && live.parameters.upsert === true
          && live.parameters.query.includes('$json.ts')
          && live.parameters.update.includes('sessionKey')
          && live.parameters.update.includes('role')
          && live.parameters.update.includes('content');

  console.log(ok ? '✅ Save Turn → findOneAndUpdate + $set live' : '❌ VERIFY FAILED');
  console.log('  operation:', live.parameters.operation);
  console.log('  query:', live.parameters.query);
  console.log('  update (truncated):', String(live.parameters.update).slice(0, 80));
  console.log('  upsert:', live.parameters.upsert);

  if (!ok) process.exit(1);
  console.log('\n✅ Fix applied. Send a test message and check az_chat_memory for full docs.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
