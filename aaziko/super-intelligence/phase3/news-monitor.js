'use strict';
/*
 * Phase 3 — News & Events Monitor
 * Fetches recent trade-relevant news via web search and structures it for the
 * Event/Opportunity Analysis pipeline. Source: web search results (no paid API needed).
 *
 * Event categories monitored: sanctions, tariffs, trade agreements, geopolitical events,
 * commodity shortages, port closures, shipping disruptions.
 *
 * Run: node phase3/news-monitor.js --query "India export ban 2024"
 */
const https = require('https');
const path  = require('path');
const fs    = require('fs');

// Event categories and their search keywords
const EVENT_CATEGORIES = {
  sanctions:        ['sanctions', 'export ban', 'trade restriction', 'embargo'],
  tariffs:          ['import duty', 'anti-dumping', 'countervailing duty', 'tariff hike'],
  trade_agreements: ['FTA', 'free trade agreement', 'trade deal signed', 'RCEP', 'CECA'],
  geopolitical:     ['ceasefire', 'war', 'conflict', 'blockade', 'maritime threat'],
  commodity:        ['commodity shortage', 'supply disruption', 'price spike', 'stockpile'],
  shipping:         ['port closure', 'shipping delay', 'freight rate', 'vessel diversion', 'Red Sea'],
  regulatory:       ['import regulation', 'BIS license', 'customs rule change', 'DGFT notification'],
};

// Impact classification
const IMPACT_KEYWORDS = {
  critical: ['ban', 'shutdown', 'halt', 'blockade', 'seizure', 'embargo'],
  high:     ['restrict', 'sanction', 'tariff', 'duty increase', 'shortage', 'disruption'],
  medium:   ['investigate', 'review', 'propose', 'consider', 'monitor'],
  low:      ['study', 'report', 'discuss', 'explore'],
};

function classifyImpact(text) {
  const t = (text || '').toLowerCase();
  for (const [level, keywords] of Object.entries(IMPACT_KEYWORDS)) {
    if (keywords.some(k => t.includes(k))) return level;
  }
  return 'low';
}

function extractAffectedCountries(text) {
  const COUNTRY_PATTERNS = [
    /\b(India|China|USA|US|Russia|Ukraine|UAE|Saudi Arabia|Germany|UK|Brazil|South Korea|Japan|Indonesia|Vietnam|Bangladesh|Turkey|Iran|Pakistan)\b/g,
  ];
  const found = new Set();
  for (const pat of COUNTRY_PATTERNS) {
    const matches = (text || '').match(pat) || [];
    matches.forEach(m => found.add(m));
  }
  return [...found];
}

function extractAffectedProducts(text) {
  const PRODUCT_PATTERNS = [
    /\b(steel|cement|wheat|rice|sugar|cotton|leather|chemicals?|fertilizer|crude oil|natural gas|semiconductors?|electronics|textiles?|pharmaceuticals?|ceramics?|marble|granite|aluminium|copper|zinc)\b/gi,
  ];
  const found = new Set();
  for (const pat of PRODUCT_PATTERNS) {
    const matches = (text || '').match(pat) || [];
    matches.forEach(m => found.add(m.toLowerCase()));
  }
  return [...found];
}

function structureNewsItem(raw, category) {
  const { title = '', snippet = '', url = '', date = '' } = raw;
  const text = `${title} ${snippet}`;
  return {
    id: `news_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    category,
    title,
    snippet,
    url,
    publishedAt: date || null,
    retrievedAt: new Date().toISOString(),
    sourceType: 'web_search',
    sourceReliability: 'secondary', // web search results are secondary sources
    impact: classifyImpact(text),
    affectedCountries: extractAffectedCountries(text),
    affectedProducts: extractAffectedProducts(text),
    isConfirmed: false, // requires human or second-source verification
    verificationStatus: 'UNVERIFIED',
  };
}

/** Minimal HTTPS GET helper — returns body as string */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET',
      headers: { 'User-Agent': 'AazikoSuperIntelligence/1.0 (trade research bot)' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

/** Fetch news via DuckDuckGo Lite (no API key needed) */
async function fetchNewsViaSearch(query, { limit = 10 } = {}) {
  const encoded = encodeURIComponent(query);
  try {
    const body = await httpsGet(`https://html.duckduckgo.com/html/?q=${encoded}&ia=news`);
    const results = [];
    const linkRe = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
    const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([^<]+)<\/a>/g;
    const links = [], snippets = [];
    let m;
    while ((m = linkRe.exec(body)) !== null && links.length < limit) links.push({ url: m[1], title: m[2].trim() });
    while ((m = snippetRe.exec(body)) !== null && snippets.length < limit) snippets.push(m[1].trim());
    for (let i = 0; i < Math.min(links.length, limit); i++) {
      results.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] || '' });
    }
    return results;
  } catch (e) {
    return [];
  }
}

async function monitorCategory(category, keywords, { limit = 5 } = {}) {
  const query = keywords.slice(0, 2).join(' OR ') + ' trade 2024 2025';
  const rawResults = await fetchNewsViaSearch(query, { limit });
  return rawResults.map(r => structureNewsItem(r, category));
}

async function runNewsMonitor({ categories = null, limit = 5, outFile = null } = {}) {
  const toMonitor = categories
    ? Object.fromEntries(Object.entries(EVENT_CATEGORIES).filter(([k]) => categories.includes(k)))
    : EVENT_CATEGORIES;

  const report = { generatedAt: new Date().toISOString(), events: [], summary: {} };

  for (const [category, keywords] of Object.entries(toMonitor)) {
    console.log(`Monitoring: ${category}...`);
    const items = await monitorCategory(category, keywords, { limit });
    report.events.push(...items);
    report.summary[category] = {
      count: items.length,
      critical: items.filter(x => x.impact === 'critical').length,
      high: items.filter(x => x.impact === 'high').length,
    };
    if (items.length) console.log(`  Found ${items.length} items (critical: ${report.summary[category].critical}, high: ${report.summary[category].high})`);
  }

  report.events.sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    return (order[a.impact] || 3) - (order[b.impact] || 3);
  });

  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log(`\nNews monitor report: ${outFile}`);
  }

  return report;
}

if (require.main === module) {
  const qIdx = process.argv.indexOf('--query');
  if (qIdx >= 0) {
    const q = process.argv[qIdx + 1];
    fetchNewsViaSearch(q, { limit: 10 })
      .then(results => results.forEach((r, i) => console.log(`${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}\n`)))
      .catch(e => console.error('FAILED:', e.message));
  } else {
    const outPath = path.resolve(__dirname, '../reports/news-monitor.json');
    runNewsMonitor({ limit: 5, outFile: outPath })
      .then(r => console.log(`\nTotal events: ${r.events.length} | Critical: ${r.events.filter(x => x.impact === 'critical').length}`))
      .catch(e => { console.error('FAILED:', e.message); process.exit(1); });
  }
}

module.exports = { runNewsMonitor, fetchNewsViaSearch, structureNewsItem, EVENT_CATEGORIES, classifyImpact };
