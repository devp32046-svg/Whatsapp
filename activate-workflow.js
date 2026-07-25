// activate-workflow.js - Force activate the workflow
const https = require('https');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
const envText = fs.readFileSync(envPath, 'utf8');
const keyLine = envText.split(/\r?\n/).find(l => l.startsWith('N8N_API_KEY='));
if (!keyLine) {
  console.error('❌ N8N_API_KEY not found in .env');
  process.exit(1);
}
const API_KEY = keyLine.replace('N8N_API_KEY=', '').trim();

const API_HOST = 'ai.cgpe.in';
const WF_ID = 'T6JlzF4El2bSb2h3';

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
        } catch (_) {
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
  console.log('🔄 Activating workflow...\n');

  const { status, body } = await apiReq('POST', `/api/v1/workflows/${WF_ID}/activate`);

  if (status === 200) {
    console.log('✅ Workflow activated successfully!');
    console.log('   Active:', body.active);
    console.log('   Name:', body.name);
  } else {
    console.log('⚠️  Activation response:', status);
    console.log('   Body:', JSON.stringify(body, null, 2));
    
    if (status === 400) {
      console.log('\n❌ Cannot activate automatically - likely credential issue');
      console.log('\n📋 Manual activation required:');
      console.log('   1. Go to: https://ai.cgpe.in');
      console.log('   2. Open workflow: "CGPE — WhatsApp Gateway + AI Brain-2"');
      console.log('   3. Check "Gemini Brain Model" node credentials');
      console.log('   4. Select: "Gemini Brain (free)" from dropdown');
      console.log('   5. Save and toggle workflow ON');
    }
  }
})().catch(e => {
  console.error('❌ Error:', e.message);
});
