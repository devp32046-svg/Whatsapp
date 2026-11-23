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

function isSameEntity(a, b, threshold = 0.80) {
  const ka = canonicalKey(a), kb = canonicalKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  // Jaccard similarity on 3-grams
  const trigrams = s => {
    const g = new Set();
    for (let i = 0; i <= s.length - 3; i++) g.add(s.slice(i, i + 3));
    return g;
  };
  const ga = trigrams(ka), gb = trigrams(kb);
  const union = new Set([...ga, ...gb]);
  const inter = [...ga].filter(x => gb.has(x)).length;
  return inter / union.size >= threshold;
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

module.exports = { canonicalKey, isSameEntity, bestName, isJunk, groupByCanonical, resolve };
