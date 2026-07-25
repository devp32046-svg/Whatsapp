'use strict';
/**
 * Splitting an oversized PDF and handing the pieces to Gemini.
 *
 * Lifted out of pdf-prep-service.js so the pre-check service can use the same proven code
 * instead of a second implementation. pdf-prep-service.js runs on the n8n server and is only
 * reachable from inside n8n, so the pre-check service cannot simply call it.
 *
 * 🔑 Gemini's size limit is PER FILE, not per request - a 51 MB PDF is rejected, but the same
 * document split into chunks and passed as several file_data parts in ONE call works.
 */
const https = require('https');
const { PDFDocument } = require('pdf-lib');

const MAX_CHUNK_MB = Number(process.env.MAX_CHUNK_MB || 15);   // stay clear of the ~20 MB ceiling

function uploadToGemini(buf, mime, apiKey) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'generativelanguage.googleapis.com', path: '/upload/v1beta/files', method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'X-Goog-Upload-Protocol': 'raw',
        'Content-Type': mime || 'application/pdf', 'Content-Length': buf.length },
      timeout: 600000
    }, res => {
      let s = '';
      res.on('data', d => s += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(s);
          if (j.error) { return reject(new Error(j.error.message)); }
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
  const per = Math.max(1, Math.floor(maxBytes / Math.max(1, avg)));
  const ranges = [];
  for (let i = 0; i < total; i += per) { ranges.push([i, Math.min(i + per, total)]); }

  const out = [];
  for (const [from, to] of ranges) {
    const queue = [[from, to]];
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

/**
 * -> { parts, split, chunks, pages } where `parts` goes straight into generateContent.
 * Anything small enough, and anything that is not a PDF, is sent inline unchanged.
 */
async function buildGeminiParts(buf, mimeType, apiKey, maxChunkMb) {
  const maxBytes = (maxChunkMb || MAX_CHUNK_MB) * 1048576;
  const isPdf = String(mimeType || '').indexOf('pdf') !== -1;

  if (!isPdf || buf.length <= maxBytes) {
    return { parts: [{ inlineData: { data: buf.toString('base64'), mimeType: mimeType } }],
      split: false, chunks: 1, pages: null };
  }

  const { total, chunks } = await splitToChunks(buf, maxBytes);
  const parts = [];
  for (const c of chunks) {
    const f = await uploadToGemini(c.bytes, 'application/pdf', apiKey);
    parts.push({ fileData: { mimeType: 'application/pdf', fileUri: f.uri } });
  }
  return { parts: parts, split: true, chunks: chunks.length, pages: total };
}

module.exports = { splitToChunks, uploadToGemini, buildGeminiParts, MAX_CHUNK_MB };
