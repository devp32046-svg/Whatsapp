'use strict';
/*
 * fix-hs-synonyms.js
 * Adds synonym expansion to find_hs_code so common words map to HS terminology.
 * e.g. "shoes" → footwear, "shirt" → apparel, "phone" → telephone
 *
 * Usage:
 *   node aaziko/brain/deploy/fix-hs-synonyms.js          # dry-run
 *   node aaziko/brain/deploy/fix-hs-synonyms.js --write  # deploy
 */
require('dotenv').config();
const { getWf, putWf, activate } = require('../../../scripts/lib/n8n-req');
const https = require('https');

const WRITE = process.argv.includes('--write');

const PARSE_CODE = `
let inp = {};
try {
  inp = typeof $input.first().json === 'string'
    ? JSON.parse($input.first().json)
    : $input.first().json;
} catch(e) {}

var query = String(inp.query || inp.product || inp.keyword || '').trim();
var limit = Math.min(parseInt(inp.limit || 10, 10), 20);

if (!query || query.length < 2) {
  return [{ json: { pipelineStr: '[]', query: '', error: 'Product description ya keyword zaroori hai (min 2 chars)' } }];
}

// Synonym map: user word → HS description term(s)
var SYNONYMS = {
  shoes: ['footwear'], sandals: ['footwear'], boots: ['footwear'],
  sneakers: ['footwear'], heels: ['footwear'], chappal: ['footwear'],
  shirt: ['apparel','garment','jersey'], tshirt: ['apparel','jersey'],
  pants: ['trousers','breeches'], jeans: ['trousers','denim'],
  jacket: ['outerwear','anorak','windcheater'], coat: ['overcoat','cloak'],
  bag: ['handbag','suitcase','luggage'], purse: ['handbag'],
  phone: ['telephone','handset'], mobile: ['telephone','handset'],
  tv: ['television','receiver'], television: ['television','receiver'],
  computer: ['computer','data processing','laptop'],
  laptop: ['computer','data processing'],
  car: ['motor vehicle','automobile','passenger car'],
  bike: ['motorcycle','bicycle'], cycle: ['bicycle'],
  medicine: ['pharmaceutical','medicament','drug'],
  drug: ['pharmaceutical','medicament'],
  rice: ['rice','paddy'], wheat: ['wheat','grain'],
  sugar: ['sugar','sucrose'], salt: ['salt','sodium chloride'],
  milk: ['milk','dairy','whey'], cheese: ['cheese','curd'],
  chicken: ['poultry','fowl'], fish: ['fish','seafood'],
  cotton: ['cotton'], wool: ['wool','fleece'],
  silk: ['silk'], linen: ['flax','linen'],
  leather: ['leather','hide','skin'],
  plastic: ['plastic','polymer','polyethylene','polypropylene'],
  rubber: ['rubber','vulcanised'],
  wood: ['wood','timber','lumber'], paper: ['paper','paperboard'],
  steel: ['steel','iron'], aluminium: ['aluminium','aluminum'],
  gold: ['gold'], silver: ['silver'], diamond: ['diamond'],
  oil: ['oil','petroleum','lubricant'], petrol: ['petroleum','motor spirit'],
  fertilizer: ['fertilizer','urea','ammonium'],
  cement: ['cement','clinker'],
  glass: ['glass'], ceramic: ['ceramic','porcelain'],
  battery: ['battery','accumulator','cell'],
  motor: ['motor','engine','generator'],
  pump: ['pump'], valve: ['valve'],
  wire: ['wire','cable','conductor'],
  furniture: ['furniture','chair','table','mattress'],
  carpet: ['carpet','rug','mat'], curtain: ['curtain','drape'],
  toy: ['toy','game'], doll: ['doll'],
  watch: ['watch','clock','timepiece'],
  spectacles: ['spectacles','eyewear','lenses','goggles'],
  umbrella: ['umbrella','parasol'],
  candle: ['candle','wax'], soap: ['soap','detergent'],
  perfume: ['perfume','fragrance','cosmetic'],
  paint: ['paint','varnish','lacquer'],
  ink: ['ink','toner'],
  tools: ['tool','hand tool','drill','saw','spanner'],
  gun: ['firearm','pistol','rifle','weapon'],
  ammunition: ['ammunition','cartridge','bullet']
};

// Generic words that don't narrow HS search — drop from AND chain
var STOP = { raw:1, material:1, product:1, item:1, good:1, goods:1, type:1, kind:1,
             fresh:1, used:1, old:1, new:1, big:1, small:1, large:1, fine:1,
             pure:1, mixed:1, other:1, made:1, ka:1, ke:1, ki:1, hai:1, aur:1,
             the:1, of:1, for:1, and:1, or:1, in:1, to:1, with:1 };

// Expand each word through synonym map, then:
// - single word  → OR of its synonyms
// - multi-word   → AND across concepts (each concept = OR of its synonyms)
//   stop words are dropped from the AND chain
var rawWords = query.toLowerCase().split(/\\s+/)
  .filter(function(w) { return w.length > 1 && !STOP[w]; });

var expandedConcepts = rawWords.map(function(w) {
  return SYNONYMS[w] ? SYNONYMS[w] : [w];
});

var allExpanded = [];
expandedConcepts.forEach(function(c) {
  c.forEach(function(t) { if (allExpanded.indexOf(t) < 0) allExpanded.push(t); });
});

var matchFilter = { status: 'active' };
if (expandedConcepts.length > 1) {
  // AND across concepts, OR within each concept
  matchFilter['$and'] = expandedConcepts.map(function(terms) {
    return { description: { $regex: terms.join('|'), $options: 'i' } };
  });
} else {
  var terms = expandedConcepts[0] || [query];
  matchFilter['description'] = { $regex: terms.join('|'), $options: 'i' };
}

var pipeline = [
  { $match: matchFilter },
  { $project: { hsCode: 1, description: 1, _id: 0 } },
  { $sort: { hsCode: 1 } },
  { $limit: limit }
];

return [{ json: { pipelineStr: JSON.stringify(pipeline), query: query, expandedTerms: allExpanded, limit: limit } }];
`.trim();

const FORMAT_CODE = `
var ctx  = $('Parse Input').first().json;
var rows = $input.all().map(function(i) { return i.json; });

if (ctx.error) {
  return [{ json: { output: 'Product ka naam ya description dena zaroori hai. Example: "cotton", "leather shoes", "rice".' } }];
}

if (!rows.length) {
  return [{ json: { output: '"' + ctx.query + '" ke liye koi HS code nahi mila. Koi aur keyword try karein.' } }];
}

var lines = rows.map(function(r, i) {
  return (i + 1) + '. HS ' + r.hsCode + ' — ' + r.description;
});

var expanded = ctx.expandedTerms && ctx.expandedTerms.join(', ');
var note = expanded && expanded !== ctx.query.toLowerCase()
  ? ' (searched: ' + expanded + ')'
  : '';

return [{ json: {
  output: 'HS codes for "' + ctx.query + '"' + note + ':\\n' + lines.join('\\n') +
    '\\n\\nIs HS code ke buyers ya market summary ke liye puchein.'
} }];
`.trim();

function apiReq(method, ep, body) {
  return new Promise((res, rej) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = https.request({
      hostname: 'ai.cgpe.in', path: '/api/v1' + ep, method,
      headers: { 'X-N8N-API-KEY': process.env.N8N_API_KEY, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': data.length } : {}) }
    }, r => { const ch = []; r.on('data', c => ch.push(c)); r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(ch).toString('utf8') })); });
    req.on('error', rej); if (data) req.write(data); req.end();
  });
}

(async () => {
  console.log('\n=== Fix find_hs_code: synonym map ===');
  console.log(WRITE ? '[LIVE DEPLOY]' : '[DRY-RUN — pass --write to deploy]');
  if (!WRITE) { console.log('Run with --write to deploy.'); return; }

  const listR  = await apiReq('GET', '/workflows?limit=250');
  const allWfs = JSON.parse(listR.body).data || [];
  const exist  = allWfs.find(w => w.name === 'Tool: find_hs_code');
  if (!exist) { console.error('Sub-wf not found'); return; }

  const wf = await getWf(exist.id);
  const parseNode = wf.nodes.find(n => n.name === 'Parse Input');
  const fmtNode   = wf.nodes.find(n => n.name === 'Format Results');
  if (!parseNode || !fmtNode) { console.error('Nodes not found'); return; }

  parseNode.parameters.jsCode = PARSE_CODE;
  fmtNode.parameters.jsCode   = FORMAT_CODE;

  const r = await putWf(exist.id, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings });
  if (r.status >= 300) { console.error('PUT failed:', r.body?.slice(0, 300)); return; }
  await activate(exist.id, false); await new Promise(r => setTimeout(r, 600)); await activate(exist.id, true);

  // Verify
  const rs = await getWf(exist.id);
  const pc = rs.nodes.find(n => n.name === 'Parse Input');
  const ok = pc && pc.parameters.jsCode.includes('SYNONYMS');
  console.log('Synonym map deployed:', ok ? '✓' : '✗');
  if (ok) console.log('\n✅ DEPLOY SUCCESS — 60+ synonym mappings active');
})().catch(e => console.error('FATAL:', e.message));
