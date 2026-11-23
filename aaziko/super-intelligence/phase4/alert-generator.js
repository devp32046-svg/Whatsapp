'use strict';
/*
 * Phase 4 — Alert Generator
 * Takes scored opportunities + detected anomalies from phases 3+4 and
 * generates a prioritized, actionable alert feed.
 *
 * Alert priorities: CRITICAL > HIGH > MEDIUM > LOW
 * Each alert carries: id, priority, type, headline, evidence summary,
 * affected entities, recommended action, expiry hint.
 *
 * Run: node phase4/alert-generator.js --hs 690810
 */
const path = require('path');
const fs   = require('fs');
const { runOpportunityScorer } = require('./opportunity-scorer');
const { runAnomalyDetector }   = require('./anomaly-detector');
const { trackHsCodePrice }     = require('../phase3/commodity-tracker');
const { screenTransaction }    = require('../phase3/sanctions-checker');
const db                       = require('../lib/db');

const ALERT_TYPES = {
  OPPORTUNITY:  'Trade opportunity identified',
  ANOMALY:      'Unusual trade pattern detected',
  PRICE_SIGNAL: 'Commodity price movement',
  COMPLIANCE:   'Compliance / sanctions flag',
  MARKET_SHIFT: 'Significant market structure change',
};

const PRIORITY_ORDER = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

function makeAlertId(type, seed) {
  const ts = Date.now().toString(36);
  const s  = String(seed || '').slice(0, 8).replace(/\W/g, '');
  return `alert_${type.slice(0, 4).toLowerCase()}_${s}_${ts}`;
}

function opportunityToAlert(opp) {
  const score = opp.score || 0;
  const priority = score >= 0.75 ? 'HIGH' : score >= 0.5 ? 'MEDIUM' : 'LOW';

  return {
    alertId: makeAlertId('OPPORTUNITY', opp.opportunityId),
    priority,
    type: 'OPPORTUNITY',
    headline: `${opp.type}: ${opp.entity || opp.hsCodes?.join(',')} (score ${(score * 100).toFixed(0)}/100)`,
    summary: opp.typeDesc || '',
    affectedEntities: opp.entity ? [opp.entity] : [],
    hsCodes: opp.hsCodes || [],
    evidence: opp.evidence || {},
    opportunityScore: score,
    confidence: opp.confidence || 'UNKNOWN',
    recommendedAction: opp.recommendedAction || 'Review opportunity details',
    requiresHumanVerification: opp.requiresHumanVerification !== false,
    expiresHint: '30 days',
    sourceModule: 'opportunity-scorer',
    generatedAt: new Date().toISOString(),
  };
}

function anomalyToAlert(anomaly) {
  const sevMap = { CRITICAL: 'CRITICAL', HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' };
  const priority = sevMap[anomaly.severity] || 'MEDIUM';

  return {
    alertId: makeAlertId('ANOMALY', anomaly.anomalyId),
    priority,
    type: 'ANOMALY',
    headline: `${anomaly.type}: ${(anomaly.entities || []).join(' ↔ ')}`,
    summary: anomaly.description || '',
    affectedEntities: anomaly.entities || [],
    hsCodes: anomaly.evidence?.hsCodes || [],
    evidence: anomaly.evidence || {},
    requiresHumanVerification: anomaly.requiresHumanReview !== false,
    recommendedAction: priority === 'CRITICAL'
      ? 'Immediate compliance review required'
      : priority === 'HIGH'
        ? 'Investigate with compliance team before transacting'
        : 'Monitor; flag if pattern persists',
    expiresHint: priority === 'CRITICAL' ? '24 hours' : '7 days',
    sourceModule: 'anomaly-detector',
    generatedAt: new Date().toISOString(),
  };
}

function priceSignalToAlert(priceData) {
  if (!priceData || !priceData.trend || priceData.trend === 'FLAT') return null;
  const priority = Math.abs(priceData.pctChange || 0) > 30 ? 'HIGH' : 'MEDIUM';

  return {
    alertId: makeAlertId('PRICE', priceData.hs),
    priority,
    type: 'PRICE_SIGNAL',
    headline: `HS ${priceData.hs}: Price ${priceData.trend} ${priceData.pctChange > 0 ? '+' : ''}${priceData.pctChange || 0}%`,
    summary: `Unit price moved from $${priceData.historicalPrice?.mean || 'N/A'} to $${priceData.currentPrice?.mean || 'N/A'}`,
    affectedEntities: [],
    hsCodes: [priceData.hs],
    evidence: {
      trend: priceData.trend,
      pctChange: priceData.pctChange,
      currentMeanPrice: priceData.currentPrice?.mean,
      historicalMeanPrice: priceData.historicalPrice?.mean,
      recordCount: priceData.recordCount,
    },
    requiresHumanVerification: false,
    recommendedAction: priceData.trend === 'RISING'
      ? 'Consider locking in supply contracts before prices rise further'
      : 'Potential margin compression — review buyer pricing agreements',
    expiresHint: '14 days',
    sourceModule: 'commodity-tracker',
    generatedAt: new Date().toISOString(),
  };
}

function complianceToAlert(screening, context) {
  if (!screening || screening.overallRisk === 'LOW') return null;
  const priorityMap = { CRITICAL: 'CRITICAL', HIGH: 'HIGH', MEDIUM: 'MEDIUM' };

  return {
    alertId: makeAlertId('COMPLIANCE', context?.exporterName || context?.importerName || ''),
    priority: priorityMap[screening.overallRisk] || 'MEDIUM',
    type: 'COMPLIANCE',
    headline: `Compliance flag: ${screening.overallRisk} risk — ${(screening.findings || []).map(f => f.type).join(', ')}`,
    summary: screening.disclaimer || '',
    affectedEntities: [context?.exporterName, context?.importerName].filter(Boolean),
    hsCodes: context?.hsCodes || [],
    evidence: { findings: screening.findings, overallRisk: screening.overallRisk },
    requiresHumanVerification: true,
    recommendedAction: 'Do not proceed without legal/compliance sign-off. Verify against official OFAC/EU/UN/BIS lists.',
    expiresHint: '48 hours',
    sourceModule: 'sanctions-checker',
    generatedAt: new Date().toISOString(),
  };
}

/** Deduplicate alerts — same type + same primary entity = keep highest priority */
function deduplicateAlerts(alerts) {
  const seen = new Map();
  for (const a of alerts) {
    const key = `${a.type}|${(a.affectedEntities || []).sort().join('|')}|${(a.hsCodes || []).join(',')}`;
    const existing = seen.get(key);
    if (!existing || PRIORITY_ORDER[a.priority] > PRIORITY_ORDER[existing.priority]) {
      seen.set(key, a);
    }
  }
  return [...seen.values()];
}

async function generateAlerts({ hs, entityName, originCountry = 'IN', limit = 100 } = {}) {
  const rawAlerts = [];

  // 1. Opportunities
  if (hs || entityName) {
    console.log('Running opportunity scorer...');
    try {
      const oppReport = await runOpportunityScorer({ hs, originCountry, limit: 50 });
      for (const opp of oppReport.opportunities || []) rawAlerts.push(opportunityToAlert(opp));
    } catch (e) {
      console.warn('  Opportunity scorer error:', e.message);
    }
  }

  // 2. Anomalies
  console.log('Running anomaly detector...');
  try {
    const anomReport = await runAnomalyDetector({ hs, entityName, limit });
    for (const a of anomReport.anomalies || []) rawAlerts.push(anomalyToAlert(a));
  } catch (e) {
    console.warn('  Anomaly detector error:', e.message);
  }

  // 3. Price signal
  if (hs) {
    console.log('Checking price signals...');
    try {
      const priceData = await trackHsCodePrice(hs, { limit: 500 });
      const priceAlert = priceSignalToAlert(priceData);
      if (priceAlert) rawAlerts.push(priceAlert);
    } catch (e) {
      console.warn('  Price tracker error:', e.message);
    }
  }

  const alerts = deduplicateAlerts(rawAlerts);
  alerts.sort((a, b) => {
    const pd = PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority];
    return pd !== 0 ? pd : (b.opportunityScore || 0) - (a.opportunityScore || 0);
  });

  const report = {
    generatedAt: new Date().toISOString(),
    parameters: { hs, entityName, originCountry },
    alerts,
    summary: {
      total: alerts.length,
      byPriority: alerts.reduce((m, x) => { m[x.priority] = (m[x.priority] || 0) + 1; return m; }, {}),
      byType: alerts.reduce((m, x) => { m[x.type] = (m[x.type] || 0) + 1; return m; }, {}),
      requiresHumanVerification: alerts.filter(x => x.requiresHumanVerification).length,
    },
  };

  const outPath = path.resolve(__dirname, '../reports/alerts.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) {
  const hsIdx = process.argv.indexOf('--hs');
  const hs = hsIdx >= 0 ? process.argv[hsIdx + 1] : null;
  const eIdx = process.argv.indexOf('--entity');
  const entityName = eIdx >= 0 ? process.argv[eIdx + 1] : null;

  if (!hs && !entityName) {
    console.error('Usage: node alert-generator.js --hs 690810 [--entity "COMPANY NAME"]');
    process.exit(1);
  }

  generateAlerts({ hs, entityName, limit: 500 })
    .then(r => {
      console.log(`\n=== ALERT FEED (${r.alerts.length} alerts) ===`);
      console.log(`By priority: ${JSON.stringify(r.summary.byPriority)}`);
      r.alerts.slice(0, 8).forEach((a, i) =>
        console.log(`${i + 1}. [${a.priority}] ${a.type}: ${a.headline}`));
      console.log(`\nFull report: reports/alerts.json`);
    })
    .catch(e => { console.error('FAILED:', e.message); process.exit(1); })
    .finally(() => db.close());
}

module.exports = { generateAlerts, opportunityToAlert, anomalyToAlert,
  priceSignalToAlert, complianceToAlert, deduplicateAlerts };
