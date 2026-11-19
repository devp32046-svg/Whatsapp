/*
 * coa-extract.js — shared COA/spec extractor: from a parsed email's PDF attachments → aaziko_jarvis.coa_docs.
 * Used by BOTH the live poller (auto-read on new mail) and the on-demand coa-ingest script — one code path.
 * Text PDF → cheap DeepInfra extract; scanned image PDF → Vertex Gemini OCR. Read-only on the mailbox; files saved under aaziko/coa-files/.
 */
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const LLM = require('./llm');
const VERTEX = require('./vertex-ocr');

const ROOT = path.resolve(__dirname, '..');            // aaziko/
const FILES = path.join(ROOT, 'coa-files');
const COA_HINT = /coa|certificate|analysis|spec|technical|tds|msds|\bsds\b|data ?sheet|test ?report|assay/i;
const safe = (s) => String(s || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 80);

async function pdfText(buf) { try { const p = new PDFParse({ data: buf }); const r = await p.getText(); return String(r.text || ''); } catch (e) { return ''; } }

// Extract + store every PDF attachment of a parsed email. Dedup by messageId|filename. Returns {pdfs, saved, items:[...]}.
async function extractAndStoreCoas(parsed, coaCol) {
  try { if (!fs.existsSync(FILES)) fs.mkdirSync(FILES, { recursive: true }); } catch (e) {}
  const atts = (parsed.attachments || []).filter(a => /pdf/i.test(a.contentType || '') || /\.pdf$/i.test(a.filename || ''));
  if (!atts.length) return { pdfs: 0, saved: 0, items: [] };
  const fromEmail = ((parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address) || '').toLowerCase();
  const messageId = parsed.messageId || null;
  const subject = parsed.subject || '';
  let pdfs = 0, saved = 0; const items = [];
  for (const a of atts) {
    pdfs++;
    const key = (messageId || ('nomsgid:' + (a.checksum || Date.now()))) + '|' + (a.filename || ('att' + pdfs));
    if (await coaCol.findOne({ key }, { projection: { _id: 1 } })) continue;   // already ingested
    const buf = a.content; if (!buf || buf.length > 8 * 1024 * 1024) continue;   // skip >8MB
    const savedAs = safe(Date.now() + '_' + (a.filename || 'coa.pdf'));
    try { fs.writeFileSync(path.join(FILES, savedAs), buf); } catch (e) {}
    const text = await pdfText(buf);
    const hasText = text.replace(/\s/g, '').length >= 20;
    let spec, ocr = null;
    if (hasText) { try { spec = await LLM.extractCoaSpec(text, subject); } catch (e) { spec = { doc_type: 'other', parameters: [], summary: 'extract error: ' + (e.message || '') }; } }
    else { try { spec = await VERTEX.ocrCoaSpec(buf, subject); ocr = spec.ocr || 'vertex'; } catch (e) { spec = { doc_type: 'other', parameters: [], summary: 'vertex OCR error: ' + (e.message || '') }; } }
    const looksLikeCoa = COA_HINT.test(a.filename || '') || COA_HINT.test(text.slice(0, 2000)) || /coa|tds|spec|msds/i.test((spec && spec.doc_type) || '');
    try {
      await coaCol.updateOne({ key }, { $setOnInsert: {
        key, messageId, fromEmail, subject, receivedAt: parsed.date || new Date(),
        filename: a.filename || savedAs, savedAs, filePath: path.join(FILES, savedAs),
        contentType: a.contentType || 'application/pdf', size: buf.length,
        textLen: text.length, text: text.slice(0, 8000), looksLikeCoa, ocr, spec, parsedAt: new Date()
      } }, { upsert: true });
      saved++;
      items.push({ filename: a.filename || savedAs, doc_type: spec && spec.doc_type, params: (spec && spec.parameters || []).length, ocr });
    } catch (e) {}
  }
  return { pdfs, saved, items };
}

module.exports = { extractAndStoreCoas };
