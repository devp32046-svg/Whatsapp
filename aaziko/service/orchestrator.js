/*
 * orchestrator.js — AUTOMATIC Sourcing-to-Quote loop (SHADOW).
 * One buyer email in → the whole chain runs itself: extract requirement → find & score Indian
 * suppliers → draft RFQs → track. (Phase A; Phase B adds quote intake + landed cost + quotation,
 * Phase C adds response-tracking + CRM/newsletter staging.)
 * SHADOW: every "send" becomes a draft in pending_review; every "write" is staged in aaziko_jarvis.
 * Nothing is emailed; no source DB is modified.
 */
const J = require('./jarvis');
const LLM = require('./llm');

// resolve a plain product name to a 6-digit HS via the Product Resolver (DB-verified)
async function resolveHs(product) {
  if (!product) return null;
  try {
    const cand = await J.hsByText(String(product), 10);
    const r = await LLM.resolveProduct(String(product), cand);
    const s = (r.senses || []).find(x => x.hs6) || null;
    return s ? String(s.hs6) : null;
  } catch (e) { return null; }
}

/* PHASE A — requirement → scored suppliers → RFQ drafts → tracked. Returns the sourcing state. */
async function runSourcing(inbound, opts = {}) {
  const topN = opts.suppliers || 3;
  const log = [];

  // 1) extract the requirement from the buyer email
  const req = await LLM.extractRequirement(inbound);
  log.push('requirement: ' + (req.product || '(none)') + (req.quantity ? ' · ' + req.quantity : '') + (req.destination ? ' → ' + req.destination : ''));
  if (!req.is_requirement || !req.product) {
    const id = await J.saveSourcing({ buyerEmail: inbound.fromEmail, subject: inbound.subject, requirement: req, stage: 'not_a_requirement', log });
    return { sourcingId: String(id), requirement: req, stage: 'not_a_requirement', suppliers: [], rfqIds: [], log };
  }

  // 2) resolve HS + find & score Indian suppliers
  const hs = await resolveHs(req.product);
  req.hs = hs;
  log.push('HS resolved: ' + (hs || '(none)'));
  const suppliers = hs ? await J.scoreSuppliers(hs, topN) : [];
  if (!suppliers.length) {
    log.push('NO Indian suppliers found for HS ' + (hs || '?') + ' — our supplier data does not cover this product (e.g. spices / agri-commodities). Needs broader sourcing data (product-service / Apollo) or manual sourcing. Stopping here.');
    const sid = await J.saveSourcing({ buyerEmail: inbound.fromEmail, subject: inbound.subject, requirement: req, hs, suppliers: [], rfqIds: [], stage: 'no_suppliers', log });
    return { sourcingId: String(sid), requirement: req, hs, suppliers: [], rfqIds: [], stage: 'no_suppliers', log };
  }
  log.push('suppliers scored: ' + suppliers.map(s => s.name + '(' + s.score + ')').join(', '));

  // 3) draft an RFQ to each top supplier (SHADOW — saved for human review, not sent)
  const rfqIds = [];
  for (const s of suppliers) {
    const draft = await LLM.draftRFQ({ hs, product: req.product, qty: req.quantity, specs: req.specs, destination: req.destination, supplierName: s.name });
    const id = await J.savePendingReview({
      type: 'rfq',
      source: { autoSourcing: true, hs, supplier: s.name, supplierScore: s.score, buyerEmail: inbound.fromEmail },
      buyer: { name: s.name, country: 'INDIA', hs },
      contextSummary: 'AUTO-SOURCING RFQ for buyer requirement: ' + req.product + (req.quantity ? ' (' + req.quantity + ')' : '') + (req.specs ? ' — ' + req.specs : ''),
      unknowns: ['supplier email (India team to send)'],
      decision: { action: 'RFQ', reason: 'auto-sourcing: buyer asked for this product; sourcing quotes from top Indian exporters' },
      draft, qa: { verdict: 'PASS', issues: [], notes: 'RFQ — asking the supplier to quote (no number guard on asking)' },
      autoStatusHint: 'ready_for_review',
    });
    rfqIds.push(String(id));
  }
  log.push('RFQ drafts created: ' + rfqIds.length + ' (SHADOW — in review queue, not sent)');

  // 4) track the sourcing requirement
  const sourcingId = await J.saveSourcing({
    buyerEmail: inbound.fromEmail, subject: inbound.subject,
    requirement: req, hs,
    suppliers: suppliers.map(s => ({ name: s.name, score: s.score, shipments: s.shipments, labels: s.labels })),
    rfqIds, stage: 'rfqs_drafted', log,
  });

  return { sourcingId: String(sourcingId), requirement: req, hs, suppliers, rfqIds, stage: 'rfqs_drafted', log };
}

/* ---- PHASE B: collect quote → landed cost → quotation draft ---- */

// A clearly-labelled placeholder quote so the loop can complete end-to-end for a demo (no real supplier reply yet).
function simulateQuote() {
  return { _simulated: true, unit_price: 3.20, currency: 'USD', incoterm: 'FOB', unit: 'per pc', moq: '3000 pcs', lead_time: '30-35 days', payment_terms: '30% advance, balance against B/L', validity: '30 days', notes: 'SIMULATED supplier quote for demo — awaiting a real supplier reply' };
}

// best-effort destination → country (for the import tariff lookup)
const CITY2COUNTRY = { hamburg: 'Germany', 'le havre': 'France', melbourne: 'Australia', rotterdam: 'Netherlands', mombasa: 'Kenya', bangkok: 'Thailand', 'jebel ali': 'United Arab Emirates', dubai: 'United Arab Emirates', mundra: 'India', nhava: 'India' };
function destCountry(dest) {
  if (!dest) return null;
  const s = String(dest).toLowerCase();
  const afterComma = s.split(',').pop().trim();
  if (afterComma && afterComma.length > 3 && !/\d/.test(afterComma) && afterComma !== s) return afterComma.replace(/\b\w/g, c => c.toUpperCase());
  for (const k of Object.keys(CITY2COUNTRY)) if (s.includes(k)) return CITY2COUNTRY[k];
  return null;
}

// supplier price + duty + indicative freight → landed cost into the buyer's port
function computeLanded(quote, tariff) {
  const price = quote.unit_price;
  if (price == null) return { landed: null, note: 'no supplier price yet', currency: quote.currency || 'USD', unit: quote.unit || '' };
  const duty_pct = (tariff && tariff.duty_pct != null) ? tariff.duty_pct : null;
  const duty = duty_pct != null ? price * duty_pct / 100 : 0;
  const freight = Math.round(price * 0.08 * 100) / 100;        // indicative FOB→CIF ~8% (real freight source not wired)
  const landed = Math.round((price + duty + freight) * 100) / 100;
  return {
    currency: quote.currency || 'USD', unit: quote.unit || '', incoterm: 'CIF',
    unit_price: price, duty_pct,
    freight_estimate: (quote.currency || 'USD') + ' ' + freight + ' ' + (quote.unit || '') + ' (indicative ~8%)',
    landed, landed_estimated: true, validity: quote.validity || null,
  };
}

async function prepareQuotation(req, landed, buyerName, buyerEmail) {
  const draft = await LLM.draftQuotation(Object.assign({}, req, { buyerName, buyerEmail }), landed);
  const id = await J.savePendingReview({
    type: 'quotation',
    source: { autoSourcing: true, hs: req.hs, buyerEmail, landed, indicative: !!landed.landed_estimated },
    buyer: { name: buyerName, email: buyerEmail, country: null, hs: req.hs },
    contextSummary: 'AUTO QUOTATION for ' + (req.product || '') + ' — indicative landed ' + (landed.currency || '') + ' ' + (landed.landed != null ? landed.landed : '?') + ' ' + (landed.unit || '') + ' CIF',
    unknowns: landed.landed_estimated ? ['real supplier quote (simulated in this demo)', 'exact freight'] : [],
    decision: { action: 'QUOTE_BUYER', reason: 'auto-prepared landed-cost quotation (supplier quote + import duty + indicative freight)' },
    draft, qa: { verdict: 'PASS', issues: [], notes: 'quotation — numbers computed by code; freight indicative; SHADOW (not sent)' },
    autoStatusHint: 'ready_for_review',
  });
  return { quotationId: String(id), draft };
}

/* ---- PHASE C: buyer response → positive(CRM) / negative(newsletter), staged ---- */
async function classifyResponse(replyText, subject) {
  let cls = {}; try { cls = await LLM.classifyInbound({ subject: subject || 'Re: quotation', bodyText: replyText }); } catch (e) {}
  const neg = cls.intent === 'not_interested' || /not interested|too expensive|too high|decline|pass\b|no thank/i.test(replyText || '');
  const pos = /accept|confirm|proceed|go ahead|place .*order|agreed|sounds good|deal|let'?s do|please send .*(pi|proforma)/i.test(replyText || '');
  return { verdict: neg && !pos ? 'negative' : (pos ? 'positive' : 'neutral'), intent: cls.intent, sentiment: cls.sentiment };
}
async function stageOutcome(verdict, buyer, sourcingId) {
  if (verdict === 'positive') { const id = await J.saveCrmUpdate({ buyer, sourcingId, update: 'opportunity_won', stage: 'quotation_accepted', note: 'STAGED — real CRM write is senior-gated' }); return { action: 'CRM update (staged)', crmUpdateId: String(id) }; }
  if (verdict === 'negative') { const id = await J.saveNewsletter({ buyer, sourcingId, reason: 'quotation_declined', note: 'STAGED — real newsletter write is senior-gated' }); return { action: 'added to newsletter (staged)', newsletterId: String(id) }; }
  return { action: 'neutral — no CRM/newsletter action' };
}

/* ---- the whole automatic loop, end to end (SHADOW) ---- */
async function runFullLoop(inbound, opts = {}) {
  const A = await runSourcing(inbound, opts);
  if (A.stage === 'not_a_requirement' || A.stage === 'no_suppliers') return A;

  const topSupplier = (A.suppliers || [])[0] || null;
  const quote = opts.supplierReply ? await LLM.parseQuote(opts.supplierReply) : simulateQuote();
  const tariff = await J.tariffFor(A.hs, destCountry(A.requirement.destination));
  const landed = computeLanded(quote, tariff);
  const buyerName = opts.buyerName || inbound.fromName || (inbound.fromEmail || '').split('@')[0];
  const Q = await prepareQuotation(Object.assign({}, A.requirement, { hs: A.hs }), landed, buyerName, inbound.fromEmail);
  A.log.push('quote collected (' + (quote._simulated ? 'SIMULATED' : 'parsed') + ') → landed ' + (landed.currency || '') + ' ' + (landed.landed != null ? landed.landed : '?') + ' ' + (landed.unit || '') + ' CIF' + (tariff ? ' [duty ' + tariff.duty_pct + '%]' : ' [duty unknown]'));
  A.log.push('quotation drafted (SHADOW) → ' + Q.quotationId);
  await J.updateSourcing(A.sourcingId, { stage: 'quotation_drafted', quote, tariff, landed, quotationId: Q.quotationId });

  let response = null, outcome = null;
  if (opts.buyerResponse) {
    response = await classifyResponse(opts.buyerResponse, 'Re: quotation');
    outcome = await stageOutcome(response.verdict, { name: buyerName, email: inbound.fromEmail }, A.sourcingId);
    A.log.push('buyer response = ' + response.verdict + ' → ' + outcome.action);
    await J.updateSourcing(A.sourcingId, { stage: response.verdict === 'positive' ? 'won' : (response.verdict === 'negative' ? 'lost' : 'awaiting_response'), response, outcome });
  }
  return Object.assign({}, A, { supplier: topSupplier, quote, tariff, landed, quotation: Q, response, outcome });
}

module.exports = { runSourcing, runFullLoop, resolveHs, computeLanded, classifyResponse, destCountry };
