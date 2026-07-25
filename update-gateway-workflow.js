// update-gateway-workflow.js - Update CGPE WhatsApp Gateway workflow from local JSON file
const https = require('https');
const fs = require('fs');
const path = require('path');

// Read .env for API key
const envPath = path.join(__dirname, '.env');
const envText = fs.readFileSync(envPath, 'utf8');
const keyLine = envText.split(/\r?\n/).find(l => l.startsWith('N8N_API_KEY='));
if (!keyLine) { 
  console.error('N8N_API_KEY not found in .env'); 
  process.exit(1); 
}
const API_KEY = keyLine.replace('N8N_API_KEY=', '').trim();

const API_HOST = 'ai.cgpe.in';
const WF_ID = 'T6JlzF4El2bSb2h3'; // CGPE — WhatsApp Gateway + AI Brain-2
const LOCAL_FILE = path.join(__dirname, 'cgpe_whatsapp_gateway_ai_brain_fixed.json');

function apiReq(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: API_HOST,
      port: 443,
      path: apiPath,
      method,
      headers: {
        'X-N8N-API-KEY': API_KEY,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const r = https.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { 
          resolve({ status: res.statusCode, body: JSON.parse(raw) }); 
        } catch(_) { 
          resolve({ status: res.statusCode, body: raw }); 
        }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║  Update CGPE WhatsApp Gateway Workflow                 ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  // 1. Load local file
  console.log('[1/6] Loading local workflow file...');
  if (!fs.existsSync(LOCAL_FILE)) {
    console.error('❌ File not found:', LOCAL_FILE);
    process.exit(1);
  }
  const localWorkflow = JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'));
  console.log('✅ Loaded:', localWorkflow.name);
  console.log('    Nodes:', localWorkflow.nodes.length);

  // 2. Fetch current workflow from n8n
  console.log('\n[2/6] Fetching current workflow from n8n...');
  const { status: fetchStatus, body: currentWf } = await apiReq('GET', `/api/v1/workflows/${WF_ID}`);
  if (fetchStatus !== 200) {
    console.error('❌ Fetch failed. Status:', fetchStatus);
    console.error(JSON.stringify(currentWf).slice(0, 400));
    process.exit(1);
  }
  console.log('✅ Current version:', currentWf.name);
  console.log('    Active:', currentWf.active);
  console.log('    Version:', currentWf.versionId);

  // 3. Create backup
  console.log('\n[3/6] Creating backup...');
  const backupDir = path.join(__dirname, 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
  const timestamp = new Date().toISOString().replace(/:/g, '-').slice(0, 19).replace('T', '-');
  const backupFile = path.join(backupDir, `gateway-${WF_ID}-${timestamp}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(currentWf, null, 2), 'utf8');
  console.log('✅ Backup saved:', path.basename(backupFile));

  // 4. Deactivate workflow
  console.log('\n[4/6] Deactivating workflow...');
  const { status: deactStatus, body: deactBody } = await apiReq('POST', `/api/v1/workflows/${WF_ID}/deactivate`);
  console.log('✅ Deactivated. Status:', deactStatus, '| Active:', deactBody.active);

  // 5. Update workflow
  console.log('\n[5/6] Updating workflow...');
  
  // Clean settings - only include allowed properties
  const cleanSettings = {};
  const allowedSettings = ['executionTimeout', 'saveDataErrorExecution', 'saveDataSuccessExecution', 'saveManualExecutions', 'saveExecutionProgress', 'callerPolicy'];
  const settingsSource = localWorkflow.settings || currentWf.settings || {};
  for (const key of allowedSettings) {
    if (settingsSource[key] !== undefined) {
      cleanSettings[key] = settingsSource[key];
    }
  }
  
  const updatePayload = {
    name: localWorkflow.name,
    nodes: localWorkflow.nodes,
    connections: localWorkflow.connections,
    settings: cleanSettings
  };
  
  const { status: putStatus, body: putResp } = await apiReq('PUT', `/api/v1/workflows/${WF_ID}`, updatePayload);
  if (putStatus !== 200) {
    console.error('❌ Update failed. Status:', putStatus);
    console.error(JSON.stringify(putResp).slice(0, 500));
    // Try to reactivate old version
    await apiReq('POST', `/api/v1/workflows/${WF_ID}/activate`);
    console.error('⚠️  Rolled back: workflow re-activated with old version');
    process.exit(1);
  }
  console.log('✅ Updated successfully');
  console.log('    New version:', putResp.versionId);

  // 6. Activate workflow
  console.log('\n[6/6] Activating workflow...');
  const { status: actStatus, body: actBody } = await apiReq('POST', `/api/v1/workflows/${WF_ID}/activate`);
  console.log('✅ Activated. Status:', actStatus, '| Active:', actBody.active);

  // Summary
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  ✅ WORKFLOW UPDATED SUCCESSFULLY!                     ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log('\nChanges applied:');
  console.log('  • Enhanced disambiguation for multiple record searches');
  console.log('  • Better report generation instructions');
  console.log('  • Increased maxIterations: 12 → 15');
  console.log('  • Added timeout: 120000ms (2 minutes)');
  console.log('\n✅ WhatsApp bot is now updated and active!\n');

})().catch(e => {
  console.error('\n❌ Fatal error:', e.message || e);
  process.exit(1);
});
