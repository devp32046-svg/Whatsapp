'use strict';
/* Deploy Aaziko Brain Gateway workflow
 *   node aaziko/brain/deploy/build-brain.js          -- dry-run
 *   node aaziko/brain/deploy/build-brain.js --write  -- create + activate
 *
 * This creates the main Aaziko — WhatsApp Gateway + AI Brain workflow.
 * Webhook at: POST /webhook/aaziko-brain   (and UI: /webhook/aaziko-brain-ui)
 * Nodes:
 *   Webhook Trigger → Normalize Message → Auth Gate → Load Config →
 *   Build Context → Aaziko AI Brain (agent + 4 toolWorkflow nodes) →
 *   Parse Reply → Is UI? → Respond UI
 */
const path = require('path'), fs = require('fs');
const { req, activate, RROOT } = require('../../../scripts/lib/n8n-req');
const NC = require('../lib/node-code');

const SEC_DIR  = path.resolve(__dirname, '..', '..', '.secrets');
const IDS_FILE = path.join(SEC_DIR, 'brain-n8n.json');
const ENV_FILE = path.join(SEC_DIR, 'brain.env');

const WRITE = process.argv.includes('--write');

// Load brain.env for BRAIN_CHAT_SECRET
function loadBrainEnv() {
  const env = {};
  try { fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).forEach(l => { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2]; }); } catch (e) {}
  return env;
}

// Tool workflow IDs
function loadIds() {
  return JSON.parse(fs.readFileSync(IDS_FILE, 'utf8'));
}

// ── uuid helper ───────────────────────────────────────────────────────────────
let _uid = 0;
const uid = () => 'az-br-' + (++_uid).toString(36) + '-' + Math.random().toString(36).slice(2, 8);

// ── Credentials ───────────────────────────────────────────────────────────────
const CRED_MONGO_SEARCH = 'BBaiP3Y5ede0zxY6';  // aaziko_search (config + chat memory)

// ── Build Brain Gateway workflow ──────────────────────────────────────────────
function buildBrainWf(ids, secret) {
  const nodes = [
    // 1. Webhook trigger — UI channel (GET for keep-alive + POST for chat)
    {
      id: uid(), name: 'Webhook Trigger',
      type: 'n8n-nodes-base.webhook', typeVersion: 2,
      position: [100, 300],
      parameters: {
        path: 'aaziko-brain-ui',
        httpMethod: 'POST',
        responseMode: 'responseNode',
        options: {}
      },
      webhookId: 'aaziko-brain-ui'
    },

    // 2. Normalize Message
    {
      id: uid(), name: 'Normalize Message',
      type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [320, 300],
      parameters: { jsCode: NC.NORMALIZE_MSG }
    },

    // 3. Auth Gate
    {
      id: uid(), name: 'Auth Gate',
      type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [540, 300],
      parameters: { jsCode: NC.buildAuthGate(secret) }
    },

    // 4. Skip Check — if _skip, respond 200 and stop
    {
      id: uid(), name: 'Skip Check',
      type: 'n8n-nodes-base.if', typeVersion: 2,
      position: [760, 300],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 1 },
          conditions: [{
            leftValue: '={{ !!$json._skip }}',
            operator: { type: 'boolean', operation: 'true', singleValue: true },
            rightValue: ''
          }],
          combinator: 'and'
        }
      }
    },

    // 5a. Skip Response (true branch of Skip Check)
    {
      id: uid(), name: 'Skip Response',
      type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1,
      position: [980, 180],
      parameters: {
        respondWith: 'json',
        responseBody: '={{ JSON.stringify({ ok: false, reason: $json.reason || "skipped" }) }}',
        options: { responseCode: 200 }
      }
    },

    // 5b. Load Config (false branch of Skip Check → continue)
    {
      id: uid(), name: 'Load Config',
      type: 'n8n-nodes-base.mongoDb', typeVersion: 1.3,
      position: [980, 420],
      parameters: {
        operation: 'findOne',
        collection: 'bot_config',
        query: '{"botId":"aaziko_brain_v1"}'
      },
      credentials: { mongoDb: { id: CRED_MONGO_SEARCH, name: 'Aaziko Brain - aaziko_search (config)' } }
    },

    // 6. Build Context
    {
      id: uid(), name: 'Build Context',
      type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [1200, 420],
      parameters: { jsCode: NC.BUILD_CONTEXT }
    },

    // 7. Aaziko AI Brain — the agent node
    {
      id: uid(), name: 'Aaziko AI Brain',
      type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 1.7,
      position: [1420, 420],
      parameters: {
        promptType: 'define',
        text: '={{ $json.chatInput }}',
        systemMessage: '={{ $json.systemPrompt }}',
        options: {
          returnIntermediateSteps: true,
          sessionIdType: 'customKey',
          sessionKey: '={{ $json.sessionKey }}',
          contextWindowLength: 6
        }
      }
    },

    // 7a. Memory node — credential required (mongoDb type), no inline connectionString
    {
      id: uid(), name: 'Chat Memory',
      type: '@n8n/n8n-nodes-langchain.memoryMongoDbChat', typeVersion: 1.0,
      position: [1420, 620],
      parameters: {
        collectionName: 'az_chat_memory',
        sessionKey: '={{ $("Build Context").first().json.sessionKey }}'
      },
      credentials: { mongoDb: { id: CRED_MONGO_SEARCH, name: 'Aaziko Brain - aaziko_search (config+logs)' } }
    },

    // 7b. LLM node (connected to brain) — uses CGPE's existing Gemini credential (approved for Aaziko)
    {
      id: uid(), name: 'Gemini Flash',
      type: '@n8n/n8n-nodes-langchain.lmChatGoogleGemini', typeVersion: 1,
      position: [1200, 620],
      parameters: {
        modelName: 'gemini-2.0-flash-exp',
        options: { maxOutputTokens: 1024, temperature: 0.3 }
      },
      credentials: { googlePalmApi: { id: 'z1yT4WXRANdfPHjQ', name: 'Gemini Brain (rot1)' } }
    },

    // 7c-7f. Tool sub-workflows (connected to brain as ai_tool)
    {
      id: uid(), name: 'Tool: search_tariff',
      type: '@n8n/n8n-nodes-langchain.toolWorkflow', typeVersion: 1.2,
      position: [1420, 800],
      parameters: {
        name: 'search_tariff',
        description: 'Search import/export tariff rates by HS code and optionally country. Returns duty rates from WITS database.',
        workflowId: ids.tariffWfId,
        fields: {
          values: [
            { name: 'hs_code', value: '={{ /*n8n-auto-generated-fromAI-override*/ $fromAI("hs_code", "6-digit HS code", "string") }}' },
            { name: 'country', value: '={{ /*n8n-auto-generated-fromAI-override*/ $fromAI("country", "Country name (optional)", "string") }}' }
          ]
        }
      }
    },
    {
      id: uid(), name: 'Tool: search_products',
      type: '@n8n/n8n-nodes-langchain.toolWorkflow', typeVersion: 1.2,
      position: [1620, 800],
      parameters: {
        name: 'search_products',
        description: 'Search for products and suppliers by keyword. Returns product names, company names, and locations.',
        workflowId: ids.productWfId,
        fields: {
          values: [
            { name: 'keyword', value: '={{ /*n8n-auto-generated-fromAI-override*/ $fromAI("keyword", "Product name or keyword to search", "string") }}' }
          ]
        }
      }
    },
    {
      id: uid(), name: 'Tool: find_port',
      type: '@n8n/n8n-nodes-langchain.toolWorkflow', typeVersion: 1.2,
      position: [1820, 800],
      parameters: {
        name: 'find_port',
        description: 'Find port information by port name or country. Returns coordinates and facilities.',
        workflowId: ids.portWfId,
        fields: {
          values: [
            { name: 'port_name', value: '={{ /*n8n-auto-generated-fromAI-override*/ $fromAI("port_name", "Port name (e.g. Mumbai)", "string") }}' },
            { name: 'country', value: '={{ /*n8n-auto-generated-fromAI-override*/ $fromAI("country", "Country name (optional)", "string") }}' }
          ]
        }
      }
    },
    {
      id: uid(), name: 'Tool: get_compliance',
      type: '@n8n/n8n-nodes-langchain.toolWorkflow', typeVersion: 1.2,
      position: [2020, 800],
      parameters: {
        name: 'get_compliance',
        description: 'Get import/export compliance requirements by HS code and country.',
        workflowId: ids.complianceWfId,
        fields: {
          values: [
            { name: 'hs_code', value: '={{ /*n8n-auto-generated-fromAI-override*/ $fromAI("hs_code", "HS code (4-6 digits)", "string") }}' },
            { name: 'country', value: '={{ /*n8n-auto-generated-fromAI-override*/ $fromAI("country", "Country name", "string") }}' }
          ]
        }
      }
    },

    // 8. Parse Reply
    {
      id: uid(), name: 'Parse Reply',
      type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [1640, 420],
      parameters: { jsCode: NC.PARSE_REPLY }
    },

    // 9. Respond UI
    {
      id: uid(), name: 'Respond UI',
      type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1,
      position: [1860, 420],
      parameters: {
        respondWith: 'json',
        responseBody: '={{ JSON.stringify({ ok: true, reply: String($json.replyText || ""), buttons: $json.uiButtons || [] }) }}',
        options: { responseCode: 200 }
      }
    }
  ];

  // Build node name → id map for connections
  const nid = {};
  nodes.forEach(n => { nid[n.name] = n.name; });

  const connections = {
    'Webhook Trigger': { main: [[{ node: 'Normalize Message', type: 'main', index: 0 }]] },
    'Normalize Message': { main: [[{ node: 'Auth Gate', type: 'main', index: 0 }]] },
    'Auth Gate': { main: [[{ node: 'Skip Check', type: 'main', index: 0 }]] },
    'Skip Check': {
      main: [
        [{ node: 'Skip Response', type: 'main', index: 0 }],  // true: skip
        [{ node: 'Load Config', type: 'main', index: 0 }]     // false: continue
      ]
    },
    'Load Config': { main: [[{ node: 'Build Context', type: 'main', index: 0 }]] },
    'Build Context': { main: [[{ node: 'Aaziko AI Brain', type: 'main', index: 0 }]] },
    'Aaziko AI Brain': { main: [[{ node: 'Parse Reply', type: 'main', index: 0 }]] },
    'Parse Reply': { main: [[{ node: 'Respond UI', type: 'main', index: 0 }]] },

    // AI sub-nodes connect to brain via ai_* ports
    'Gemini Flash': { ai_languageModel: [[{ node: 'Aaziko AI Brain', type: 'ai_languageModel', index: 0 }]] },
    'Chat Memory': { ai_memory: [[{ node: 'Aaziko AI Brain', type: 'ai_memory', index: 0 }]] },
    'Tool: search_tariff': { ai_tool: [[{ node: 'Aaziko AI Brain', type: 'ai_tool', index: 0 }]] },
    'Tool: search_products': { ai_tool: [[{ node: 'Aaziko AI Brain', type: 'ai_tool', index: 1 }]] },
    'Tool: find_port': { ai_tool: [[{ node: 'Aaziko AI Brain', type: 'ai_tool', index: 2 }]] },
    'Tool: get_compliance': { ai_tool: [[{ node: 'Aaziko AI Brain', type: 'ai_tool', index: 3 }]] }
  };

  return {
    name: 'Aaziko — WhatsApp Gateway + AI Brain',
    nodes,
    connections,
    settings: { saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all' }
  };
}

// ── deploy ────────────────────────────────────────────────────────────────────
async function deploy(wf) {
  const r = await req('POST', '/api/v1/workflows', wf);
  if (r.status !== 200) {
    console.error('POST body:', r.body.slice(0, 500));
    throw new Error('POST failed: ' + r.status);
  }
  const created = JSON.parse(r.body);
  const id = created.id;
  await activate(id);
  const rb = await req('GET', '/api/v1/workflows/' + id);
  const live = JSON.parse(rb.body);
  return { id, active: live.active, nodeCount: live.nodes.length, name: live.name };
}

(async () => {
  const env = loadBrainEnv();
  const ids  = loadIds();
  const secret = env.BRAIN_CHAT_SECRET;
  if (!secret) throw new Error('BRAIN_CHAT_SECRET not set in brain.env');
  if (!ids.tariffWfId || !ids.productWfId || !ids.portWfId || !ids.complianceWfId) {
    throw new Error('All 4 tool workflow IDs must be set before building Brain. Missing: ' +
      ['tariffWfId','productWfId','portWfId','complianceWfId'].filter(k => !ids[k]).join(', '));
  }

  const wf = buildBrainWf(ids, secret);
  console.log('Brain workflow nodes:', wf.nodes.map(n => n.name + ' [' + n.type.split('.').pop() + ']'));

  if (!WRITE) {
    console.log('\nDry-run. Pass --write to deploy.');
    return;
  }

  console.log('\nDeploying Aaziko Brain Gateway...');
  const result = await deploy(wf);
  console.log('  ID:', result.id, '| active:', result.active, '| nodes:', result.nodeCount, '| name:', result.name);

  // Persist brain ID
  ids.brainWfId = result.id;
  fs.writeFileSync(IDS_FILE, JSON.stringify(ids, null, 2) + '\n', 'utf8');
  console.log('\nbrainWfId written to brain-n8n.json:', result.id);

  if (!result.active) { console.error('Brain NOT active!'); process.exit(1); }

  // Print the UI webhook URL
  console.log('\nUI webhook URL:');
  console.log('  POST https://ai.cgpe.in/webhook/aaziko-brain-ui');
  console.log('  Body: { "message": "...", "sessionId": "test1", "channel": "ui", "secret": "' + secret + '" }');
  console.log('\nBrain deployed and active.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
