/**
 * CGPE PDF Prep Service
 * ---------------------
 * Gemini rejects a single PDF over roughly 20 MB (400 INVALID_ARGUMENT), but the limit is
 * PER FILE, not per request — several smaller files in one request are accepted and produce
 * one combined analysis. So this service splits an oversized claim PDF into page-chunks,
 * uploads each chunk to the Gemini File API, and hands n8n back just the file URIs.
 *
 * Run it on the same host as n8n so n8n can reach it over localhost.
 *
 *   npm install express pdf-lib
 *   GEMINI_API_KEY=<claims key> node pdf-prep-service.js
 *
 * POST /prepare
 *   { "mediaId": "...", "token": "...", "graphVersion": "v20.0" }   // fetch from WhatsApp
 *   or { "base64": "..." }                                          // send the bytes directly
 * ->{ ok, pages, chunks, sizeMb, fileUris: [...], split: true|false }
 */
const express = require('express');
const https = require('https');
const { PDFDocument } = require('pdf-lib');

const PORT = process.env.PDF_PREP_PORT || 3100;
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const MAX_CHUNK_MB = Number(process.env.MAX_CHUNK_MB || 15);   // stay clear of the ~20 MB ceiling

const app = express();
app.use(express.json({ limit: '200mb' }));

function get(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: headers || {} }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(res.headers.location, headers));
      }
      const bufs = [];
      res.on('data', d => bufs.push(d));
      res.on('end', () => resolve({ status: res.statusCode, buffer: Buffer.concat(bufs) }));
    }).on('error', reject);
  });
}

function uploadToGemini(buf, mime) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'generativelanguage.googleapis.com', path: '/upload/v1beta/files', method: 'POST',
      headers: { 'x-goog-api-key': GEMINI_KEY, 'X-Goog-Upload-Protocol': 'raw',
        'Content-Type': mime || 'application/pdf', 'Content-Length': buf.length },
      timeout: 600000
    }, res => {
      let s = '';
      res.on('data', d => s += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(s);
          if (j.error) return reject(new Error(j.error.message));
          resolve(j.file);
        } catch (e) { reject(new Error('bad upload response: ' + s.slice(0, 200))); }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('upload timeout')); });
    r.write(buf); r.end();
  });
}

// Split by page count, then halve any chunk that is still too big. Scanned pages vary
// wildly in size, so a fixed pages-per-chunk is not enough on its own.
async function splitToChunks(buf, maxBytes) {
  const src = await PDFDocument.load(buf, { ignoreEncryption: true });
  const total = src.getPageCount();
  const avg = buf.length / Math.max(1, total);
  let per = Math.max(1, Math.floor(maxBytes / Math.max(1, avg)));
  const ranges = [];
  for (let i = 0; i < total; i += per) ranges.push([i, Math.min(i + per, total)]);

  const out = [];
  for (const [from, to] of ranges) {
    let queue = [[from, to]];
    while (queue.length) {
      const [a, b] = queue.shift();
      const doc = await PDFDocument.create();
      const pages = await doc.copyPages(src, Array.from({ length: b - a }, (_, k) => a + k));
      pages.forEach(p => doc.addPage(p));
      const bytes = Buffer.from(await doc.save());
      if (bytes.length > maxBytes && (b - a) > 1) {
        const mid = a + Math.ceil((b - a) / 2);
        queue.unshift([a, mid], [mid, b]);       // still too fat: cut it in half
      } else {
        out.push({ from: a + 1, to: b, bytes });
      }
    }
  }
  return { total, chunks: out };
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'pdf-prep', maxChunkMb: MAX_CHUNK_MB, hasKey: !!GEMINI_KEY }));

app.post('/prepare', async (req, res) => {
  const t0 = Date.now();
  try {
    if (!GEMINI_KEY) return res.status(500).json({ ok: false, error: 'GEMINI_API_KEY not set on the service' });
    const body = req.body || {};
    const mime = String(body.mimeType || 'application/pdf');
    const isPdf = mime.indexOf('pdf') !== -1;
    let buf;

    if (body.base64) {
      let b = String(body.base64);
      const i = b.indexOf('base64,');
      if (i !== -1) b = b.slice(i + 7);
      buf = Buffer.from(b, 'base64');
    } else if (body.mediaId) {
      const ver = body.graphVersion || 'v20.0';
      const meta = await get('https://graph.facebook.com/' + ver + '/' + body.mediaId,
        { Authorization: 'Bearer ' + body.token });
      const info = JSON.parse(meta.buffer.toString('utf8'));
      if (!info.url) return res.status(400).json({ ok: false, error: 'could not resolve media url', detail: info });
      const file = await get(info.url, { Authorization: 'Bearer ' + body.token });
      buf = file.buffer;
    } else {
      return res.status(400).json({ ok: false, error: 'send base64 or mediaId' });
    }

    const sizeMb = Math.round(buf.length / 1048576 * 10) / 10;
    const maxBytes = MAX_CHUNK_MB * 1048576;

    // Only PDFs can be split. An image (or anything else) is uploaded as-is with its own
    // mime type - loading a JPEG as a PDF would corrupt the claim.
    if (!isPdf || buf.length <= maxBytes) {
      const f = await uploadToGemini(buf, mime);
      return res.json({ ok: true, split: false, mime: mime, sizeMb, pages: null, chunks: 1,
        fileUris: [f.uri], tookMs: Date.now() - t0 });
    }

    const { total, chunks } = await splitToChunks(buf, maxBytes);
    const uris = [];
    const detail = [];
    for (const c of chunks) {
      const f = await uploadToGemini(c.bytes, 'application/pdf');
      uris.push(f.uri);
      detail.push({ pages: c.from + '-' + c.to, mb: Math.round(c.bytes.length / 1048576 * 10) / 10 });
    }
    res.json({ ok: true, split: true, mime: mime, sizeMb, pages: total, chunks: uris.length,
      fileUris: uris, parts: detail, tookMs: Date.now() - t0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

app.listen(PORT, () => console.log('pdf-prep listening on http://127.0.0.1:' + PORT));
