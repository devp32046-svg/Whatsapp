'use strict';
/*
 * Phase 3 — Sanctions & Compliance Checker
 * Checks entity names against known high-risk patterns, country-level sanctions,
 * and detected anomalies. This is a SCREENING tool — not a legal determination.
 * Always requires human review before any adverse action.
 *
 * Note: Does NOT use a live sanctions API (would require paid credentials).
 * Uses rule-based patterns + country risk tiers from public FATF/EU/UN frameworks.
 * Run: node phase3/sanctions-checker.js "ROSOBORONEXPORT" RU
 */

// Country risk tiers (source: FATF/EU/UN framework — updated periodically)
// TIER 1 = Highest risk; TIER 4 = Standard risk
const COUNTRY_RISK = {
  // TIER 1: Heavily sanctioned / highest risk
  IR: { tier: 1, name: 'Iran', regimes: ['US-OFAC', 'EU', 'UN'] },
  KP: { tier: 1, name: 'North Korea', regimes: ['US-OFAC', 'EU', 'UN'] },
  RU: { tier: 1, name: 'Russia', regimes: ['US-OFAC', 'EU', 'UK'] },
  BY: { tier: 1, name: 'Belarus', regimes: ['US-OFAC', 'EU'] },
  SY: { tier: 1, name: 'Syria', regimes: ['US-OFAC', 'EU', 'UN'] },
  MM: { tier: 1, name: 'Myanmar', regimes: ['US-OFAC', 'EU', 'UK'] },
  // TIER 2: High-risk / FATF grey list (selected)
  PK: { tier: 2, name: 'Pakistan', regimes: ['FATF-grey'] },
  YE: { tier: 2, name: 'Yemen', regimes: ['UN-arms-embargo'] },
  LY: { tier: 2, name: 'Libya', regimes: ['UN-arms-embargo'] },
  SD: { tier: 2, name: 'Sudan', regimes: ['US-OFAC', 'UN'] },
  SS: { tier: 2, name: 'South Sudan', regimes: ['UN-arms-embargo'] },
  // TIER 3: Elevated / monitoring
  CN: { tier: 3, name: 'China', regimes: ['US-BIS-entity-list-active'] },
  VE: { tier: 3, name: 'Venezuela', regimes: ['US-OFAC-limited'] },
  CU: { tier: 3, name: 'Cuba', regimes: ['US-OFAC'] },
  // TIER 4 = Standard (all others)
};

// Name patterns that frequently appear in SDN / entity lists
const HIGH_RISK_NAME_PATTERNS = [
  /^(ROSOBORON|ROSTEC|VNESHECONOMBANK|VTB |SBERBANK|GAZPROM|LUKOIL|NOVATEK)/i,
  /\b(IRGC|MOIS|QUDS|HEZBOLLAH|HAMAS|ISLAMIC REVOLUTIONARY)\b/i,
  /\b(PYONGYANG|KORYO|CHEIL|DAESONG|TANCHON)\b/i,
  /\b(WAGNER|PMC WAGNER)\b/i,
];

// HS codes with heightened export control concern (dual-use / military potential)
const CONTROLLED_HS_PATTERNS = [
  { pattern: /^(84|85|90)/, category: 'dual_use_machinery_electronics', note: 'Requires BIS/DGFT check for restricted destinations' },
  { pattern: /^293/, category: 'chemicals', note: 'Chemical weapons convention — verify end-use' },
  { pattern: /^(93)/, category: 'arms_ammunition', note: 'Requires specific export license' },
  { pattern: /^(28|29)/, category: 'industrial_chemicals', note: 'Potential precursor — check end-user' },
];

function checkCountry(isoCode) {
  if (!isoCode) return { riskTier: 4, flagged: false };
  const country = COUNTRY_RISK[isoCode.toUpperCase()];
  if (!country) return { riskTier: 4, flagged: false };
  return {
    riskTier: country.tier,
    flagged: country.tier <= 2,
    countryName: country.name,
    regimes: country.regimes,
    note: country.tier === 1
      ? 'HEAVILY_SANCTIONED — verify all shipments; likely requires license or is prohibited'
      : 'ELEVATED_RISK — enhanced due diligence required',
  };
}

function checkEntityName(name) {
  if (!name) return { flagged: false };
  const flags = [];
  for (const pat of HIGH_RISK_NAME_PATTERNS) {
    if (pat.test(name)) flags.push(`NAME_MATCHES_SDN_PATTERN:${pat.source.slice(0, 40)}`);
  }
  return {
    flagged: flags.length > 0,
    flags,
    note: flags.length ? 'POSSIBLE_SDN_MATCH — verify against OFAC/EU/UN lists before transacting' : null,
  };
}

function checkHsCode(hs) {
  if (!hs) return { flagged: false };
  const hs6 = String(hs).slice(0, 6);
  const hits = CONTROLLED_HS_PATTERNS.filter(c => c.pattern.test(hs6));
  return {
    flagged: hits.length > 0,
    controlledCategories: hits.map(h => ({ category: h.category, note: h.note })),
  };
}

/** Comprehensive screening for a transaction */
function screenTransaction({ exporterName, importerName, exporterCountry, importerCountry, hsCodes = [] }) {
  const findings = [];
  let maxRisk = 'LOW';

  const riskOrder = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  const raiseRisk = level => {
    if (riskOrder.indexOf(level) > riskOrder.indexOf(maxRisk)) maxRisk = level;
  };

  // Check countries
  for (const [role, iso] of [['exporter', exporterCountry], ['importer', importerCountry]]) {
    if (!iso) continue;
    const r = checkCountry(iso);
    if (r.flagged) {
      findings.push({ type: 'COUNTRY_RISK', role, country: iso, detail: r.note, regimes: r.regimes });
      raiseRisk(r.riskTier === 1 ? 'CRITICAL' : 'HIGH');
    }
  }

  // Check entity names
  for (const [role, name] of [['exporter', exporterName], ['importer', importerName]]) {
    if (!name) continue;
    const r = checkEntityName(name);
    if (r.flagged) {
      findings.push({ type: 'NAME_PATTERN', role, name, flags: r.flags, note: r.note });
      raiseRisk('HIGH');
    }
  }

  // Check HS codes
  for (const hs of hsCodes) {
    const r = checkHsCode(hs);
    if (r.flagged) {
      findings.push({ type: 'CONTROLLED_HS', hs, categories: r.controlledCategories });
      raiseRisk('MEDIUM');
    }
  }

  return {
    overallRisk: maxRisk,
    requiresHumanReview: maxRisk !== 'LOW',
    findings,
    disclaimer: 'This is a screening indicator only. VERIFY against official OFAC/EU/UN/BIS lists before any adverse action.',
    screenedAt: new Date().toISOString(),
  };
}

if (require.main === module) {
  const name = process.argv[2] || 'TEST COMPANY';
  const country = process.argv[3] || 'IN';
  console.log(`\nScreening: "${name}" (${country})`);
  const result = screenTransaction({ importerName: name, importerCountry: country, hsCodes: ['854231'] });
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { checkCountry, checkEntityName, checkHsCode, screenTransaction, COUNTRY_RISK };
