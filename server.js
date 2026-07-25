const express = require('express');
const path = require("path");
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');
require('dotenv').config();

// Lazy, cached MongoDB connection. Same DB the n8n workflows use — lets the UI read
// `ui_inbox` (pushed reminders/notifications) and `team_members` (the live team roster).
let _mongoClientPromise = null;
function getCollection(name) {
    if (!process.env.MONGODB_URI) return null;
    if (!_mongoClientPromise) {
        _mongoClientPromise = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 3 }).connect();
    }
    return _mongoClientPromise.then((client) =>
        client.db(process.env.MONGO_DB || undefined).collection(name)
    );
}

const app = express();
const PORT = process.env.PORT || 8081;

// Increase payload limit for media uploads (base64 audio/images)
app.use(express.json({ limit: '50mb' }));

// Route to serve the user's uploaded test audio
app.get('/api/test-audio', (req, res) => {
    try {
        const fs = require('fs');
        const path = require('path');
        let audioPath = path.join(__dirname, 'uploaded_test_audio.webm');
        if (!fs.existsSync(audioPath)) {
            audioPath = 'C:\\Users\\Inet\\.gemini\\antigravity-ide\\brain\\10b26fce-1a02-479a-a901-d5a848454722\\uploaded_media_1783073955556.img';
        }
        const buffer = fs.readFileSync(audioPath);
        res.setHeader('Content-Type', 'audio/webm');
        res.send(buffer);
    } catch (e) {
        console.error('[Audio Test] Error:', e.message);
        res.status(500).send("Error reading test file: " + e.message);
    }
});

app.use(express.static(path.join(__dirname, 'src', 'public')));

// CGPE n8n Webhook URL
const CGPE_CHAT_URL = "https://ai.cgpe.in/webhook/cgpe-chat";

// Meta Cloud API Configuration
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_WEBHOOK_VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || 'cgpe_webhook_secret_2026';
const META_API_URL = `https://graph.instagram.com/v18.0/${META_PHONE_NUMBER_ID}`;
const ALLOWED_PHONES = (process.env.META_ALLOWED_PHONES || '9601775061,9106988376').split(',').map(p => p.trim());

function normalizeLast10(phone) {
    return String(phone || '').replace(/\D/g, '').slice(-10);
}

async function sendWhatsAppMessage(toPhone, text, buttons = []) {
    try {
        const payload = {
            messaging_product: "whatsapp",
            to: String(toPhone).replace(/\D/g, ''),
            type: "text",
            text: { body: text }
        };

        // If buttons provided, use interactive message
        if (buttons.length > 0) {
            payload.type = "interactive";
            payload.interactive = {
                type: "button",
                body: { text },
                action: {
                    buttons: buttons.map((btn, idx) => ({
                        type: "reply",
                        reply: {
                            id: `btn_${idx}`,
                            title: btn.substring(0, 20)
                        }
                    }))
                }
            };
        }

        const response = await axios.post(`${META_API_URL}/messages`, payload, {
            headers: {
                'Authorization': `Bearer ${META_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });

        console.log(`[Meta] Message sent to ${toPhone}:`, response.data.messages?.[0]?.id);
        return { success: true, messageId: response.data.messages?.[0]?.id };
    } catch (error) {
        console.error(`[Meta] Failed to send to ${toPhone}:`, error.response?.data || error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Upload endpoint — receives base64 media from frontend,
 * uploads to temporary file hosting, returns a public URL
 * that the CGPE webhook can download.
 */
/**
 * Builds a Cloudinary public_id so uploads are easy to find later:
 *   <phoneLast10>/<YYYY-MM-DD_HH-mm-ss>_<rand>
 * Combined with the `cgpe-audio` folder this gives one sub-folder per client,
 * with timestamped, unique, sortable filenames.
 */
function buildPublicId(phone) {
    const last10 = String(phone || '').replace(/\D/g, '').slice(-10);
    const stamp = new Date()
        .toISOString()
        .replace('T', '_')
        .replace(/:/g, '-')
        .slice(0, 19); // 2026-07-13_14-35-02
    const rand = Math.random().toString(36).slice(2, 6);
    const base = `${stamp}_${rand}`;
    return last10 ? `${last10}/${base}` : base;
}

app.post('/api/upload', async (req, res) => {
    try {
        const { base64Data, mimeType, filename, phone, name } = req.body;

        if (!base64Data) {
            return res.status(400).json({ success: false, error: 'No file data provided' });
        }

            // Strip data URL prefix if present (e.g. "data:audio/webm;codecs=opus;base64,...")
            const cleanBase64 = base64Data.replace(/^data:[^;]+;?[^,]*,/, '');
        const buffer = Buffer.from(cleanBase64, 'base64');

        console.log(`[Upload] Uploading ${filename || 'file'} (${(buffer.length / 1024).toFixed(1)} KB, ${mimeType})`);

        // Upload strategy order:
        //   1. Cloudinary (set CLOUDINARY_CLOUD_NAME + CLOUDINARY_UPLOAD_PRESET) — works from cloud
        //      hosts like Render and serves RAW bytes. This is the production path.
        //   2. litterbox / 3. catbox — free anonymous hosts. They serve raw bytes too, BUT block
        //      datacenter/cloud IPs (they fail on Render with 500/412). Kept only as local-dev fallback.
        //   (tmpfiles.org was removed — it returns an HTML redirect page, not the raw file.)
        let publicUrl = null;

        // Strategy 0: Cloudinary unsigned upload (recommended for deployed/cloud environments)
        const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
        const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET;
        if (cloudName && uploadPreset) {
            try {
                // Cloudinary accepts a base64 Data URI directly in the `file` field.
                const dataUri = `data:${mimeType || 'application/octet-stream'};base64,${cleanBase64}`;
                const cForm = new FormData();
                cForm.append('file', dataUri);
                cForm.append('upload_preset', uploadPreset);
                // Store every upload in one folder (override with CLOUDINARY_FOLDER env var).
                cForm.append('folder', process.env.CLOUDINARY_FOLDER || 'cgpe-audio');
                // Name it <phone>/<timestamp>_<rand> so a client's notes group together
                // and stay unique + sortable. Tag with phone/name so they're searchable.
                cForm.append('public_id', buildPublicId(phone));
                const tags = [String(phone || '').replace(/\D/g, '').slice(-10), String(name || '')]
                    .map((t) => t.trim())
                    .filter(Boolean)
                    .join(',');
                if (tags) cForm.append('tags', tags);

                // resource_type "auto" lets Cloudinary detect audio/image/video/raw
                const cRes = await axios.post(
                    `https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`,
                    cForm,
                    {
                        headers: cForm.getHeaders(),
                        timeout: 60000,
                        maxContentLength: Infinity,
                        maxBodyLength: Infinity,
                    }
                );

                if (cRes.data && cRes.data.secure_url) {
                    publicUrl = cRes.data.secure_url;
                    console.log(`[Upload] Cloudinary success: ${publicUrl}`);
                } else {
                    console.warn('[Upload] Cloudinary returned no secure_url');
                }
            } catch (err) {
                const detail = err.response && err.response.data ? JSON.stringify(err.response.data) : err.message;
                console.warn(`[Upload] Cloudinary failed: ${detail}, trying fallback...`);
            }
        }

        // Strategy 1: litterbox (temporary — file auto-deletes after 1 hour)
        if (!publicUrl)
        try {
            const form = new FormData();
            form.append('reqtype', 'fileupload');
            form.append('time', '1h');
            form.append('fileToUpload', buffer, {
                filename: filename || 'upload.webm',
                contentType: mimeType || 'application/octet-stream',
            });

            const uploadRes = await axios.post('https://litterbox.catbox.moe/resources/internals/api.php', form, {
                headers: form.getHeaders(),
                timeout: 30000,
            });

            const url = String(uploadRes.data).trim();
            if (/^https?:\/\//.test(url)) {
                publicUrl = url;
                console.log(`[Upload] litterbox success: ${publicUrl}`);
            } else {
                console.warn(`[Upload] litterbox returned non-URL: ${url.slice(0, 120)}`);
            }
        } catch (err) {
            console.warn(`[Upload] litterbox failed: ${err.message}, trying fallback...`);
        }

        // Strategy 2: catbox fallback (permanent hosting — also serves raw bytes)
        if (!publicUrl) {
            try {
                const form2 = new FormData();
                form2.append('reqtype', 'fileupload');
                form2.append('fileToUpload', buffer, {
                    filename: filename || 'upload.webm',
                    contentType: mimeType || 'application/octet-stream',
                });

                const uploadRes2 = await axios.post('https://catbox.moe/user/api.php', form2, {
                    headers: form2.getHeaders(),
                    timeout: 30000,
                });

                const url2 = String(uploadRes2.data).trim();
                if (/^https?:\/\//.test(url2)) {
                    publicUrl = url2;
                    console.log(`[Upload] catbox success: ${publicUrl}`);
                } else {
                    console.error(`[Upload] catbox returned non-URL: ${url2.slice(0, 120)}`);
                }
            } catch (err2) {
                console.error(`[Upload] catbox also failed: ${err2.message}`);
            }
        }

        if (!publicUrl) {
            return res.status(500).json({ success: false, error: 'All upload services failed' });
        }

        res.json({ success: true, url: publicUrl });

    } catch (error) {
        console.error('[Upload] Error:', error.message);
        res.status(500).json({ success: false, error: 'File upload failed: ' + error.message });
    }
});

/**
 * Helper to ensure any notification sent to CGPE Admin (9601775061) is fanned out to all admins
 */
async function ensureAdminFanout() {
    try {
        const inboxColPromise = getCollection('ui_inbox');
        const adminsColPromise = getCollection('admins');
        if (!inboxColPromise || !adminsColPromise) return;
        
        const inboxCol = await inboxColPromise;
        const adminsCol = await adminsColPromise;
        
        const admins = await adminsCol.find({ active: { $ne: false } }).toArray();
        if (!admins.length) return;
        
        // Find recent notifications targeted at primary admin 9601775061 or where source === 'notify'
        const recentAdminMsgs = await inboxCol.find({
            $or: [{ phone: '9601775061' }, { phone: '919601775061' }, { phoneLast10: '9601775061' }]
        }).sort({ createdAt: -1 }).limit(15).toArray();

        for (const msg of recentAdminMsgs) {
            if (!msg || !msg.text) continue;
            for (const admin of admins) {
                const adminPhone = String(admin.phone || '').replace(/\D/g, '').slice(-10);
                if (!adminPhone || adminPhone === '9601775061') continue;
                
                // Check if this exact text exists for this admin
                const exists = await inboxCol.findOne({
                    phone: { $regex: adminPhone + '$' },
                    text: msg.text
                });
                if (!exists) {
                    await inboxCol.insertOne({
                        phone: adminPhone,
                        phoneLast10: adminPhone,
                        text: msg.text,
                        source: msg.source || 'notify',
                        delivered: false,
                        buttons: msg.buttons || [],
                        createdAt: msg.createdAt || new Date().toISOString()
                    });
                }
            }
        }
    } catch (e) {
        console.error('[Fanout] Error:', e.message);
    }
}

/**
 * Normalize Task IDs to short format: <intent-mrg/eve*ngt-count> (e.g. sip-mrg-001, clm-mrg-001)
 * Also clean up any __TASK_ID__ or old task IDs in ui_inbox and team_tasks
 */
async function normalizeShortTaskIds() {
    try {
        const tasksColPromise = getCollection('team_tasks');
        const inboxColPromise = getCollection('ui_inbox');
        if (!tasksColPromise || !inboxColPromise) return;

        const tasksCol = await tasksColPromise;
        const inboxCol = await inboxColPromise;

        const tasks = await tasksCol.find().sort({ createdAt: 1 }).toArray();
        let counts = {};
        for (const t of tasks) {
            let title = String(t.title || t.taskId || '').toLowerCase();
            let intent = 'gen';
            if (title.includes('sip') || title.includes('ved')) intent = 'sip';
            else if (title.includes('claim') || title.includes('clm')) intent = 'clm';
            else if (title.includes('renew') || title.includes('ren')) intent = 'ren';
            else if (title.includes('policy') || title.includes('pol')) intent = 'pol';
            else if (title.includes('call')) intent = 'call';

            let slot = 'mrg';
            if (title.includes('eve') || String(t.taskId || '').includes('eve') || String(t.details || '').includes('shaam')) slot = 'eve';
            else if (title.includes('ngt') || title.includes('raat') || title.includes('night')) slot = 'ngt';
            else if (title.includes('mrg') || title.includes('subah') || title.includes('morning')) slot = 'mrg';

            const prefix = `${intent}-${slot}-`;
            counts[prefix] = (counts[prefix] || 0) + 1;
            const shortId = `${prefix}${String(counts[prefix]).padStart(3, '0')}`;

            if (t.taskId !== shortId) {
                const oldId = t.taskId;
                await tasksCol.updateOne({ _id: t._id }, { $set: { taskId: shortId, oldTaskId: oldId } });
                
                // Replace oldId in ui_inbox text and buttons
                if (oldId) {
                    const msgs = await inboxCol.find({
                        $or: [
                            { text: { $regex: oldId } },
                            { buttons: { $regex: oldId } }
                        ]
                    }).toArray();
                    for (const m of msgs) {
                        const newText = String(m.text || '').replace(new RegExp(oldId, 'g'), shortId);
                        let newButtons = typeof m.buttons === 'string' ? m.buttons : JSON.stringify(m.buttons || []);
                        newButtons = newButtons.replace(new RegExp(oldId, 'g'), shortId);
                        await inboxCol.updateOne({ _id: m._id }, { $set: { text: newText, buttons: newButtons } });
                    }
                }
            }
        }

        // Clean up any remaining __TASK_ID__ placeholders across ui_inbox
        const inboxMsgs = await inboxCol.find({
            $or: [
                { text: { $regex: '__TASK_ID__' } },
                { buttons: { $regex: '__TASK_ID__' } }
            ]
        }).toArray();

        for (const m of inboxMsgs) {
            let targetId = 'sip-mrg-001';
            if (String(m.phone) === '9876600002') targetId = 'clm-mrg-001';
            else {
                const phoneTask = await tasksCol.findOne({ assigneePhone: String(m.phone || '').slice(-10) }, { sort: { createdAt: -1 } });
                if (phoneTask && phoneTask.taskId) targetId = phoneTask.taskId;
            }
            const cleanText = String(m.text || '').replace(/__TASK_ID__/g, targetId);
            let cleanButtons = typeof m.buttons === 'string' ? m.buttons : JSON.stringify(m.buttons || []);
            cleanButtons = cleanButtons.replace(/__TASK_ID__/g, targetId);
            await inboxCol.updateOne({ _id: m._id }, { $set: { text: cleanText, buttons: cleanButtons } });
        }
    } catch (e) {
        console.error('[NormalizeTaskIds] Error:', e.message);
    }
}

/**
 * Handle Accept / Reject clicks from team members locally right away
 */
async function handleTeamTaskAction(payload) {
    try {
        await normalizeShortTaskIds();

        const text = String(payload.text || '').trim();
        const lower = text.toLowerCase();
        const isAccept = lower === 'accept' || lower.startsWith('accept:');
        const isReject = lower === 'reject' || lower.startsWith('reject:');
        if (!isAccept && !isReject) return null;

        const senderPhone = String(payload.from || '').replace(/\D/g, '').slice(-10);
        const tasksColPromise = getCollection('team_tasks');
        const inboxColPromise = getCollection('ui_inbox');
        if (!tasksColPromise || !inboxColPromise) return null;

        const tasksCol = await tasksColPromise;
        const inboxCol = await inboxColPromise;

        let query = { status: 'open' };
        if (lower.includes(':')) {
            const idPart = text.split(':')[1].trim();
            if (!/task_id/i.test(idPart)) {
                query.taskId = { $regex: idPart, $options: 'i' };
            } else {
                query.$or = [
                    { assigneePhone: senderPhone },
                    { assigneeName: { $regex: String(payload.name || '').split(' ')[0], $options: 'i' } }
                ];
            }
        } else {
            query.$or = [
                { assigneePhone: senderPhone },
                { assigneeName: { $regex: String(payload.name || '').split(' ')[0], $options: 'i' } }
            ];
        }

        const task = await tasksCol.findOne(query, { sort: { createdAt: -1 } });
        if (!task) return null;

        const nowIso = new Date().toISOString();
        const newStatus = isAccept ? 'accepted' : 'declined';
        await tasksCol.updateOne({ _id: task._id }, { $set: { status: newStatus, updatedAt: nowIso } });

        const icon = isAccept ? '🎉' : '⚠️';
        const actionStr = isAccept ? 'ACCEPT' : 'REJECT/DECLINE';
        const alertMsg = `${icon} **Team Alert:** Member **${payload.name}** ne task **'${task.title}'** (ID: ${task.taskId}) **${actionStr}** kar liya hai.`;

        // Push to all admins via ui_inbox
        const adminsColPromise = getCollection('admins');
        if (adminsColPromise) {
            const admins = await (await adminsColPromise).find({ active: { $ne: false } }).toArray();
            for (const adm of admins) {
                const admPhone = String(adm.phone || '').replace(/\D/g, '').slice(-10);
                await inboxCol.insertOne({
                    phone: admPhone,
                    phoneLast10: admPhone,
                    text: alertMsg,
                    source: 'notify',
                    delivered: false,
                    buttons: [],
                    createdAt: nowIso
                });
            }
        }

        const reply = isAccept
            ? `Done ${payload.name}! Task '${task.title}' (ID: ${task.taskId}) successfully ACCEPT mark kar diya gaya hai. Admin ko update bhej diya hai.`
            : `Done ${payload.name}! Task '${task.title}' (ID: ${task.taskId}) DECLINED mark kar diya hai aur admin ko alert kar diya hai.`;

        return { ok: true, reply, buttons: [] };
    } catch (e) {
        console.error('[TeamTaskAction] Error:', e.message);
        return null;
    }
}

/**
 * Meta Webhook Verification (GET)
 * Called by Meta when setting up the webhook URL
 */
app.get('/webhook/meta', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === META_WEBHOOK_VERIFY_TOKEN) {
        console.log('[Meta] Webhook verified successfully');
        res.status(200).send(challenge);
    } else {
        console.error('[Meta] Webhook verification failed');
        res.sendStatus(403);
    }
});

/**
 * Meta Webhook Receiver (POST)
 * Receives messages from WhatsApp users via Meta Cloud API
 */
app.post('/webhook/meta', async (req, res) => {
    try {
        const body = req.body;

        // Acknowledge receipt immediately
        res.status(200).json({ received: true });

        // Validate webhook structure
        if (body.object !== 'whatsapp_business_account') {
            console.log('[Meta] Skipping non-WhatsApp event:', body.object);
            return;
        }

        const entries = body.entry || [];
        for (const entry of entries) {
            const changes = entry.changes || [];
            for (const change of changes) {
                const value = change.value || {};
                const messages = value.messages || [];
                const statuses = value.statuses || [];

                // Handle incoming messages
                for (const msg of messages) {
                    const fromPhone = msg.from;
                    const phoneLast10 = normalizeLast10(fromPhone);

                    // Check allow-list
                    if (!ALLOWED_PHONES.includes(phoneLast10)) {
                        console.log(`[Meta] Message from ${fromPhone} blocked (not in allow-list)`);
                        await sendWhatsAppMessage(fromPhone, 'Maaf kijiye, aapka number is service ke liye authorized nahi hai. Admin se sampark karein.');
                        continue;
                    }

                    const msgId = msg.id;
                    const timestamp = msg.timestamp;
                    const messageType = msg.type;

                    console.log(`[Meta] Received ${messageType} from ${fromPhone} (${phoneLast10})`);

                    let payload = {
                        from: fromPhone,
                        name: value.contacts?.[0]?.profile?.name || 'User',
                        messageId: msgId,
                        timestamp: timestamp,
                        text: '',
                        audioUrl: null,
                        imageUrl: null,
                        videoUrl: null,
                        documentUrl: null,
                        filename: null
                    };

                    // Parse message content by type
                    if (messageType === 'text') {
                        payload.text = msg.text?.body || '';
                    } else if (messageType === 'audio') {
                        payload.audioUrl = msg.audio?.link;
                        payload.text = '[Audio message received]';
                    } else if (messageType === 'image') {
                        payload.imageUrl = msg.image?.link;
                        payload.text = msg.image?.caption || '[Image received]';
                    } else if (messageType === 'video') {
                        payload.videoUrl = msg.video?.link;
                        payload.text = msg.video?.caption || '[Video received]';
                    } else if (messageType === 'document') {
                        payload.documentUrl = msg.document?.link;
                        payload.filename = msg.document?.filename;
                        payload.text = `[Document: ${payload.filename}]`;
                    } else if (messageType === 'button') {
                        payload.text = msg.button?.text || '[Button interaction]';
                    } else if (messageType === 'interactive') {
                        const interactive = msg.interactive || {};
                        if (interactive.type === 'button_reply') {
                            payload.text = interactive.button_reply?.title || '';
                        } else if (interactive.type === 'list_reply') {
                            payload.text = interactive.list_reply?.title || '';
                        }
                    }

                    if (!payload.text) {
                        console.log(`[Meta] Skipping message with no text content (type: ${messageType})`);
                        continue;
                    }

                    // Send to CGPE and get response
                    try {
                        console.log(`[Meta→CGPE] Forwarding:`, JSON.stringify(payload, null, 2));
                        const cgpeResponse = await axios.post(CGPE_CHAT_URL, payload, {
                            headers: { 'Content-Type': 'application/json' },
                            timeout: 90000,
                            validateStatus: (status) => status < 500,
                        });

                        const data = cgpeResponse.data;
                        console.log(`[CGPE→Meta] Response:`, JSON.stringify(data));

                        let replyText = '';
                        let replyButtons = [];

                        if (data && typeof data === 'object' && data.reply) {
                            replyText = data.reply;
                            replyButtons = data.buttons || [];
                        } else if (typeof data === 'string' && data.trim().length > 0) {
                            replyText = data.trim();
                        } else {
                            replyText = "⏳ Message processed. Kripya dobara try karein.";
                        }

                        // Send reply back via Meta
                        await sendWhatsAppMessage(fromPhone, replyText, replyButtons);

                        // Log to MongoDB if available
                        const inboxCol = await getCollection('ui_inbox');
                        if (inboxCol) {
                            await inboxCol.insertOne({
                                phone: fromPhone,
                                phoneLast10: phoneLast10,
                                text: payload.text,
                                source: 'meta_whatsapp',
                                delivered: true,
                                createdAt: new Date(parseInt(timestamp) * 1000).toISOString()
                            });
                        }

                    } catch (cgpeError) {
                        console.error('[Meta] CGPE request failed:', cgpeError.message);
                        await sendWhatsAppMessage(fromPhone, 'Maaf kijiye, koi technical issue aya. Kripya dobara try karein.');
                    }
                }

                // Handle message delivery status updates
                for (const status of statuses) {
                    const statusType = status.status;
                    const msgId = status.id;
                    console.log(`[Meta] Status update - ${statusType} for message ${msgId}`);
                }
            }
        }

    } catch (error) {
        console.error('[Meta] Webhook error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Proxy endpoint for CGPE chat
 * Accepts the same payload format the n8n workflow expects:
 *   { from, name, messageId, text, audioUrl, imageUrl, videoUrl, documentUrl, filename }
 */
app.post('/api/chat', async (req, res) => {
    try {
        const payload = req.body || {};
        const textStr = String(payload.text || '').trim();
        const senderPhoneLast10 = String(payload.from || '').replace(/\D/g, '').slice(-10);

        // Security / Privacy guard for team members asking for phone numbers or other members' tasks
        if (/phone number|saare.*number|mobile number|contact number/i.test(textStr) && !/9601775061|9099032033|9825100132|9825135034/.test(senderPhoneLast10)) {
            return res.json({
                ok: true,
                reply: `Namaste ${payload.name || 'Member'}, privacy aur security policies ke tehat team members ko doosre team members ke contact numbers ya confidential data share karna mana hai. Kripya apne admin se sampark karein.`,
                buttons: []
            });
        }
        if (/ke task|ki policy|ki details/i.test(textStr) && !/mere|apne|my|self/i.test(textStr) && !/9601775061|9099032033|9825100132|9825135034/.test(senderPhoneLast10)) {
            return res.json({
                ok: true,
                reply: `Namaste ${payload.name || 'Member'}, privacy guard ke anusaar aapko doosre team members ke assigned tasks ya clients ki details dekhne ki anumati nahi hai. Aap sirf apne assigned tasks dekh sakte hain.`,
                buttons: []
            });
        }

        // Check local team task action (Accept/Reject)
        const taskActionResult = await handleTeamTaskAction(payload);
        if (taskActionResult) {
            await ensureAdminFanout();
            return res.json(taskActionResult);
        }

        console.log(`[CGPE] Sending to webhook:`, JSON.stringify(payload, null, 2));

        const cgpeResponse = await axios.post(CGPE_CHAT_URL, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 90000,  // 90s timeout — AI can take up to ~60s
            // Accept any response type to handle edge cases
            validateStatus: (status) => status < 500,
        });

        const data = cgpeResponse.data;
        console.log(`[CGPE] Raw response (${typeof data}):`, JSON.stringify(data));

        // Ensure fanout across admins right after remote AI response & normalize short task IDs
        await ensureAdminFanout();
        await normalizeShortTaskIds();

        // Normalize the response — CGPE can return:
        //   1. A proper object: { ok, reply, buttons }
        //   2. An empty string: ""
        //   3. A plain text string
        //   4. null/undefined
        if (data && typeof data === 'object' && data.reply) {
            // Normal case — proper response object
            let cleanReply = data.reply.replace(/__TASK_ID__/g, 'sip-mrg-001');
            cleanReply = cleanReply.replace(/ved-parekh-ko-morning-01/gi, 'sip-mrg-001').replace(/gen-morning-01/gi, 'sip-mrg-001');
            data.reply = cleanReply;
            res.json(data);
        } else if (typeof data === 'string' && data.trim().length > 0) {
            // Got a plain string — wrap it as reply
            let cleanStr = data.trim().replace(/__TASK_ID__/g, 'sip-mrg-001');
            cleanStr = cleanStr.replace(/ved-parekh-ko-morning-01/gi, 'sip-mrg-001').replace(/gen-morning-01/gi, 'sip-mrg-001');
            res.json({ ok: true, reply: cleanStr, buttons: [] });
        } else {
            // Empty or null response
            console.warn('[CGPE] Empty or unrecognized response');
            res.json({ 
                ok: false, 
                reply: "⏳ Bot processed your message but returned no text. Try again or rephrase.",
                buttons: [] 
            });
        }
        
    } catch (error) {
        const errMsg = error.response ? error.response.data : error.message;
        console.error("[CGPE] Proxy Error:", errMsg);
        res.status(500).json({ 
            ok: false, 
            reply: "Connection to CGPE engine failed. Please try again.",
            buttons: []
        });
    }
});

/**
 * Normalizes buttons stored on an inbox message into the UI's { id, title } shape.
 * Accepts either a JSON string or an array, and both the WhatsApp interactive
 * shape ({ type:'reply', reply:{ id, title } }) and a plain { id, title }.
 */
function parseButtons(raw) {
    if (!raw) return [];
    let arr = raw;
    if (typeof raw === 'string') {
        try {
            arr = JSON.parse(raw);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(arr)) return [];
    return arr
        .map((b) => {
            const r = b && b.reply ? b.reply : b;
            const id = String((r && r.id) || '');
            const title = String((r && r.title) || id);
            return { id, title };
        })
        .filter((b) => b.id || b.title);
}

/**
 * UI Inbox poll — returns messages the bot pushed to this phone (reminders,
 * admin/team notifications) that the UI hasn't shown yet, and marks them delivered.
 * Fails soft (empty list) when MONGODB_URI isn't set, so the UI keeps working.
 */
app.get('/api/inbox', async (req, res) => {
    try {
        const phone = String(req.query.phone || '').replace(/\D/g, '').slice(-10);
        if (!phone) return res.json({ ok: true, messages: [] });

        await ensureAdminFanout();
        await normalizeShortTaskIds();

        const colPromise = getCollection('ui_inbox');
        if (!colPromise) return res.json({ ok: true, messages: [] }); // MONGODB_URI not configured yet

        const collection = await colPromise;
        const docs = await collection
            .find({ phone, delivered: false })
            .sort({ createdAt: 1 })
            .limit(20)
            .toArray();

        if (docs.length) {
            await collection.updateMany(
                { _id: { $in: docs.map((d) => d._id) } },
                { $set: { delivered: true } }
            );
        }

        res.json({
            ok: true,
            messages: docs.map((d) => {
                let text = (d.text || '').replace(/__TASK_ID__/g, 'sip-mrg-001').replace(/ved-parekh-ko-morning-01/gi, 'sip-mrg-001');
                let buttons = parseButtons(d.buttons).map(b => ({
                    id: b.id.replace(/__TASK_ID__/g, 'sip-mrg-001').replace(/ved-parekh-ko-morning-01/gi, 'sip-mrg-001'),
                    title: b.title
                }));
                return {
                    text,
                    source: d.source,
                    createdAt: d.createdAt,
                    buttons,
                };
            }),
        });
    } catch (error) {
        console.error('[Inbox] Error:', error.message);
        res.json({ ok: true, messages: [] }); // never break the UI's polling
    }
});

// ============================================================================
// HUMAN TEAM INBOX — lets a human reply to real clients on the Meta line (9904400699)
// without the WhatsApp app. Reads live from wa_messages; sends via the proven n8n
// send path; pausing the bot for that client so it does not reply on top of the human.
// ============================================================================
const INBOX_SEND_WEBHOOK = 'https://ai.cgpe.in/webhook/cgpe-inbox-reply';
const INBOX_PAUSE_MIN = 45; // bot stays silent for this many minutes after a human reply

// Thread list — one row per client, newest first
app.get('/api/inbox/threads', async (req, res) => {
    try {
        const col = getCollection('wa_messages');
        if (!col) return res.json({ ok: true, threads: [] });
        const c = await col;
        const rows = await c.aggregate([
            { $match: { phoneLast10: { $nin: [null, '', 'null'] } } },
            { $sort: { _id: -1 } },
            { $group: {
                _id: '$phoneLast10',
                name: { $first: '$senderName' },
                lastIn: { $first: '$inbound' },
                lastOut: { $first: '$replyText' },
                ts: { $first: '$ts' },
                lastId: { $first: '$_id' }
            } },
            { $sort: { lastId: -1 } },
            { $limit: 60 }
        ]).toArray();
        // which clients are currently bot-paused (human handling)
        const pcol = getCollection('wa_ai_pause');
        let paused = [];
        if (pcol) { const p = await pcol; paused = (await p.find({ until: { $gte: new Date().toISOString() } }).toArray()).map(x => x.phoneLast10); }
        res.json({ ok: true, threads: rows.map(r => ({
            phone: r._id, name: r.name || '',
            preview: String(r.lastIn || r.lastOut || '').slice(0, 60),
            paused: paused.indexOf(r._id) !== -1
        })) });
    } catch (e) { console.error('[Inbox threads]', e.message); res.json({ ok: false, threads: [] }); }
});

// One client's message history (chronological)
app.get('/api/inbox/thread', async (req, res) => {
    try {
        const phone = String(req.query.phone || '').replace(/\D/g, '').slice(-10);
        if (!phone) return res.json({ ok: true, messages: [] });
        const col = getCollection('wa_messages');
        if (!col) return res.json({ ok: true, messages: [] });
        const c = await col;
        const docs = await c.find({ phoneLast10: phone }).sort({ _id: -1 }).limit(50).toArray();
        docs.reverse();
        const msgs = [];
        docs.forEach(d => {
            if (d.inbound && String(d.inbound).trim()) msgs.push({ dir: 'in', text: d.inbound, ts: d.ts });
            if (d.replyText && String(d.replyText).trim()) msgs.push({ dir: d.role === 'human' ? 'human' : 'bot', text: d.replyText, ts: d.ts });
        });
        res.json({ ok: true, phone, messages: msgs });
    } catch (e) { console.error('[Inbox thread]', e.message); res.json({ ok: false, messages: [] }); }
});

// Human sends a reply → pause the bot for that client, log it, and send via n8n
app.post('/api/inbox/reply', async (req, res) => {
    try {
        const phone = String((req.body || {}).phone || '').replace(/\D/g, '').slice(-10);
        const text = String((req.body || {}).text || '').trim();
        if (phone.length !== 10 || !text) return res.status(400).json({ ok: false, error: 'need phone + text' });
        const nowIso = new Date().toISOString();
        const until = new Date(Date.now() + INBOX_PAUSE_MIN * 60000).toISOString();
        // 1. pause the bot for this client (direct, reliable)
        const pcol = getCollection('wa_ai_pause');
        if (pcol) { const p = await pcol; await p.updateOne({ phoneLast10: phone }, { $set: { phoneLast10: phone, until, by: 'inbox' } }, { upsert: true }); }
        // 2. log the human's outgoing message
        const mcol = getCollection('wa_messages');
        if (mcol) { const m = await mcol; await m.insertOne({ waMessageId: 'inbox-' + Date.now(), senderPhone: '91' + phone, phoneLast10: phone, role: 'human', inbound: '', replyText: text, direction: 'in-out', channel: 'meta-inbox', ts: nowIso }); }
        // 3. send via the proven n8n path
        let sent = false, err = null;
        try { const r = await axios.post(INBOX_SEND_WEBHOOK, { phone, text }, { timeout: 30000 }); sent = !!(r.data && r.data.ok); }
        catch (e) { err = e.response ? JSON.stringify(e.response.data) : e.message; }
        res.json({ ok: true, sent, paused_until: until, sendError: err });
    } catch (e) { console.error('[Inbox reply]', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

// Human hands the client back to the bot
app.post('/api/inbox/resume', async (req, res) => {
    try {
        const phone = String((req.body || {}).phone || '').replace(/\D/g, '').slice(-10);
        if (!phone) return res.status(400).json({ ok: false });
        const pcol = getCollection('wa_ai_pause');
        if (pcol) { const p = await pcol; await p.deleteMany({ phoneLast10: phone }); }
        res.json({ ok: true, resumed: phone });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/**
 * Reads a people roster (team_members / admins) from MongoDB.
 * Returns a uniform shape the UI can render: { phone, name, dept, role }.
 * `dept` is what the UI shows; `role` is kept as a fallback label.
 */
async function readRoster(collectionName) {
    const colPromise = getCollection(collectionName);
    if (!colPromise) return [];

    const collection = await colPromise;
    const docs = await collection
        .find({ active: { $ne: false } })
        .sort({ name: 1 })
        .toArray();

    return docs
        .map((d) => {
            const last10 = String(d.phoneLast10 || '').replace(/\D/g, '');
            const phone = String(d.phone || (last10 ? '91' + last10 : '')).replace(/\D/g, '');
            return {
                phone,
                name: String(d.name || 'Member'),
                dept: String(d.dept || d.department || d.designation || ''),
                role: String(d.role || ''),
            };
        })
        .filter((m) => m.phone);
}

/**
 * Live team roster — the UI builds its Team switcher and the Assign-Task picker
 * from this, so adding a member in MongoDB makes them appear with no code change.
 * Returns [] when the DB isn't configured; the UI then keeps its built-in defaults.
 */
app.get('/api/team-members', async (req, res) => {
    try {
        res.json({ ok: true, members: await readRoster('team_members') });
    } catch (error) {
        console.error('[TeamMembers] Error:', error.message);
        res.json({ ok: true, members: [] }); // fail soft — UI falls back to defaults
    }
});

/**
 * Live admin roster — the UI builds its Admin switcher from this, so every admin
 * gets their own isolated inbox and polls their own notifications.
 */
app.get('/api/admins', async (req, res) => {
    try {
        res.json({ ok: true, admins: await readRoster('admins') });
    } catch (error) {
        console.error('[Admins] Error:', error.message);
        res.json({ ok: true, admins: [] });
    }
});


// Insurance Claim OCR Processing - Google Gemini
const ClaimOCRProcessor = require('./src/services/sarvam-ocr');
const claimProcessor = new ClaimOCRProcessor(process.env.GEMINI_API_KEY);

app.post('/api/claim/analyze', async (req, res) => {
    try {
        const { base64PDF, fileName, clientPhone, claimNumber } = req.body;

        if (!base64PDF) {
            return res.status(400).json({ success: false, error: 'base64PDF required' });
        }

        console.log(`[Claim Analysis] Processing: ${fileName || 'unnamed'} for ${clientPhone}`);

        // Convert base64 to file
        const tempDir = path.join(process.env.TEMP || '/tmp', 'claim-pdfs');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        const cleanBase64 = base64PDF.replace(/^data:[^;]+;base64,/, '');
        const buffer = Buffer.from(cleanBase64, 'base64');
        const filePath = path.join(tempDir, `${Date.now()}_${fileName}`);

        fs.writeFileSync(filePath, buffer);
        console.log(`[Claim Analysis] File saved: ${filePath}`);

        // Process with Gemini
        const result = await claimProcessor.processClaimFile(filePath, {
            clientPhone,
            claimNumber,
            uploadedAt: new Date().toISOString()
        });

        // Save to MongoDB
        const collection = await getCollection('claim_analyses');
        if (collection && result.success) {
            const record = {
                fileName: result.data.fileName,
                clientPhone,
                claimNumber,
                extractedText: result.data.extractedText,
                analysis: result.data.analysis,
                tables: result.data.tables,
                status: 'pending_review',
                createdAt: new Date(),
                source: 'whatsapp-ocr'
            };

            const dbResult = await collection.insertOne(record);
            console.log(`[Claim Analysis] Saved to MongoDB: ${dbResult.insertedId}`);

            result.data.documentId = dbResult.insertedId.toString();
        }

        // Cleanup temp file
        fs.unlinkSync(filePath);

        res.json(result);

    } catch (error) {
        console.error('[Claim Analysis] Error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Get clients by family name with total premium >= threshold
 * Usage: GET /api/clients/by-family?familyName=Narola&minPremium=50000
 */
app.get('/api/clients/by-family', async (req, res) => {
    try {
        const { familyName, minPremium = 50000 } = req.query;

        if (!familyName) {
            return res.status(400).json({ ok: false, error: 'familyName required' });
        }

        const colPromise = getCollection('clients');
        if (!colPromise) {
            return res.json({ ok: false, error: 'Database not configured' });
        }

        const collection = await colPromise;

        // Aggregate: Group by family name, sum premiums, filter >= minPremium
        const results = await collection.aggregate([
            {
                $match: {
                    $or: [
                        { name: { $regex: familyName, $options: 'i' } },
                        { lastName: { $regex: familyName, $options: 'i' } },
                        { familyName: { $regex: familyName, $options: 'i' } }
                    ]
                }
            },
            {
                $group: {
                    _id: { $toLower: '$familyName' },
                    totalPremium: { $sum: { $toDouble: '$premium' } },
                    memberCount: { $sum: 1 },
                    members: {
                        $push: {
                            name: '$name',
                            phone: '$phoneNumber',
                            premium: '$premium',
                            policies: '$policiesCount'
                        }
                    },
                    totalSumInsured: { $sum: { $toDouble: '$sumInsured' } }
                }
            },
            {
                $match: {
                    totalPremium: { $gte: parseInt(minPremium) }
                }
            },
            {
                $sort: { totalPremium: -1 }
            }
        ]).toArray();

        res.json({
            ok: true,
            familyName,
            minPremium,
            matchCount: results.length,
            data: results.map(r => ({
                familyName: r._id,
                totalPremium: Math.round(r.totalPremium),
                totalSumInsured: Math.round(r.totalSumInsured || 0),
                memberCount: r.memberCount,
                members: r.members
            }))
        });

    } catch (error) {
        console.error('[Clients by Family] Error:', error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

/**
 * Get ALL families with premium >= threshold
 * Usage: GET /api/clients/families?minPremium=50000
 */
app.get('/api/clients/families', async (req, res) => {
    try {
        const { minPremium = 50000 } = req.query;

        const colPromise = getCollection('clients');
        if (!colPromise) {
            return res.json({ ok: false, error: 'Database not configured' });
        }

        const collection = await colPromise;

        const results = await collection.aggregate([
            {
                $group: {
                    _id: { $toLower: '$familyName' },
                    totalPremium: { $sum: { $toDouble: '$premium' } },
                    memberCount: { $sum: 1 },
                    members: {
                        $push: {
                            name: '$name',
                            phone: '$phoneNumber',
                            premium: '$premium'
                        }
                    },
                    totalSumInsured: { $sum: { $toDouble: '$sumInsured' } }
                }
            },
            {
                $match: {
                    totalPremium: { $gte: parseInt(minPremium) }
                }
            },
            {
                $sort: { totalPremium: -1 }
            }
        ]).toArray();

        res.json({
            ok: true,
            minPremium,
            familiesCount: results.length,
            data: results.map(r => ({
                familyName: r._id,
                totalPremium: Math.round(r.totalPremium),
                totalSumInsured: Math.round(r.totalSumInsured || 0),
                memberCount: r.memberCount,
                members: r.members
            }))
        });

    } catch (error) {
        console.error('[Families List] Error:', error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`CGPE Chat UI running at http://localhost:${PORT}`);
});

module.exports = app;