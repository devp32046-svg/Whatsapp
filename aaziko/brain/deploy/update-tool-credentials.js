'use strict';
/*
 * Update each Aaziko tool sub-workflow to use the correct per-DB credential.
 * Root cause: Ms2XatAbnJ799nGw has Database=wits, n8n ignores node databaseName override.
 * Fix: each tool now uses a credential whose Database field matches its actual DB.
 *
 * node aaziko/brain/deploy/update-tool-credentials.js          -- dry run
 * node aaziko/brain/deploy/update-tool-credentials.js --write  -- apply
 */
const path = require('path');
const fs   = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const WRITE = process.argv.includes('--write');

// Mapping: wf-id -> { mongoNodeName, newCredId, newCredName, expectedDb }
const TOOLS = [
  {
    name:        'find_buyers',
    wfId:        'WPAowCu3eKOHz4Yr',
    mongoNode:   'Find Buyers',
    credId:      '3lzVlfXxWT73tkXl',
    credName:    'Aaziko - Dhruval (buyers)',
    expectedDb:  'Dhruval',
  },
  {
    name:        'search_products',
    wfId:        'IdQQ66Ugw7eJIqax',
    mongoNode:   'Find Products',
    credId:      'g9NnHH7ocvb52kdM',
    credName:    'Aaziko Brain - indiamart (products)',
    expectedDb:  'indiamart',
  },
  {
    name:        'find_port',
    wfId:        '7EaCbHmYLnzpaLPn',
    mongoNode:   'Find Ports',
    credId:      'OXJ4UVacMY1qofx6',
    credName:    'Aaziko Brain - searates (ports)',
    expectedDb:  'searates-scraper',
  },
  {
    name:        'get_compliance',
    wfId:        '3qY2tab3Pnt6FmPD',
    mongoNode:   'Find Compliance',
    credId:      '9hyaSxc0saIzUgsX',
    credName:    'Aaziko Brain - organized (compliance)',
    expectedDb:  'aaziko_organized',
  },
  {
    name:        'lookup_hs_code',
    wfId:        'OqZH3AoC6yy8UIbz',
    mongoNode:   'Find HS',
    credId:      '9hyaSxc0saIzUgsX',
    credName:    'Aaziko Brain - organized (compliance)',
    expectedDb:  'aaziko_organized',
  },
];

const BACKUP_DIR = path.resolve(__dirname, '../../../backups');

(async () => {
  let pass = 0, fail = 0;

  for (const t of TOOLS) {
    try {
      const wf = await getWf(t.wfId);

      // Backup before change
      if (WRITE) {
        const bk = path.join(BACKUP_DIR, t.wfId + '_before_cred-update.json');
        fs.writeFileSync(bk, JSON.stringify(wf, null, 2), 'utf8');
      }

      const node = wf.nodes.find(n => n.name === t.mongoNode);
      if (!node) {
        console.log(`[SKIP] ${t.name}: node "${t.mongoNode}" not found`);
        continue;
      }

      const curCredId   = node.credentials && node.credentials.mongoDb && node.credentials.mongoDb.id;
      const curDb       = node.parameters.databaseName;
      const curCredName = node.credentials && node.credentials.mongoDb && node.credentials.mongoDb.name;

      console.log(`\n${t.name} (${t.wfId})`);
      console.log(`  node db    : ${curDb}`);
      console.log(`  current cred: ${curCredId} (${curCredName})`);
      console.log(`  → new cred  : ${t.credId} (${t.credName})`);

      if (curDb !== t.expectedDb) {
        console.log(`  ⚠️  databaseName mismatch: expected ${t.expectedDb}, got ${curDb}`);
      }

      if (!WRITE) continue;

      // Update credential on the node
      node.credentials = node.credentials || {};
      node.credentials.mongoDb = { id: t.credId, name: t.credName };

      const settings = Object.assign({}, wf.settings);
      delete settings.binaryMode;

      const r = await putWf(t.wfId, {
        name: wf.name, nodes: wf.nodes, connections: wf.connections, settings,
      });

      if (r.id) {
        await activate(t.wfId);
        // Read-back verify
        const check = await getWf(t.wfId);
        const cn    = check.nodes.find(n => n.name === t.mongoNode);
        const liveId = cn && cn.credentials && cn.credentials.mongoDb && cn.credentials.mongoDb.id;
        const ok = liveId === t.credId;
        console.log(ok ? `  ✅ LIVE (cred ${liveId})` : `  ❌ VERIFY FAILED (got ${liveId})`);
        if (ok) pass++; else fail++;
      } else {
        console.log(`  ❌ PUT failed: ${JSON.stringify(r).slice(0, 150)}`);
        fail++;
      }

    } catch (e) {
      console.log(`  ❌ ERROR ${t.name}: ${e.message}`);
      fail++;
    }
  }

  if (WRITE) {
    console.log(`\n=== ${pass} updated, ${fail} failed ===`);
  } else {
    console.log('\n(dry run — pass --write to apply)');
  }
})();
