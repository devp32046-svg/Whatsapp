const express = require('express');
const path = require("path");
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

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

        // Try tmpfiles.org first, then 0x0.st as fallback
        let publicUrl = null;

        // Strategy 1: tmpfiles.org (files last ~1 hour)
        try {
            const form = new FormData();
            form.append('file', buffer, {
                filename: filename || 'upload.webm',
                contentType: mimeType || 'application/octet-stream',
            });

            const uploadRes = await axios.post('https://tmpfiles.org/api/v1/upload', form, {
                headers: form.getHeaders(),
                timeout: 30000,
            });

            if (uploadRes.data && uploadRes.data.status === 'success' && uploadRes.data.data && uploadRes.data.data.url) {
                // Convert view URL to direct download URL
                // tmpfiles.org/12345/file.webm → tmpfiles.org/dl/12345/file.webm
                publicUrl = uploadRes.data.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
                console.log(`[Upload] tmpfiles.org success: ${publicUrl}`);
            }
        } catch (err) {
            console.warn(`[Upload] tmpfiles.org failed: ${err.message}, trying fallback...`);
        }

        // Strategy 2: 0x0.st fallback
        if (!publicUrl) {
            try {
                const form2 = new FormData();
                form2.append('file', buffer, {
                    filename: filename || 'upload.webm',
                    contentType: mimeType || 'application/octet-stream',
                });

                const uploadRes2 = await axios.post('https://0x0.st', form2, {
                    headers: form2.getHeaders(),
                    timeout: 30000,
                });

                publicUrl = uploadRes2.data.trim();
                console.log(`[Upload] 0x0.st success: ${publicUrl}`);
            } catch (err2) {
                console.error(`[Upload] 0x0.st also failed: ${err2.message}`);
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

app.listen(PORT, () => {
    console.log(`CGPE Chat UI running at http://localhost:${PORT}`);
});

module.exports = app;