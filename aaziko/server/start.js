'use strict';
/*
 * Aaziko Trade Proxy Server — STANDALONE, completely separate from CGPE server.js
 *
 * Start:   node aaziko/server/start.js
 * Port:    AAZIKO_PROXY_PORT from .env (default 4001)
 * Health:  http://localhost:4001/health
 * Query:   POST http://localhost:4001/query  (x-aaziko-secret header required)
 *
 * n8n tools call: http://host.docker.internal:4001/query
 */
require('dotenv').config();
const express = require('express');
const proxy   = require('./query-proxy');

const PORT = process.env.AAZIKO_PROXY_PORT || 4001;

const app = express();
app.use(express.json({ limit: '1mb' }));

// All routes handled by the proxy module
app.use('/', proxy);

// 404 fallback
app.use((_req, res) => res.status(404).json({ ok: false, error: 'not found' }));

app.listen(PORT, () => {
  console.log('[Aaziko Proxy] Running on port ' + PORT);
  console.log('[Aaziko Proxy] Trade DB URI: ' + (process.env.AAZIKO_TRADE_DB_URI ? 'SET ✅' : 'MISSING ❌'));
  console.log('[Aaziko Proxy] Secret:       ' + (process.env.AAZIKO_PROXY_SECRET ? 'SET ✅' : 'MISSING ❌'));
  console.log('[Aaziko Proxy] Health check: http://localhost:' + PORT + '/health');
});
