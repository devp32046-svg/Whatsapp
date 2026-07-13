const express = require('express');
const path = require("path");
const axios = require('axios');
const FormData = require('form-data');
const { MongoClient } = require('mongodb');
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

app.listen(PORT, () => {
    console.log(`CGPE Chat UI running at http://localhost:${PORT}`);
});

module.exports = app;