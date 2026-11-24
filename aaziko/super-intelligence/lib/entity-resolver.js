'use strict';
/*
 * Entity Resolution — links company names, buyers, suppliers across DBs.
 * Uses canonical key (alphanumeric only, uppercase) to match spelling variants.
 * Never modifies source data.
 */

function canonicalKey(name) {
  if (!name) return '';
  return String(name).toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
}

// Strip common legal suffixes/prefixes before entity comparison
// so "PT NIKOMAS GEMILANG" and "NIKOMAS GEMILANG" resolve to the same key
const LEGAL_SUFFIXES = [
  'COLIMITED', 'COLTD', 'LIMITED', 'LTDA', 'LTD', 'LLC', 'INC', 'CORP',
  'CORPORATION', 'GMBH', 'SARL', 'SRL', 'SAS', 'BV', 'NV', 'AG', 'PLC',
  'SADECV', 'SDERL', 'SDECV', 'DECV', 'OOO', 'SDNBHD', 'BHD',
  'COMPANY', 'CO', 'ENTERPRISES', 'ENTERPRISE', 'INDUSTRIES', 'INDUSTRY',
  'INTERNATIONAL', 'GLOBAL', 'TRADING', 'TRADE', 'GROUP',
];
const LEGAL_PREFIXES = ['PT', 'PTE', 'CV'];

function strippedLegal(name) {
  if (!name) return '';
  // Remove tax IDs / registration numbers that follow main name: "NAME CTY TNHH ..." or "NAME MST 1234..."
  let s = String(name).toUpperCase();
  // Strip everything after " CTY " or " MST " or " CO.,LTD" (common trade data garbage)
  s = s.replace(/\s+(CTY\s|MST\s|CO\.,).*/i, '');
  let key = s.replace(/[^A-Z0-9]/g, '');
  // Strip trailing legal suffixes (longest first to avoid partial strip)
  const sortedSuffixes = [...LEGAL_SUFFIXES].sort((a, b) => b.length - a.length);
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of sortedSuffixes) {
      if (key.endsWith(suf) && key.length > suf.length + 3) {
        key = key.slice(0, -suf.length);
        changed = true;
      }
    }
  }
  // Strip leading legal prefixes
  for (const pre of LEGAL_PREFIXES) {
    if (key.startsWith(pre) && key.length > pre.length + 3) {
      key = key.slice(pre.length);
    }
  }
  return key;
}

function isSameEntity(a, b, threshold = 0.75) {
  const ka = canonicalKey(a), kb = canonicalKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  // Also compare stripped names (removes legal suffixes/prefixes)
  const sa = strippedLegal(a), sb = strippedLegal(b);
  if (sa && sb && sa === sb) return true;
  // Jaccard similarity on 3-grams (use stripped keys for better matching)
  const trigrams = s => {
    const g = new Set();
    for (let i = 0; i <= s.length - 3; i++) g.add(s.slice(i, i + 3));
    return g;
  };
  // Try both raw and stripped; take max similarity
  const similarities = [[ka, kb], [sa, sb]].map(([x, y]) => {
    if (!x || !y || x.length < 3 || y.length < 3) return 0;
    const gx = trigrams(x), gy = trigrams(y);
    const union = new Set([...gx, ...gy]);
    const inter = [...gx].filter(c => gy.has(c)).length;
    return inter / union.size;
  });
  return Math.max(...similarities) >= threshold;
}

function bestName(variants) {
  // Pick the most frequent non-junk name
  const counts = {};
  for (const v of variants) {
    if (!v || typeof v !== 'string') continue;
    const k = canonicalKey(v);
    if (!k || k.length < 3) continue;
    counts[v] = (counts[v] || 0) + 1;
  }
  if (!Object.keys(counts).length) return null;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function isJunk(name) {
  if (!name) return true;
  const raw = String(name).trim();
  if (!raw || raw.length < 3) return true;
  // Long descriptive strings ("INDIVIDUALS OR ORGANIZATIONS DO NOT HAVE A TAX CODE") are never real entities
  if (raw.length > 80) return true;
  const n = raw.toUpperCase().replace(/[^A-Z]/g, '');
  if (!n || n.length < 3) return true;
  // Exact matches and common prefix patterns for placeholder / routing names
  const junks = [
    'NULL', 'NA', 'NONE', 'ORDER',
    'TOORDE', 'TOTHE', 'TOORDER', 'TOTHEORDER',  // "TO ORDE", "TO THE ...", "TO ORDER"
    'SAMEAS',                                      // "SAME AS BUYER", "SAME AS ABOVE"
    'CONSIGNEE', 'APPLICANT', 'SHIPPER',
    'INDIVIDUAL',                                  // "INDIVIDUALS OR ORGANIZATIONS..."
    'UNKNOWN', 'VARIOUS',
  ];
  return junks.some(j => n === j || n.startsWith(j));
}

/** Group an array of entities by canonical key. Returns Map<canonicalKey, Entity[]> */
function groupByCanonical(entities, nameField = 'name') {
  const groups = new Map();
  for (const e of entities) {
    const name = e[nameField];
    if (isJunk(name)) continue;
    const k = canonicalKey(name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  return groups;
}

/** Resolve a name to canonical key — for linking across DB queries */
function resolve(name) {
  return { original: name, canonical: canonicalKey(name), isJunk: isJunk(name) };
}

module.exports = { canonicalKey, strippedLegal, isSameEntity, bestName, isJunk, groupByCanonical, resolve };
