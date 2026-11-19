'use strict';
/* Fix compliance sub-workflow (3qY2tab3Pnt6FmPD):
 *   1. Find Compliance node: wrong collection + broken credential
 *      aaziko-import-export-1_organized (doesn't exist) → map_trade_remedies_organized
 *      Credential zBXfBQz06nehZiI4 (empty URI) → Hxh39r3Fnn77hr55 (working)
 *   2. Compliance Prep: wrong filter (source.org / domain) → real structure
 *      Uses applicability.product.code for HS, cty:XX for country
 *   3. Format Result: update to show actual fields (text, structured, direction)
 *
 * node aaziko/brain/deploy/fix-compliance-tool.js          -- dry run
 * node aaziko/brain/deploy/fix-compliance-tool.js --write  -- patch + activate
 */
const path = require('path'), fs = require('fs');
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');

const SEC_DIR = path.resolve(__dirname, '..', '..', '.secrets');
const ids = JSON.parse(fs.readFileSync(path.join(SEC_DIR, 'brain-n8n.json'), 'utf8'));
const WRITE = process.argv.includes('--write');
const WF_ID = ids.complianceWfId;

const REMINDERS_CRED = { id: 'Hxh39r3Fnn77hr55', name: 'Aaziko Reminders Mongo (aaziko_reminders ONLY)' };

// --- New Compliance Prep code ---
// Country name → ISO 2-letter code (cty:XX format used in map_trade_remedies_organized)
const NEW_PREP_CODE = `let inp = {};
try { inp = typeof $input.first().json === 'string' ? JSON.parse($input.first().json) : $input.first().json; } catch(e) {}
const hs = String(inp.hs_code || inp.hs || '').replace(/\\D/g, '').slice(0, 8);
const countryRaw = String(inp.country || '').trim();

if (!hs && !countryRaw) return [{ json: { _error: 'hs_code or country required' } }];

// Map common country names/abbreviations to ISO-2 codes (cty:XX format)
const COUNTRY_MAP = {
  'india':'IN', 'indian':'IN', 'ind':'IN',
  'uae':'AE', 'united arab emirates':'AE', 'emirates':'AE', 'dubai':'AE',
  'usa':'US', 'us':'US', 'united states':'US', 'america':'US', 'american':'US',
  'china':'CN', 'chinese':'CN', 'prc':'CN',
  'uk':'GB', 'united kingdom':'GB', 'britain':'GB', 'england':'GB',
  'germany':'DE', 'german':'DE',
  'france':'FR', 'french':'FR',
  'japan':'JP', 'japanese':'JP',
  'bangladesh':'BD',
  'sri lanka':'LK',
  'pakistan':'PK',
  'vietnam':'VN', 'viet nam':'VN',
  'turkey':'TR', 'turkiye':'TR',
  'brazil':'BR',
  'south korea':'KR', 'korea':'KR',
  'australia':'AU',
  'canada':'CA',
  'italy':'IT',
  'netherlands':'NL',
  'saudi arabia':'SA',
  'singapore':'SG',
  'thailand':'TH',
  'malaysia':'MY',
  'indonesia':'ID',
  'egypt':'EG',
  'kenya':'KE',
  'nigeria':'NG',
  'south africa':'ZA',
  'mexico':'MX',
  'spain':'ES',
  'belgium':'BE',
  'eu':'EU', 'european union':'EU', 'europe':'EU',
};

const countryKey = countryRaw.toLowerCase();
const isoCode = COUNTRY_MAP[countryKey] || null;

// Build filter — exclude absence_claim (no remedy exists)
const filter = { kind: 'trade_remedy' };

if (hs) {
  // Product codes include full HS (e.g. "09109905") and ancestors (["09", "0910", "091099"])
  // Match on code prefix OR in ancestors array
  filter['$or'] = [
    { 'applicability.product.code': { $regex: '^' + hs } },
    { 'applicability.product.ancestors': hs }
  ];
}

if (countryRaw) {
  const ctyCodes = isoCode ? ['cty:' + isoCode] : [];
  // Fallback: search by name pattern if no ISO mapping found
  const countryFilter = ctyCodes.length
    ? { $or: [
        { 'applicability.reporter': { $in: ctyCodes } },
        { 'applicability.partner_keys': { $in: ctyCodes } }
      ]}
    : { $or: [
        { 'applicability.reporter': { $regex: countryRaw, $options: 'i' } },
        { 'applicability.partner_keys': { $regex: countryRaw, $options: 'i' } }
      ]};

  if (filter['$or']) {
    // Already has HS $or — wrap both in $and
    filter['$and'] = [
      { '$or': filter['$or'] },
      countryFilter
    ];
    delete filter['$or'];
  } else {
    Object.assign(filter, countryFilter);
  }
}

return [{ json: { hs, country: isoCode || countryRaw, matchQuery: JSON.stringify(filter) } }];
`;

// --- New Format Result code ---
const NEW_FORMAT_CODE = `const data = $input.first().json;
const prep = $('Compliance Prep').first().json;
const rows = data.rows || [];

if (prep._error) return [{ json: { ok: false, error: prep._error } }];
if (!rows.length) {
  const noData = 'No active trade remedies found for HS ' + (prep.hs || '?') +
    (prep.country ? ' involving ' + prep.country : '');
  return [{ json: { ok: false, error: noData } }];
}

const lines = rows.slice(0, 5).map(r => {
  const st = r.structured || {};
  const ap = r.applicability || {};
  const reporter = (ap.reporter || '').replace('cty:', '');
  const partners = (ap.partner_keys || []).map(k => k.replace('cty:', '')).join(', ');
  const direction = ap.direction || '';
  const duty = st.companies && st.companies[0] ? st.companies[0].Duty || '' : '';
  const period = (st.start_raw && st.end_raw) ? ' (' + st.start_raw + ' – ' + st.end_raw + ')' : '';
  const status = r.status === 'expired' ? ' [EXPIRED]' : '';

  return '• ' + (st.remedy_type || r.kind) + status +
    '\\n  Product: ' + (st.ntlc_description || ap.product && ap.product.code || '?') +
    '\\n  ' + direction.toUpperCase() + ': ' + reporter + (partners ? ' ← ' + partners : '') +
    (duty ? '\\n  Rate: ' + duty : '') + period;
});

const summary = 'Trade remedies for HS ' + (prep.hs || '?') +
  (prep.country ? ' (' + prep.country + ')' : '') +
  ' — ' + rows.length + ' found:\\n' + lines.join('\\n');

return [{ json: { ok: true, summary, rowCount: rows.length } }];
`;

(async () => {
  const wf = await getWf(WF_ID);

  const prepIdx = wf.nodes.findIndex(n => n.name === 'Compliance Prep');
  const findIdx = wf.nodes.findIndex(n => n.name === 'Find Compliance');
  const fmtIdx  = wf.nodes.findIndex(n => n.name === 'Format Result');

  if (prepIdx === -1) { console.error('Compliance Prep not found'); process.exit(1); }
  if (findIdx === -1) { console.error('Find Compliance not found'); process.exit(1); }
  if (fmtIdx  === -1) { console.error('Format Result not found'); process.exit(1); }

  const findNode = wf.nodes[findIdx];
  console.log('=== BEFORE ===');
  console.log('Find Compliance — collection:', findNode.parameters.collection);
  console.log('Find Compliance — cred:', JSON.stringify(findNode.credentials?.mongoDb));
  console.log('Nodes total:', wf.nodes.length);

  if (!WRITE) {
    console.log('\n=== WOULD FIX ===');
    console.log('Find Compliance: collection aaziko-import-export-1_organized → map_trade_remedies_organized');
    console.log('Find Compliance: cred zBXfBQz06nehZiI4 (broken) → Hxh39r3Fnn77hr55 (working)');
    console.log('Compliance Prep: rewrite — real HS/country filter against actual schema');
    console.log('Format Result: rewrite — show remedy type, duty rate, direction, period');
    console.log('\n(dry run — pass --write to apply)');
    return;
  }

  const backupDir = path.resolve(__dirname, '..', '..', '..', 'backups');
  fs.writeFileSync(path.join(backupDir, WF_ID + '_before_fix_compliance.json'), JSON.stringify(wf, null, 2));
  console.log('Backup saved');

  // Fix 1: Compliance Prep code
  wf.nodes[prepIdx].parameters.jsCode = NEW_PREP_CODE;

  // Fix 2: Find Compliance — collection + credential
  wf.nodes[findIdx].parameters.collection = 'map_trade_remedies_organized';
  wf.nodes[findIdx].credentials = { mongoDb: REMINDERS_CRED };

  // Fix 3: Format Result code
  wf.nodes[fmtIdx].parameters.jsCode = NEW_FORMAT_CODE;

  await putWf(WF_ID, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings });
  await activate(WF_ID);

  const live = await getWf(WF_ID);
  const lFind = live.nodes.find(n => n.name === 'Find Compliance');

  console.log('\n=== LIVE ===');
  console.log('Find Compliance — collection:', lFind.parameters.collection);
  console.log('Find Compliance — cred:', JSON.stringify(lFind.credentials?.mongoDb));
  console.log('Active:', live.active, '| nodes:', live.nodes.length);

  if (lFind.parameters.collection === 'map_trade_remedies_organized' &&
      lFind.credentials?.mongoDb?.id === REMINDERS_CRED.id) {
    console.log('\n✅ Compliance tool fixed');
  } else {
    console.error('\n❌ Verification failed');
    process.exit(1);
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
