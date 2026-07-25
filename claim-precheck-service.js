'use strict';
/**
 * Claim pre-check service - the HTTP wrapper the n8n gateway calls.
 *
 * Meta posts WhatsApp messages to n8n, not to server.js, so this feature cannot live inside
 * server.js's /webhook/meta (that route never fires in production). n8n asks this service about
 * every inbound message; the service answers {handled:false} for anything that is not part of a
 * pre-check conversation, and n8n then carries on to the normal bot exactly as before.
 *
 *   npm install express mongodb @google/generative-ai
 *   node claim-precheck-service.js          (reads .env)
 *
 * POST /precheck  { phoneLast10, role, text, mediaId, mimeType, fileName, token, graphVersion }
 *   -> { handled: false }
 *   -> { handled: true, reply: "...", buttons: ["...", ...] }
 */
require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');

const flow = require('./src/services/claim-precheck-flow');
const ClaimOCRProcessor = require('./src/services/sarvam-ocr');

const PORT = Number(process.env.PRECHECK_PORT || 3200);
const GRAPH = process.env.GRAPH_VERSION || 'v20.0';
// the claims key exists to keep this traffic off the main bot's Gemini quota
const GEMINI_KEY = process.env.GEMINI_API_KEY_CLAIMS || process.env.GEMINI_API_KEY;

const app = express();
app.use(express.json({ limit: '2mb' }));

let mongo = null;
async function sessions() {
  if (!mongo) {
    mongo = new MongoClient(process.env.MONGODB_URI);
    await mongo.connect();
  }
  return mongo.db().collection(flow.COLLECTION);
}

// gemini-flash-latest resolves to a model whose FREE tier allows only ~20 requests a day - the
// 51 MB Komal file died on a 429 during the end-to-end run. The live n8n claim flow already
// moved to flash-lite for the same reason; the pre-check is the heaviest user of all, so it
// defaults there too. Override with PRECHECK_GEMINI_MODEL if a paid key is ever used.
const PRECHECK_MODEL = process.env.PRECHECK_GEMINI_MODEL || 'gemini-flash-lite-latest';
process.env.GEMINI_MODEL = PRECHECK_MODEL;
const ocr = new ClaimOCRProcessor(GEMINI_KEY);
console.log('[precheck] gemini model:', PRECHECK_MODEL);

/**
 * The role is resolved here rather than trusted from the caller, so the gateway needs only one
 * insertion point instead of having to sit after its admin/team lookups.
 *
 * Membership decides it, NOT the role string: team_members holds roles like ops, sales,
 * recruitment, associate and "driver/commute-work", so matching role names would have refused
 * most of the actual team. Being in the collection is what "admin and team" means.
 */
async function resolveRole(phoneLast10, hint) {
  await sessions();
  const db = mongo.db();
  const last10 = String(phoneLast10 || '').slice(-10);
  if (!last10) { return 'client'; }
  const byPhone = { $or: [{ phoneLast10: last10 }, { phone: { $regex: last10 + '$' } },
                          { phoneNumber: { $regex: last10 + '$' } }, { mobile: { $regex: last10 + '$' } }] };
  if (await db.collection('admins').findOne(byPhone)) { return 'admin'; }
  if (await db.collection('team_members').findOne(byPhone)) { return 'team'; }
  return hint || 'client';   // the caller's hint only ever downgrades to whatever it claimed
}

/**
 * Meta never sends the media bytes, only an id, so it takes two calls: id -> url, url -> bytes.
 * Both need the bearer token. Mirrors pdf-prep-service.js rather than server.js, whose
 * META_API_URL points at graph.instagram.com.
 */
async function downloadWhatsAppMedia(media, token, graphVersion) {
  const v = graphVersion || GRAPH;
  const auth = { Authorization: 'Bearer ' + (token || process.env.META_ACCESS_TOKEN) };

  const metaRes = await fetch('https://graph.facebook.com/' + v + '/' + media.mediaId, { headers: auth });
  if (!metaRes.ok) { throw new Error('media lookup failed: ' + metaRes.status + ' ' + (await metaRes.text()).slice(0, 200)); }
  const meta = await metaRes.json();
  if (!meta.url) { throw new Error('no media url returned'); }

  const binRes = await fetch(meta.url, { headers: auth });
  if (!binRes.ok) { throw new Error('media download failed: ' + binRes.status); }
  const buffer = Buffer.from(await binRes.arrayBuffer());
  return { buffer: buffer, mimeType: meta.mime_type || media.mimeType || 'application/octet-stream' };
}

app.get('/health', (_req, res) => res.json({
  ok: true, service: 'claim-precheck', hasKey: !!GEMINI_KEY, hasMongo: !!process.env.MONGODB_URI
}));

app.post('/precheck', async (req, res) => {
  const b = req.body || {};
  const started = Date.now();
  try {
    const media = b.mediaId
      ? { mediaId: String(b.mediaId), mimeType: b.mimeType || '', fileName: b.fileName || '' }
      : null;

    const role = await resolveRole(b.phoneLast10, b.role);
    const result = await flow.handleClaimPrecheckFlow(
      { phoneLast10: b.phoneLast10, role: role, text: b.text, media: media },
      {
        sessions: await sessions(),
        // terms remembered per policy, so a repeat claim asks nothing
        profiles: (await sessions()) && mongo.db().collection('claim_policy_profiles'),
        downloadMedia: m => downloadWhatsAppMedia(m, b.token, b.graphVersion),
        extractStructured: (buf, mime) => ocr.extractStructuredClaim(buf, mime)
      }
    );

    if (!result) { return res.json({ handled: false, role: role }); }

    // The pre-check branch short-circuits before the gateway's Log Conversation node, so nothing
    // it says was being recorded anywhere. Same collection and shape as the normal bot, with a
    // source marker; failing to log must never cost the user their reply.
    try {
      await mongo.db().collection('wa_messages').insertOne({
        phoneLast10: String(b.phoneLast10 || '').slice(-10),
        senderPhone: b.senderPhone || '',
        role: role,
        inbound: media ? ('[attachment: ' + (b.fileName || b.mimeType || 'document') + ']') : String(b.text || ''),
        replyText: String(result.reply || ''),
        direction: 'in-out',
        channel: 'meta',
        source: 'claim_precheck',
        step: result.step || '',
        isVoice: false,
        ts: new Date().toISOString()
      });
    } catch (e) { console.error('[precheck] log failed:', e.message); }

    console.log('[precheck] ' + b.phoneLast10 + ' step=' + (result.step || '-') +
      ' ' + (Date.now() - started) + 'ms');
    return res.json({
      handled: true, role: role,
      reply: result.reply,
      buttons: result.buttons || [],
      step: result.step || ''
    });
  } catch (e) {
    // Never break the bot over this feature: on any failure the message falls through to n8n.
    console.error('[precheck] error:', e.message);
    return res.json({ handled: false, error: e.message });
  }
});

app.listen(PORT, () => console.log('claim-precheck listening on http://127.0.0.1:' + PORT));
