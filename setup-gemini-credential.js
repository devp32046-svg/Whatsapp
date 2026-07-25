// setup-gemini-credential.js - Add Gemini API credential to n8n
const https = require('https');
const fs = require('fs');
const path = require('path');

// Read .env for API keys
const envPath = path.join(__dirname, '.env');
const envText = fs.readFileSync(envPath, 'utf8');

const getEnvValue = (key) => {
  const line = envText.split(/\r?\n/).find(l => l.startsWith(key + '='));
  return line ? line.replace(key + '=', '').trim() : null;
};

const N8N_API_KEY = getEnvValue('N8N_API_KEY');
const GEMINI_API_KEY = getEnvValue('GEMINI_API_KEY');

if (!N8N_API_KEY) {
  console.error('❌ N8N_API_KEY not found in .env');
  process.exit(1);
}

if (!GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY not found in .env');
  process.exit(1);
}

const API_HOST = 'ai.cgpe.in';

function apiReq(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: API_HOST,
      port: 443,
      path: apiPath,
      method,
      headers: {
        'X-N8N-API-KEY': N8N_API_KEY,
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
  console.log('║  Setup Gemini API Credential in n8n                    ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  // 1. Check if credential already exists
  console.log('[1/3] Checking existing credentials...');
  const { status: listStatus, body: creds } = await apiReq('GET', '/api/v1/credentials');
  
  if (listStatus !== 200) {
    console.error('❌ Failed to fetch credentials. Status:', listStatus);
    process.exit(1);
  }

  const geminiCred = creds.data?.find(c => 
    c.name?.includes('Gemini') || 
    c.name?.includes('Google') ||
    c.type?.includes('gemini') ||
    c.type?.includes('google')
  );

  if (geminiCred) {
    console.log('✅ Google/Gemini credential found:', geminiCred.name);
    console.log('    ID:', geminiCred.id);
    console.log('    Type:', geminiCred.type);
    console.log('\n📋 Available credentials:');
    creds.data?.slice(0, 10).forEach(c => {
      console.log(`    - ${c.name} (${c.type}) [${c.id}]`);
    });
    console.log('\n✅ Please update the workflow manually to use the correct credential ID.');
    process.exit(0);
  }

  console.log('⚠️  No Gemini credential found. Creating new one...');

  // 2. Create Gemini credential
  console.log('\n[2/3] Creating Gemini API credential...');
  
  const credentialPayload = {
    name: 'Google Gemini API',
    type: 'googleGeminiOAuth2Api',
    data: {
      apiKey: GEMINI_API_KEY
    }
  };

  const { status: createStatus, body: createResp } = await apiReq('POST', '/api/v1/credentials', credentialPayload);

  if (createStatus === 200 || createStatus === 201) {
    console.log('✅ Credential created successfully!');
    console.log('    ID:', createResp.id);
    console.log('    Name:', createResp.name);
  } else {
    console.error('❌ Failed to create credential. Status:', createStatus);
    console.error(JSON.stringify(createResp).slice(0, 500));
    console.log('\n⚠️  You may need to create the credential manually in n8n:');
    console.log('   1. Go to n8n → Settings → Credentials');
    console.log('   2. Add "Google Gemini" credential');
    console.log('   3. Paste your GEMINI_API_KEY from .env');
    process.exit(1);
  }

  // 3. Done
  console.log('\n[3/3] Setup complete!');
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  ✅ GEMINI CREDENTIAL READY!                           ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log('\nNext steps:');
  console.log('  1. Run: node update-gateway-workflow.js');
  console.log('  2. Activate the workflow in n8n if needed');
  console.log('  3. Test your WhatsApp bot\n');

})().catch(e => {
  console.error('\n❌ Fatal error:', e.message || e);
  console.log('\n⚠️  Manual setup required:');
  console.log('   1. Go to n8n web interface (https://ai.cgpe.in)');
  console.log('   2. Settings → Credentials → Add Credential');
  console.log('   3. Select "Google Gemini"');
  console.log('   4. Name it: "Google Gemini API"');
  console.log('   5. Paste API key from .env file');
  console.log('   6. Re-run: node update-gateway-workflow.js\n');
  process.exit(1);
});
