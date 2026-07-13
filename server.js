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
app.post('/api/upload', async (req, res) => {
    try {
        const { base64Data, mimeType, filename } = req.body;

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
 * Proxy endpoint for CGPE chat
 * Accepts the same payload format the n8n workflow expects:
 *   { from, name, messageId, text, audioUrl, imageUrl, videoUrl, documentUrl, filename }
 */
app.post('/api/chat', async (req, res) => {
    try {
        const payload = req.body;
        console.log(`[CGPE] Sending to webhook:`, JSON.stringify(payload, null, 2));

        const cgpeResponse = await axios.post(CGPE_CHAT_URL, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 90000,  // 90s timeout — AI can take up to ~60s
            // Accept any response type to handle edge cases
            validateStatus: (status) => status < 500,
        });

        const data = cgpeResponse.data;
        console.log(`[CGPE] Raw response (${typeof data}):`, JSON.stringify(data));

        // Normalize the response — CGPE can return:
        //   1. A proper object: { ok, reply, buttons }
        //   2. An empty string: ""
        //   3. A plain text string
        //   4. null/undefined
        if (data && typeof data === 'object' && data.reply) {
            // Normal case — proper response object
            res.json(data);
        } else if (typeof data === 'string' && data.trim().length > 0) {
            // Got a plain string — wrap it as reply
            res.json({ ok: true, reply: data.trim(), buttons: [] });
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
 * UI Inbox poll — returns messages the bot pushed to this phone (reminders,
 * admin/team notifications) that the UI hasn't shown yet, and marks them delivered.
 * Fails soft (empty list) when MONGODB_URI isn't set, so the UI keeps working.
 */
app.get('/api/inbox', async (req, res) => {
    try {
        const phone = String(req.query.phone || '').replace(/\D/g, '').slice(-10);
        if (!phone) return res.json({ ok: true, messages: [] });

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
            messages: docs.map((d) => ({ text: d.text, source: d.source, createdAt: d.createdAt })),
        });
    } catch (error) {
        console.error('[Inbox] Error:', error.message);
        res.json({ ok: true, messages: [] }); // never break the UI's polling
    }
});

/**
 * Live team roster — the UI builds its Team switcher and the Assign-Task picker
 * from this, so adding a member in MongoDB makes them appear with no code change.
 * Returns [] when the DB isn't configured; the UI then keeps its built-in defaults.
 */
app.get('/api/team-members', async (req, res) => {
    try {
        const colPromise = getCollection('team_members');
        if (!colPromise) return res.json({ ok: true, members: [] });

        const collection = await colPromise;
        const docs = await collection
            .find({ active: { $ne: false } })
            .sort({ name: 1 })
            .toArray();

        res.json({
            ok: true,
            members: docs
                .map((d) => {
                    const last10 = String(d.phoneLast10 || '').replace(/\D/g, '');
                    const phone = String(d.phone || (last10 ? '91' + last10 : '')).replace(/\D/g, '');
                    return { phone, name: String(d.name || 'Team Member'), role: String(d.role || '') };
                })
                .filter((m) => m.phone),
        });
    } catch (error) {
        console.error('[TeamMembers] Error:', error.message);
        res.json({ ok: true, members: [] }); // fail soft — UI falls back to defaults
    }
});

app.listen(PORT, () => {
    console.log(`CGPE Chat UI running at http://localhost:${PORT}`);
});

module.exports = app;