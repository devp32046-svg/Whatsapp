'use strict';
/*
 * Aaziko Trade DB Proxy — Express Router
 * Mounted in server.js as: app.use('/api/aaziko', require('./aaziko/server/query-proxy'))
 *
 * Endpoint: POST /api/aaziko/query
 * Header:   x-aaziko-secret: <AAZIKO_PROXY_SECRET from .env>
 * Body:     { db, collection, filter, limit?, projection? }
 * Returns:  { ok: true, rows: [...] }  |  { ok: false, error: "..." }
 *
 * .env keys needed:
 *   AAZIKO_TRADE_DB_URI  = mongodb://... (the 100.70.212.45 connection string)
 *   AAZIKO_PROXY_SECRET  = any strong string, same value wired into n8n HTTP nodes
 */
const express = require('express');
const { MongoClient } = require('mongodb');

const router = express.Router();

const URI    = process.env.AAZIKO_TRADE_DB_URI;
const SECRET = process.env.AAZIKO_PROXY_SECRET;

// Lazy singleton connection — reconnects once if dropped
let _client = null;
async function db(name) {
  if (!URI) throw new Error('AAZIKO_TRADE_DB_URI not set in .env');
  if (!_client || !_client.topology || !_client.topology.isConnected()) {
    _client = null;
  }
  if (!_client) {
    _client = new MongoClient(URI, { serverSelectionTimeoutMS: 10000, maxPoolSize: 5 });
    await _client.connect();
  }
  return _client.db(name);
}

// ── health check (no auth — must be BEFORE auth middleware) ─────────────────
router.get('/health', (_req, res) => {
  res.json({ ok: true, configured: !!URI && !!SECRET });
});

// ── auth middleware ──────────────────────────────────────────────────────────
router.use((req, res, next) => {
  if (!SECRET) {
    console.warn('[aaziko-proxy] AAZIKO_PROXY_SECRET not set — rejecting all requests');
    return res.status(503).json({ ok: false, error: 'proxy not configured' });
  }
  if (req.headers['x-aaziko-secret'] !== SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
});

// ── POST /query ──────────────────────────────────────────────────────────────
router.post('/query', async (req, res) => {
  console.log('[aaziko-proxy] POST /query body:', JSON.stringify(req.body).slice(0, 300));
  const { db: dbName, collection, filter = {}, limit = 20, projection } = req.body || {};

  if (!dbName || !collection) {
    return res.status(400).json({ ok: false, error: 'db and collection are required' });
  }

  try {
    const d = await db(dbName);
    const opts = {};
    if (projection) opts.projection = projection;
    const rows = await d.collection(collection)
      .find(filter, opts)
      .limit(Math.min(Number(limit) || 20, 100))
      .toArray();

    res.json({ ok: true, rows });
  } catch (e) {
    console.error('[aaziko-proxy] query error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// Global error handler — catches express.json() parse failures too
// Without this, Express sends an HTML 500 page → n8n gets "Unexpected end of JSON input"
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, _next) => {
  console.error('[aaziko-proxy] middleware error:', err.message);
  res.status(err.status || 500).json({ ok: false, error: err.message || 'Internal server error' });
});

module.exports = router;
