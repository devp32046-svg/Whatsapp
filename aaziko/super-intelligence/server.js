'use strict';
/*
 * Aaziko Super Intelligence — HTTP API Server
 * Runs all phases on-demand via REST endpoints.
 *
 * Usage: node server.js [--port 3030]
 *
 * Endpoints:
 *   GET  /health
 *   POST /phase1/inventory        { priorityOnly: true }
 *   POST /phase1/entity-map       {}
 *   POST /phase2/profile          { entityName: "...", includeShipments: false }
 *   POST /phase2/classify         { entityName: "..." }
 *   POST /phase3/news             { categories: [...] }
 *   POST /phase3/sanctions        { exporterName, importerName, exporterCountry, importerCountry, hsCodes }
 *   POST /phase3/commodity        { hs: "690810" }
 *   POST /phase4/opportunities    { hs: "690810", originCountry: "IN" }
 *   POST /phase4/anomalies        { hs: "690810", entityName: "..." }
 *   POST /phase4/alerts           { hs: "690810", entityName: "..." }
 *   POST /phase5/backtest         { hs: "690810", threshold: 65 }
 *   POST /phase5/calibrate        { hs: "690810" }
 *   GET  /reports/:name           returns saved JSON report
 */
const http = require('http');
const path = require('path');
const fs   = require('fs');

// Lazy-require phases to avoid crashing if DB is unavailable at startup
const ROUTES = {
  'POST /phase1/inventory':     () => require('./phase1/inventory').runInventory,
  'POST /phase1/entity-map':    () => require('./phase1/entity-map').buildEntityMap,
  'POST /phase2/profile':       () => require('./phase2/entity-profiler').buildProfile,
  'POST /phase2/classify':      () => require('./phase2/behavior-classifier').classifyEntity,
  'POST /phase3/news':          () => require('./phase3/news-monitor').runNewsMonitor,
  'POST /phase3/sanctions':     () => require('./phase3/sanctions-checker').screenTransaction,
  'POST /phase3/commodity':     () => require('./phase3/commodity-tracker').trackHsCodePrice,
  'POST /phase4/opportunities': () => require('./phase4/opportunity-scorer').runOpportunityScorer,
  'POST /phase4/anomalies':     () => require('./phase4/anomaly-detector').runAnomalyDetector,
  'POST /phase4/alerts':        () => require('./phase4/alert-generator').generateAlerts,
  'POST /phase5/backtest':      () => require('./phase5/backtester').runBacktest,
  'POST /phase5/calibrate':     () => require('./phase5/calibrator').calibrate,
};

const REPORTS_DIR = path.resolve(__dirname, 'reports');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

async function handleRequest(req, res) {
  const rawUrl = req.url || '/';
  const method = req.method || 'GET';
  const [pathname, queryString] = rawUrl.split('?');

  // Health check
  if (method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, { status: 'ok', ts: new Date().toISOString() });
  }

  // Report download
  if (method === 'GET' && pathname.startsWith('/reports/')) {
    const name = path.basename(pathname.replace('/reports/', ''));
    if (!/^[\w-]+\.json$/.test(name)) return sendJson(res, 400, { error: 'Invalid report name' });
    const fPath = path.join(REPORTS_DIR, name);
    if (!fs.existsSync(fPath)) return sendJson(res, 404, { error: 'Report not found' });
    const data = fs.readFileSync(fPath, 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(data);
    return;
  }

  // Phase routes — accept GET with query params OR POST with JSON body
  // GET /phase4/alerts?hs=5201  ≡  POST /phase4/alerts  {"hs":"5201"}
  const postKey  = `POST ${pathname}`;
  const getKey   = `GET ${pathname}`;
  const routeKey = postKey;           // used in error handler below
  const handler  = ROUTES[postKey] || ROUTES[getKey];
  if (!handler) return sendJson(res, 404, { error: `Route not found: ${method} ${pathname}` });

  let body;
  if (method === 'GET') {
    // Parse query string into body object
    body = queryString
      ? Object.fromEntries(new URLSearchParams(queryString).entries())
      : {};
  } else {
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }

  try {
    const fn = handler();
    // Map body fields to function parameters based on route
    let result;
    if (routeKey === 'POST /phase2/profile') {
      result = await fn(body.entityName, { includeShipments: body.includeShipments });
    } else if (routeKey === 'POST /phase2/classify') {
      result = await fn(body.entityName);
    } else if (routeKey === 'POST /phase3/commodity') {
      const { trackHsCodePrice } = require('./phase3/commodity-tracker');
      result = await trackHsCodePrice(body.hs || body.hsCodes?.[0], { originCountry: body.originCountry, limit: 500 });
    } else {
      result = await fn(body);
    }
    sendJson(res, 200, result);
  } catch (e) {
    console.error(`Error on ${routeKey}:`, e.message);
    sendJson(res, 500, { error: e.message, route: routeKey });
  }
}

const PORT = (() => {
  const pIdx = process.argv.indexOf('--port');
  return pIdx >= 0 ? parseInt(process.argv[pIdx + 1], 10) : (process.env.SI_PORT ? parseInt(process.env.SI_PORT, 10) : 3030);
})();

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`\nAaziko Super Intelligence API — listening on http://localhost:${PORT}`);
  console.log(`Health: GET  http://localhost:${PORT}/health`);
  console.log(`Example: POST http://localhost:${PORT}/phase4/alerts  {"hs":"690810"}`);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });

module.exports = { server };
