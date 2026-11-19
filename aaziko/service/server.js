/*
 * server.js — ATES Setu Phase 2 review panel + pipeline (SHADOW mode).
 * Run:  node aaziko/service/server.js   ->  http://localhost:4545
 * Nothing is ever emailed. Drafts are produced for human review only.
 */
const express = require('express');
const path = require('path');
const J = require('./jarvis');
const LLM = require('./llm');
const INTEL = require('./intel');
const ORC = require('./orchestrator');
const SPEC = require('./spec-match');
const CIF = require('./cif-calc');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.AAZIKO_PANEL_PORT || 4545;
const N8N_REPLY_WEBHOOK = process.env.AAZIKO_N8N_REPLY || 'http://localhost:5678/webhook/aaziko-reply';
const N8N_OUTREACH_WEBHOOK = process.env.AAZIKO_N8N_OUTREACH || 'http://localhost:5678/webhook/aaziko-outreach';
const N8N_SEND_WEBHOOK = process.env.AAZIKO_N8N_SEND || 'http://localhost:5678/webhook/aaziko-send';

/* ---- pipeline: process one inbound reply into a pending_review ---- */
async function processInbound(inbound, opts = {}) {
  const force = !!opts.force;
  const ev = await J.recordEvent(inbound);
  const ctx = await J.buildContext(inbound);
  let decision = J.decide(ctx);

  const sysSender = /mailer-daemon|postmaster|no-?reply|do-?not-?reply|notification|delivery (status|subsystem)|googlemail\.com/i.test(String(inbound.fromEmail || ''));

  // assemble the REAL conversation thread (prior messages) ONCE — used by role detection AND the reply (no re-asking)
  let thread = [];
  try {
    const full = await J.mailThread(String(inbound._id));
    const cur = String(inbound.bodyText || '').trim().slice(0, 160);
    thread = ((full && full.messages) || [])
      .filter(m => !(m.dir === 'buyer' && String(m.body || '').trim().slice(0, 160) === cur))   // drop the current inbound itself
      .map(m => ({ direction: m.dir, text: m.body }));
  } catch (e) {}

  // ROLE: buyer (wants to buy FROM us) vs supplier (offering to sell TO us) vs other (logistics/bounce/etc.)
  // Layer 1 = our own history (grounded); Layer 2 = LLM content classifier; sysSender shortcut = other.
  let role = 'buyer', roleReason = '', roleSource = 'default';
  if (sysSender) { role = 'other'; roleReason = 'system / bounce / no-reply sender'; roleSource = 'heuristic'; }
  else {
    try {
      const rd = await J.detectRoleByData(inbound);
      if (rd.role) { role = rd.role; roleReason = rd.reason; roleSource = 'our-history'; }
      else { const rc = await LLM.classifyRole(inbound, thread); role = rc.role || 'buyer'; roleReason = (rc.why || '') + (rc.confidence ? ' (' + rc.confidence + ')' : ''); roleSource = 'content'; }
    } catch (e) { role = 'buyer'; roleReason = 'role classifier unavailable — defaulted to buyer'; roleSource = 'fallback'; }
  }

  // Human explicitly asked Setu to draft: draft even for a non-CRM sender — grounded on the thread.
  // Never for an opted-out contact or an 'other'/system sender.
  if (force && decision.action === 'NEEDS_REVIEW' && !sysSender && role !== 'other') {
    decision = { action: 'RESPOND', reason: 'human asked Setu to draft — grounded on the email thread (' + role + ')', forced: true };
  }
  // an 'other' sender never gets a drafted reply, even if the CRM path said RESPOND
  if (role === 'other' && decision.action === 'RESPOND') {
    decision = { action: 'NEEDS_REVIEW', reason: 'not a buyer or supplier (logistics/bounce/notification) — human triage' };
  }

  const base = {
    source: { inboundId: String(inbound._id), subject: inbound.subject, fromEmail: inbound.fromEmail, receivedAt: inbound.receivedAt, bodyPreview: String(inbound.bodyText || '').slice(0, 1200) },
    buyer: ctx.buyer,
    role, roleReason, roleSource,
    contextSummary: LLM.contextBrief(ctx),
    unknowns: ctx.unknowns,
    decision,
    eventDeduped: ev.deduped
  };

  if (decision.action !== 'RESPOND') {
    base.draft = null;
    base.qa = { verdict: 'N/A', issues: [], notes: decision.action === 'DO_NOT_CONTACT' ? 'suppressed — no draft generated' : (role === 'other' ? 'not a buyer/supplier (' + roleReason + ') — no draft' : 'needs human triage — no draft generated') };
    base.autoStatusHint = decision.action === 'DO_NOT_CONTACT' ? 'suppressed' : 'needs_review';
  } else if (role === 'supplier') {
    // SUPPLIER reply: Aaziko is the buyer here → acknowledge their offer + ask for missing terms. NOT a landed-cost quote.
    base.type = 'supplier_reply';
    const r = await LLM.composeSupplierReply(ctx, inbound, thread);
    base.draft = r.draft; base.qa = r.qa; base.plan = r.plan; base.classification = r.classification; base.critique = r.critique; base.supplierQuote = r.quote || null;
    base.threadMsgs = thread.length;
    base.autoStatusHint = r.qa.verdict === 'BLOCK' ? 'qa_blocked' : 'ready_for_review';
  } else {
    // BUYER reply (default): grounded buyer-style response.
    base.type = 'reply';
    try { if (ctx.buyer && ctx.buyer.name && ctx.buyer.hs) { const intel = await INTEL.buyerIntel(ctx.buyer.name, ctx.buyer.hs); ctx.buyerIntel = INTEL.intelBrief(intel); } } catch (e) {}
    const r = await LLM.composeReply(ctx, inbound, thread);   // classify intent -> plan -> draft (thread-grounded) -> self-critique -> QA
    base.draft = r.draft; base.qa = r.qa; base.plan = r.plan; base.classification = r.classification; base.critique = r.critique;
    base.threadMsgs = thread.length;
    base.autoStatusHint = r.qa.verdict === 'BLOCK' ? 'qa_blocked' : 'ready_for_review';
    // AUTO-CAPTURE the buyer's requirement (so a supplier COA can later auto-link to it) — only if they stated specs
    try {
      if (r.classification && Array.isArray(r.classification.provided) && r.classification.provided.length) {
        const ex = await LLM.extractBuyerSpec(inbound.bodyText || '');
        if (ex && (ex.parameters || []).length) {
          await J.saveRequirement({ product: ex.product || (ctx.buyer && ctx.buyer.product) || null, hs: ctx.buyer && ctx.buyer.hs, buyerEmail: inbound.fromEmail, buyerName: inbound.fromName, parameters: ex.parameters, sourceMsgId: inbound.messageId || String(inbound._id), subject: inbound.subject });
          base.requirementCaptured = ex.parameters.length;
        }
      }
    } catch (e) {}
  }
  const id = await J.savePendingReview(base);
  return Object.assign({ _id: id }, base);
}

/* ---- pipeline: proactive outreach target by HS ---- */
async function processTarget(buyer) {
  const ctx = await J.buildOutreachContext(buyer, buyer.searchedHs);
  if (buyer.email) ctx.buyer.email = buyer.email;   // known CRM buyers carry a real (gated-sendable) email
  const known = !!buyer.email;
  // attach this buyer's real customs intel (patterns/timing/dependency) so the reasoning layer is grounded
  try { const intel = await INTEL.buyerIntel(ctx.buyer.name, ctx.buyer.hs || buyer.searchedHs); ctx.buyerIntel = INTEL.intelBrief(intel); } catch (e) {}
  const decision = { action: 'OUTREACH', reason: known ? 'first-touch to a known emailable buyer (gated send to allowlist only)' : 'proactive first-touch — buyer imports this HS (customs data); email enrichment + suppression check required before any real send' };
  const r = await LLM.composeOutreach(ctx);   // plan -> draft -> self-critique -> QA
  const doc = {
    type: 'outreach',
    source: { hs: ctx.buyer.hs, buyerName: ctx.buyer.name, buyerCountry: ctx.buyer.country, shipments: ctx.buyerStats.shipments, valueUsd: ctx.buyerStats.valueUsd, known, note: 'proactive target' },
    buyer: ctx.buyer, contextSummary: LLM.contextBrief(ctx), unknowns: ctx.unknowns,
    decision, draft: r.draft, qa: r.qa, plan: r.plan, critique: r.critique,
    autoStatusHint: r.qa.verdict === 'BLOCK' ? 'qa_blocked' : 'ready_for_review'
  };
  const id = await J.savePendingReview(doc);
  return Object.assign({ _id: id }, doc);
}

/* ---- API ---- */
app.get('/api/targets', async (req, res) => {
  try {
    const hs = req.query.hs; if (!hs) return res.status(400).json({ error: 'hs required' });
    const list = await J.targetsByHs(String(hs), Number(req.query.limit) || 10);
    list.forEach(b => { b.searchedHs = String(hs); });   // stamp the SEARCHED hs so it flows to the engine
    const india = await J.hsHasIndiaSuppliers(String(hs));   // fit-gate: can India even supply this?
    res.json({ buyers: list, india });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/target', async (req, res) => {
  try {
    const b = req.body && req.body.buyer;
    if (!b || !b.buyer_name) return res.status(400).json({ error: 'buyer object required' });
    // Smart in-service brain: intel-grounded plan -> draft -> self-critique -> QA -> pending_review.
    const doc = await processTarget(b);
    res.json({ ok: true, via: 'service-brain', id: String(doc._id), qa: doc.qa && doc.qa.verdict, decision: doc.decision });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Product Resolver: keyword -> distinct product senses + correct HS (disambiguated, DB-verified)
app.get('/api/resolve', async (req, res) => {
  try {
    const kw = req.query.kw; if (!kw) return res.status(400).json({ error: 'kw required' });
    const cand = await J.hsByText(String(kw), 15);
    const r = await LLM.resolveProduct(String(kw), cand);
    const senses = [];
    for (const s of (r.senses || [])) {
      const v = await J.hsByCodes([s.hs6]);
      senses.push({ label: s.label, hs6: s.hs6, why: s.why, dbDesc: v[0] ? v[0].description : null, inDb: !!v[0] });
    }
    res.json({ keyword: kw, ambiguous: !!r.ambiguous, senses });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// KNOWN buyers (CRM contacts with email) by HS — directly emailable (gated send works)
app.get('/api/known-targets', async (req, res) => {
  try {
    const hs = req.query.hs; if (!hs) return res.status(400).json({ error: 'hs required' });
    const buyers = await J.knownBuyersByHs(String(hs), Number(req.query.limit) || 10);
    const india = await J.hsHasIndiaSuppliers(String(hs));
    res.json({ buyers, india });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Smart lead scoring: rank customs-prospect buyers for an HS by opportunity (engine intel). ~10s for a page.
app.get('/api/rank', async (req, res) => {
  try {
    const hs = req.query.hs; if (!hs) return res.status(400).json({ error: 'hs required' });
    const buyers = await J.targetsByHs(String(hs), Number(req.query.limit) || 10);
    const ranked = await INTEL.rankBuyers(buyers.map(b => b.buyer_name), String(hs));
    res.json({ hs: String(hs), ranked });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PURCHASE side: real Indian exporters for an HS + draft an RFQ to one
app.get('/api/exporters', async (req, res) => {
  try { const hs = req.query.hs; if (!hs) return res.status(400).json({ error: 'hs required' }); res.json(await J.indiaExportersByHs(String(hs), Number(req.query.limit) || 8)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/rfq', async (req, res) => {
  try {
    const r = req.body || {}; if (!r.hs && !r.product) return res.status(400).json({ error: 'product or hs required' });
    const draft = await LLM.draftRFQ(r);
    const doc = {
      type: 'rfq',
      source: { note: 'purchase RFQ to Indian supplier', hs: r.hs, qty: r.qty, specs: r.specs, destination: r.destination, supplier: r.supplierName },
      buyer: { name: r.supplierName || 'Indian supplier', email: r.supplierEmail || null, country: 'INDIA', hs: r.hs },
      contextSummary: 'RFQ requirement — ' + (r.product || ('HS ' + r.hs)) + (r.qty ? (' · qty ' + r.qty) : '') + (r.specs ? (' · ' + r.specs) : '') + (r.destination ? (' · dest ' + r.destination) : ''),
      unknowns: r.supplierEmail ? [] : ['supplier email (India team to send)'],
      decision: { action: 'RFQ', reason: 'sourcing quote request to Indian supplier' },
      draft, qa: { verdict: 'PASS', issues: [], notes: 'RFQ — asking the supplier to quote (no guard on asking)' },
      status: 'pending', createdAt: new Date(),
    };
    const id = await J.savePendingReview(doc);
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// buyer intelligence (patterns/timing/suppliers) from the Trade Intelligence Engine
app.get('/api/intel', async (req, res) => {
  try {
    const name = req.query.name; if (!name) return res.status(400).json({ error: 'name required' });
    const intel = await INTEL.buyerIntel(String(name), req.query.hs);
    res.json(Object.assign({ brief: INTEL.intelBrief(intel) }, intel));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/inbound', async (req, res) => {
  try {
    const inbs = await J.recentInboundReplies(Number(req.query.limit) || 15);
    const out = [];
    for (const m of inbs) {
      const c = await J.peekContact(m.fromEmail);
      out.push({ _id: m._id, fromEmail: m.fromEmail, subject: m.subject, receivedAt: m.receivedAt, bodyLen: String(m.bodyText || '').length,
        isBuyer: !!c, buyerName: c ? ((c.firstName || '') + ' ' + (c.lastName || '')).trim() || c.companyName : null,
        country: c && c.country, hs: c && (Array.isArray(c.hsCodes) ? c.hsCodes[0] : c.hsCodes) });
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/process', async (req, res) => {
  try {
    const { inboundId, force } = req.body || {};
    if (!inboundId) return res.status(400).json({ error: 'inboundId required' });
    const inbound = await J.getInbound(inboundId);
    if (!inbound) return res.status(404).json({ error: 'inbound not found' });
    // Smart in-service brain: classify intent -> plan -> draft -> self-critique -> QA -> pending_review.
    // force=true (human clicked "draft a reply") drafts even for a non-CRM real buyer, grounded on the thread.
    const doc = await processInbound(inbound, { force: !!force });
    res.json({ ok: true, via: 'service-brain', id: String(doc._id), qa: doc.qa && doc.qa.verdict, role: doc.role, roleReason: doc.roleReason, draftType: doc.type || null, decision: doc.decision });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/process-batch', async (req, res) => {
  try {
    const n = Number((req.body && req.body.limit)) || 5;
    const inbs = await J.recentInboundReplies(n);
    const out = [];
    for (const ib of inbs) { try { out.push({ ok: true, from: ib.fromEmail, id: String((await processInbound(ib))._id) }); } catch (e) { out.push({ ok: false, from: ib.fromEmail, error: e.message }); } }
    res.json({ processed: out.length, results: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Live Mailbox: real inbound emails to contact@aaziko.com + what Setu did with each (received -> drafted -> reviewed -> sent)
app.get('/api/mailbox', async (req, res) => {
  try { res.json(await J.mailboxJourney(Number(req.query.limit) || 25)); }
  catch (e) { res.status(500).json({ error: e.message, dbOk: false }); }
});
// one inbound email's full body (to show the ORIGINAL mail in the slide-over)
app.get('/api/inbound/:id', async (req, res) => {
  try {
    const m = await J.getInbound(req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    res.json({ id: String(m._id), fromEmail: m.fromEmail, fromName: m.fromName || '', toEmail: m.toEmail,
      subject: m.subject || '', receivedAt: m.receivedAt, inReplyTo: m.inReplyTo || null,
      bodyText: String(m.bodyText || '').slice(0, 8000) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// full conversation thread for one inbound mail (original + all embedded replies, both sides, chronological)
app.get('/api/thread/:id', async (req, res) => {
  try {
    const t = await J.mailThread(req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json(t);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// COA/spec documents parsed from a mail's PDF attachments (download+read+store via scripts/coa-ingest.js)
app.get('/api/coa', async (req, res) => {
  try {
    let messageId = req.query.messageId;
    if (!messageId && req.query.inboundId) { const m = await J.getInbound(req.query.inboundId); messageId = m && m.messageId; }
    if (!messageId) return res.json({ messageId: null, docs: [] });
    res.json({ messageId, docs: await J.coaForMessage(messageId) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// DETERMINISTIC spec match: a mail's COA params vs a required spec (from buyer text or structured). Code decides PASS/FAIL.
app.post('/api/coa/match', async (req, res) => {
  try {
    const { inboundId, messageId, coaKey, requiredText } = req.body || {};
    let msgId = messageId;
    if (!msgId && inboundId) { const m = await J.getInbound(inboundId); msgId = m && m.messageId; }
    if (!msgId) return res.status(400).json({ error: 'inboundId or messageId required' });
    const docs = await J.coaForMessage(msgId);
    if (!docs.length) return res.json({ error: 'no COA/spec parsed for this mail (run coa-ingest)' });
    const specDocs = docs.filter(d => d.spec && (d.spec.parameters || []).length);
    if (!specDocs.length) return res.json({ error: 'attachments have no readable spec parameters' });
    // required spec: structured, else a stored requirement (requirementId), else extracted from buyer's text (LLM)
    let required = Array.isArray(req.body && req.body.requiredSpec) ? req.body.requiredSpec : null;
    let reqProduct = null;
    if (!required && req.body.requirementId) { const rq = await J.getRequirement(req.body.requirementId); if (rq) { required = rq.parameters || []; reqProduct = rq.product; } }
    if (!required) {
      if (!requiredText) return res.status(400).json({ error: 'requiredText, requiredSpec, or requirementId required' });
      const ex = await LLM.extractBuyerSpec(requiredText);
      required = ex.parameters || []; reqProduct = ex.product;
    }
    // match PER COA doc (one product each), then auto-pick the best fit (a mail may carry several products' COAs)
    const chosen = coaKey ? specDocs.find(d => d.key === coaKey) : null;
    let report, coaSource, coaProduct, candidates = null;
    if (chosen) { report = SPEC.matchSpec(chosen.spec.parameters, required); coaSource = chosen.filename; coaProduct = chosen.spec.product; }
    else if (specDocs.length === 1) { const d = specDocs[0]; report = SPEC.matchSpec(d.spec.parameters, required); coaSource = d.filename; coaProduct = d.spec.product; }
    else {
      const cands = specDocs.map(d => ({ d, rep: SPEC.matchSpec(d.spec.parameters, required) }));
      cands.sort((a, b) => (b.rep.summary.pass - a.rep.summary.pass) || (a.rep.summary.fail - b.rep.summary.fail) || (a.rep.summary.missing - b.rep.summary.missing));
      const best = cands[0]; report = best.rep; coaSource = best.d.filename; coaProduct = best.d.spec && best.d.spec.product;
      candidates = cands.map(c => ({ key: c.d.key, file: c.d.filename, product: c.d.spec && c.d.spec.product, verdict: c.rep.verdict, pass: c.rep.summary.pass, fail: c.rep.summary.fail, missing: c.rep.summary.missing }));
    }
    res.json(Object.assign({ coaSource, coaProduct, reqProduct, required, candidates }, report));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Save a BUYER REQUIREMENT (the spec a product must meet) — from structured params or buyer text; prefill from a mail.
app.post('/api/requirement', async (req, res) => {
  try {
    const b = req.body || {};
    let params = Array.isArray(b.parameters) ? b.parameters : null;
    let product = b.product || null;
    if (!params && b.requiredText) { const ex = await LLM.extractBuyerSpec(b.requiredText); params = ex.parameters || []; if (!product) product = ex.product || null; }
    let buyerEmail = b.buyerEmail || null, buyerName = b.buyerName || null, sourceMsgId = b.sourceMsgId || null, subject = b.subject || null;
    if (b.inboundId) { const m = await J.getInbound(b.inboundId); if (m) { buyerEmail = buyerEmail || m.fromEmail; buyerName = buyerName || m.fromName; sourceMsgId = sourceMsgId || m.messageId; subject = subject || m.subject; } }
    if (!product && !(params && params.length)) return res.status(400).json({ error: 'need product and/or requiredText/parameters' });
    const id = await J.saveRequirement({ product, hs: b.hs, buyerEmail, buyerName, destination: b.destination, quantity: b.quantity, parameters: params || [], sourceMsgId, subject });
    res.json({ ok: true, id: String(id), product, parameters: params || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/requirements', async (req, res) => {
  try { res.json(await J.listRequirements(Number(req.query.limit) || 60)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// AUTO-LINK: find the best-matching stored buyer requirement for a mail's COA product, then run the match automatically.
app.get('/api/coa/automatch', async (req, res) => {
  try {
    let messageId = req.query.messageId;
    if (!messageId && req.query.inboundId) { const m = await J.getInbound(req.query.inboundId); messageId = m && m.messageId; }
    if (!messageId) return res.json({ linked: false, reason: 'mail not found' });
    const docs = await J.coaForMessage(messageId);
    const specDocs = (docs || []).filter(d => d.spec && (d.spec.parameters || []).length);
    if (!specDocs.length) return res.json({ linked: false, reason: 'no COA specs on this mail' });
    const coaProduct = specDocs[0].spec && specDocs[0].spec.product;
    const reqs = await J.findRequirementsForCoa(coaProduct, specDocs[0].spec && specDocs[0].spec.hs, 5);
    if (!reqs.length) return res.json({ linked: false, coaProduct, reason: 'no matching buyer requirement stored yet' });
    const best = reqs[0];
    const cands = specDocs.map(d => ({ d, rep: SPEC.matchSpec(d.spec.parameters, best.parameters || []) }));
    cands.sort((a, b) => (b.rep.summary.pass - a.rep.summary.pass) || (a.rep.summary.fail - b.rep.summary.fail));
    const chosen = cands[0];
    res.json(Object.assign({
      linked: true,
      requirement: { id: String(best._id), product: best.product, buyer: best.buyerName || best.buyerEmail, destination: best.destination, quantity: best.quantity, score: best._matchScore },
      coaSource: chosen.d.filename, coaProduct: chosen.d.spec && chosen.d.spec.product, required: best.parameters || [],
      otherRequirements: reqs.slice(1).map(r => ({ id: String(r._id), product: r.product, buyer: r.buyerName || r.buyerEmail, score: r._matchScore }))
    }, chosen.rep));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DEAL CONTEXT: auto-fill values for the CIF calc + quotation — supplier's parsed quote + the linked buyer requirement.
// Manual fields (markup, forwarding, ocean freight) are intentionally NOT auto-filled.
app.get('/api/dealcontext', async (req, res) => {
  try {
    const rate = Number(req.query.usdInr) || 95;
    let inbound = null, messageId = req.query.messageId;
    if (req.query.inboundId) { inbound = await J.getInbound(req.query.inboundId); messageId = messageId || (inbound && inbound.messageId); }
    // supplier quote: parse from the COA/price-list text, else the mail body
    let srcText = await J.coaTextForMessage(messageId);
    if ((!srcText || srcText.replace(/\s/g, '').length < 30) && inbound) srcText = inbound.bodyText || '';
    let quote = null;
    if (srcText && srcText.replace(/\s/g, '').length >= 30) { try { quote = await LLM.parseQuote(srcText.slice(0, 2500)); } catch (e) {} }
    // linked buyer requirement (for buyer/destination/qty) via the COA product
    const docs = messageId ? await J.coaForMessage(messageId) : [];
    const specDoc = docs.find(d => d.spec && (d.spec.parameters || []).length);
    const subjProduct = (s) => { s = String(s || '').replace(/^\s*(re|fwd|fw)\s*:\s*/i, ''); return (s.split(/\s[–—|-]\s|\bfor\b/i)[0] || '').trim() || null; };
    const product = (specDoc && specDoc.spec && specDoc.spec.product) || (quote && quote.product) || (inbound && subjProduct(inbound.subject)) || null;
    let requirement = null;
    if (product) { const reqs = await J.findRequirementsForCoa(product, specDoc && specDoc.spec && specDoc.spec.hs, 1); if (reqs.length) requirement = reqs[0]; }
    // derive numeric autofills (use the quote's unit as a hint when MOQ has no explicit unit, e.g. MOQ 20 + "per MT" → 20 MT)
    const uHint = (quote && /mt|ton/i.test(quote.unit || '')) ? 'mt' : '';
    const toKg = (s, hint) => { if (s == null) return null; const str = String(s); if (/fcl|container|\bcont\b|\bctn\b/i.test(str)) return null; const m = str.match(/([\d,.]+)\s*(kg|mt|ton|tonne)?/i); if (!m) return null; const n = parseFloat(m[1].replace(/,/g, '')); const u = (m[2] || hint || 'kg').toLowerCase(); return /mt|ton/.test(u) ? n * 1000 : n; };
    const qty = (requirement && toKg(requirement.quantity, uHint)) || (quote && toKg(quote.moq, uHint)) || null;
    let pricePerKg = null; const notes = [];
    if (quote && quote.unit_price != null) {
      const ic = String(quote.incoterm || '').toUpperCase();
      if (/EXW|EX.?WORK|FOB/.test(ic) || !ic) {
        let p = Number(quote.unit_price);
        if (/mt|ton/i.test(quote.unit || '')) p = p / 1000; else if (!/kg/i.test(quote.unit || '')) p = null;
        if (p != null) { if (/usd|\$/i.test(quote.currency || '')) p = p * rate; else if (quote.currency && !/inr|rs|₹/i.test(quote.currency)) p = null; }
        if (p != null) pricePerKg = Math.round(p * 100) / 100;
      } else {
        notes.push('Supplier quoted ' + (quote.incoterm || '') + ' ' + (quote.currency || '') + ' ' + quote.unit_price + '/' + (quote.unit || '') + ' — that is a LANDED price, not an ex-works base, so Price ₹/kg is left blank (do not run a landed price through markup + freight again).');
      }
    }
    res.json({
      product,
      supplierQuote: quote && { unit_price: quote.unit_price, currency: quote.currency, incoterm: quote.incoterm, unit: quote.unit, moq: quote.moq, lead_time: quote.lead_time, payment_terms: quote.payment_terms, validity: quote.validity },
      requirement: requirement && { buyerEmail: requirement.buyerEmail, buyerName: requirement.buyerName, destination: requirement.destination, quantity: requirement.quantity },
      autofill: { qty, pricePerKg, usdInr: rate, product, buyerEmail: requirement && requirement.buyerEmail, buyerName: requirement && requirement.buyerName, destination: requirement && requirement.destination, validity: quote && quote.validity },
      notes
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DETERMINISTIC CIF/FOB calculator (Aaziko's costing sheet). All inputs manual; output in both ₹ and $.
app.post('/api/cif', async (req, res) => {
  try { res.json(CIF.computeCif(req.body || {})); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// AUTO CIF QUOTATION to the buyer: compute CIF (code) -> compose email (LLM phrasing, numbers are facts) -> number-guard -> pending_review.
app.post('/api/quotation', async (req, res) => {
  try {
    const body = req.body || {};
    const cif = CIF.computeCif(body);
    if (cif.error) return res.status(400).json({ error: cif.error });
    const info = { buyerEmail: body.buyerEmail, buyerName: body.buyerName, product: body.product, destination: body.destination, validity: body.validity, specVerdict: body.specVerdict, quantity: body.quantity };
    const draft = await LLM.composeCifQuotation(info, cif);
    const qa = (draft.guard && draft.guard.ok)
      ? { verdict: 'PASS', issues: [], notes: 'numbers verified against the CIF calculation' }
      : { verdict: 'BLOCK', issues: ['NUMBER-GUARD: unexpected number(s) ' + ((draft.guard && draft.guard.unexpected) || []).join(', ')], notes: 'draft introduced a price not in the computed CIF' };
    const doc = { type: 'quotation',
      source: { note: 'CIF quotation', inboundId: body.inboundId || null, product: body.product, destination: body.destination },
      buyer: { name: body.buyerName, email: body.buyerEmail },
      cif: cif.breakdown, cifInputs: cif.inputs, draft, qa,
      autoStatusHint: qa.verdict === 'BLOCK' ? 'qa_blocked' : 'ready_for_review', status: 'pending', createdAt: new Date() };
    const id = await J.savePendingReview(doc);
    res.json({ ok: true, id: String(id), cif: cif.breakdown, qa: qa.verdict, guard: draft.guard });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pipeline', async (req, res) => {
  try { res.json(await J.pipelineStats()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Follow-up funnel: list candidates (actioned, no reply, >= N days) + draft a follow-up for one
app.get('/api/followups', async (req, res) => {
  try { const d = Number(req.query.days); const days = isNaN(d) ? 5 : d; const candidates = await J.followupCandidates(days); res.json({ days, count: candidates.length, candidates }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/followup/:id', async (req, res) => {
  try {
    const prior = await J.getPending(req.params.id); if (!prior) return res.status(404).json({ error: 'not found' });
    const draft = await LLM.draftFollowup(prior);
    const pg = LLM.priceGuard(draft.body);
    const qa = pg.length ? { verdict: 'BLOCK', issues: ['NUMBER-GUARD (deterministic): ' + pg.join('/')], notes: '' }
      : await LLM.qaDraft({ buyer: prior.buyer, unknowns: prior.unknowns || [] }, draft, null);
    const doc = { type: 'followup', source: { followupOf: String(prior._id), priorSubject: prior.draft && prior.draft.subject, note: 'follow-up — no reply after prior outreach' }, buyer: prior.buyer, contextSummary: prior.contextSummary, unknowns: prior.unknowns || [], decision: { action: 'FOLLOWUP', reason: 'no reply after prior outreach' }, draft, qa, status: 'pending', createdAt: new Date() };
    const id = await J.savePendingReview(doc);
    res.json({ ok: true, id, qa: qa.verdict });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/pending', async (req, res) => {
  try { res.json(await J.listPending(req.query.status)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/pending/:id', async (req, res) => {
  try { const d = await J.getPending(req.params.id); d ? res.json(d) : res.status(404).json({ error: 'not found' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/review/:id', async (req, res) => {
  try {
    const { action, body, reviewer } = req.body || {};
    if (!['approve', 'reject', 'edit'].includes(action)) return res.status(400).json({ error: 'action must be approve|reject|edit' });
    res.json({ ok: true, updated: await J.reviewPending(req.params.id, action, body, reviewer) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Phase 3.1 — human-approved SEND (gated). Posts to the n8n send webhook which enforces the allowlist.
app.post('/api/send/:id', async (req, res) => {
  try {
    const pr = await J.getPending(req.params.id);
    if (!pr) return res.status(404).json({ error: 'not found' });
    if (!pr.draft) return res.status(400).json({ error: 'no draft to send' });
    const body = (req.body && req.body.body != null) ? req.body.body : pr.draft.body;
    const to = pr.draft.to;
    const r = await fetch(N8N_SEND_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, subject: pr.draft.subject, body, pendingId: String(pr._id) }) });
    const text = await r.text(); let engine; try { engine = JSON.parse(text); } catch (e) { engine = { raw: text.slice(0, 300) }; }
    if (engine && engine.sent) { await J.markSent(req.params.id, to); return res.json({ ok: true, sent: true, engine }); }
    return res.json({ ok: false, sent: false, blocked: true, reason: (engine && engine.reason) || 'send blocked', engine });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clear', async (req, res) => {
  try { res.json({ deleted: await J.clearPending() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/pending/:id', async (req, res) => {
  try { res.json({ deleted: await J.deletePending(req.params.id) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// AUTO-SOURCING LOOP: one buyer email → requirement → scored suppliers → RFQs → quote → landed → quotation (SHADOW). ~1-2 min.
app.post('/api/autoloop', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.bodyText) return res.status(400).json({ error: 'bodyText (the buyer email) is required' });
    const inbound = { fromEmail: b.fromEmail || 'buyer@demo.example', fromName: b.fromName || '', subject: b.subject || '(no subject)', bodyText: b.bodyText };
    const r = await ORC.runFullLoop(inbound, { suppliers: Number(b.suppliers) || 3, buyerResponse: b.buyerResponse || null });
    res.json({ ok: true, result: r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Sourcing pipeline: recent auto-sourcing requirements + their stage
app.get('/api/sourcing', async (req, res) => {
  try { res.json(await J.listSourcing(Number(req.query.limit) || 20)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Sales Command Center: one aggregated feed for the Home dashboard ----
function tlabel(t) { return ({ rfq: 'RFQ to India', quotation: 'Quotation', followup: 'Follow-up', outreach: 'Outreach', reply: 'Reply', demo_reply: 'Mail-loop' })[t] || (t || 'item'); }
app.get('/api/home', async (req, res) => {
  let pipe;
  try { pipe = await J.pipelineStats(); }   // DB health probe — if this throws, the DB/tunnel is unreachable
  catch (e) { return res.json({ dbOk: false, error: 'Database unreachable — is the VPN / Tailscale tunnel up?' }); }
  try {
    const [pending, follows, sourcing] = await Promise.all([
      J.listPending('pending').catch(() => []),
      J.followupCandidates(0).catch(() => []),
      J.listSourcing(40).catch(() => []),
    ]);
    const bs = pipe.byStatus || {};
    const drafts = (pending || []).filter(p => p.draft).map(p => ({
      id: String(p._id), type: p.type,
      who: (p.buyer && p.buyer.name) || (p.source && p.source.buyerName) || (p.source && p.source.supplier) || (p.buyer && p.buyer.email) || '—',
      country: (p.buyer && p.buyer.country) || (p.source && p.source.buyerCountry) || '',
      subject: (p.draft && p.draft.subject) || '', qa: (p.qa && p.qa.verdict) || '', at: p.createdAt,
    }));
    const quotationsAwaiting = (sourcing || []).filter(s => s.stage === 'quotation_drafted').map(s => ({
      id: String(s._id), quotationId: s.quotationId ? String(s.quotationId) : null,
      product: (s.requirement && s.requirement.product) || '—', buyer: s.buyerEmail || '—',
      landed: s.landed && s.landed.landed != null ? ((s.landed.currency || '') + ' ' + s.landed.landed + ' ' + (s.landed.unit || '') + ' CIF') : '', at: s.createdAt,
    }));

    const kpis = {
      draftsPending: drafts.length,
      approved: (bs.approved || 0) + (bs.edited || 0),
      sent: bs.sent || 0,
      followupsDue: (follows || []).length,
      sourcingActive: (sourcing || []).filter(s => !['won', 'lost', 'not_a_requirement'].includes(s.stage)).length,
      won: (sourcing || []).filter(s => s.stage === 'won').length,
    };

    // ranked next-actions: follow-ups → drafts to review → quotations to chase
    const nextActions = [];
    (follows || []).slice(0, 6).forEach(f => nextActions.push({ kind: 'followup', ref: f.id, label: 'Follow up ' + (f.name || f.email || '—'), sub: f.subject || '', badge: '⏳' }));
    drafts.slice(0, 8).forEach(d => nextActions.push({ kind: 'review', ref: d.id, label: 'Review ' + tlabel(d.type) + ' to ' + d.who, sub: d.subject, badge: d.qa === 'BLOCK' ? '⚠️' : '✍️' }));
    quotationsAwaiting.slice(0, 6).forEach(q => nextActions.push({ kind: 'quotation', ref: q.quotationId || q.id, label: 'Chase quotation — ' + q.product, sub: q.buyer + (q.landed ? ' · ' + q.landed : ''), badge: '💷' }));

    // activity feed (newest first)
    const activity = [];
    (pending || []).forEach(p => activity.push({ at: p.createdAt, icon: '✍️', text: 'Draft created · ' + tlabel(p.type) + ' · ' + ((p.buyer && p.buyer.name) || (p.source && p.source.buyerName) || '—') }));
    (sourcing || []).forEach(s => activity.push({ at: s.createdAt, icon: s.stage === 'won' ? '✅' : s.stage === 'lost' ? '❌' : '🏭', text: 'Sourcing · ' + ((s.requirement && s.requirement.product) || '—') + ' · ' + s.stage }));
    activity.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));

    res.json({
      dbOk: true,
      kpis,
      attention: { draftsToApprove: drafts.length, followupsDue: (follows || []).length, quotationsAwaiting: quotationsAwaiting.length },
      drafts: drafts.slice(0, 12), followups: (follows || []).slice(0, 10), quotationsAwaiting,
      nextActions, activity: activity.slice(0, 18),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Customer directory (Phase 2)
app.get('/api/customers', async (req, res) => {
  try { res.json(await J.searchCustomers(req.query.q || '', Number(req.query.limit) || 40)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.get('/api/health', (req, res) => res.json({ status: 'ok', model: LLM.MODEL, mode: 'SHADOW (no emails sent)' }));

app.listen(PORT, () => {
  console.log('ATES Setu panel  ->  http://localhost:' + PORT);
  console.log('Mode: SHADOW (read-only sources; writes only to aaziko_jarvis; NO emails sent)');
  console.log('Draft brain:     IN-SERVICE reasoning (plan -> draft -> self-critique -> QA) — outreach + reply + RFQ + follow-up');
  console.log('Gated send:      n8n webhook ' + N8N_SEND_WEBHOOK + '  (allowlist-guarded)');
  console.log('Panel = trigger + review window; drafting runs in the service, send/IMAP/scheduler stay in n8n.');
});
