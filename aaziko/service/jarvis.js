/*
 * jarvis.js — ATES Jarvis Phase 2 core (Sales slice, SHADOW mode).
 * Read-only on production source DBs; writes ONLY to aaziko_jarvis.
 * No email is ever sent — drafts go to the review panel (pending_review).
 */
const fs = require('fs');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');

const ROOT = path.resolve(__dirname, '..');            // aaziko/
const URI = fs.readFileSync(path.join(ROOT, '.secrets', 'mongo-uri.txt'), 'utf8').trim();

let client;
async function db() {
  if (!client) { client = new MongoClient(URI, { serverSelectionTimeoutMS: 15000 }); await client.connect(); }
  return client;
}
const CS = async () => (await db()).db('common-service');
const OE = async () => (await db()).db('outbound_email');
const DH = async () => (await db()).db('Dhruval2');
const JV = async () => (await db()).db('aaziko_jarvis');

async function close() { if (client) { await client.close(); client = null; } }
const norm = (e) => String(e || '').replace(/%20/g, ' ').trim().toLowerCase();
const firstHs = (c) => (Array.isArray(c) ? c[0] : c);

/* HS code -> human product name (so drafts never show the raw HS number to buyers).
 * Source of truth: common-service.hscodes.description (clean); fallback macmap ProductName. */
async function productName(hs) {
  if (!hs) return null;
  const cs = await CS();
  const h = await cs.collection('hscodes').findOne({ hsCode: String(hs) }, { projection: { description: 1 } });
  if (h && h.description) return h.description;
  const dh = await DH();
  const t = await dh.collection('macmap_tariff').findOne({ HsCode: String(hs) }, { projection: { ProductName: 1 } });
  return (t && t.ProductName) || null;
}

/* ---- inbound replies = the Sales trigger ---- */
async function recentInboundReplies(limit = 20) {
  const oe = await OE();
  return oe.collection('inboundemails')
    .find({ inReplyTo: { $exists: true, $ne: null, $ne: '' } })
    .sort({ receivedAt: -1 }).limit(limit)
    .project({ fromEmail: 1, fromName: 1, subject: 1, bodyText: 1, inReplyTo: 1, receivedAt: 1 })
    .toArray();
}
async function getInbound(id) {
  const oe = await OE(), jv = await JV();
  let oid; try { oid = new ObjectId(id); } catch (e) { return null; }
  return (await oe.collection('inboundemails').findOne({ _id: oid }))
      || (await jv.collection('live_inbox').findOne({ _id: oid }));   // newest mail from our live poller
}
// light check: is this sender a known buyer contact? (for the inbound picker)
async function peekContact(email) {
  const oe = await OE();
  return oe.collection('contacts').findOne({ email: norm(email) }, { projection: { firstName: 1, lastName: 1, companyName: 1, country: 1, hsCodes: 1 } });
}

/* ---- buyer resolution + context packet (read-only, bounded) ---- */
async function buildContext(inbound) {
  const oe = await OE(), cs = await CS(), dh = await DH();
  const email = norm(inbound.fromEmail);
  const unknowns = [];
  const sourceRefs = {};

  // 1. contact (identity entry)
  let contact = await oe.collection('contacts').findOne({ email },
    { projection: { email: 1, firstName: 1, lastName: 1, companyId: 1, companyName: 1, country: 1, hsCodes: 1, doNotContact: 1, status: 1, workflowState: 1, totalSent: 1, totalReplied: 1, buyerTier: 1 } });
  // fallback: resolve via the replied-to outbound message's contactId
  if (!contact && inbound.inReplyTo) {
    const msg = await oe.collection('messages').findOne({ $or: [{ providerMessageId: inbound.inReplyTo }, { messageId: inbound.inReplyTo }] }, { projection: { contactId: 1, companyId: 1, toEmail: 1 } });
    if (msg && msg.contactId) contact = await oe.collection('contacts').findOne({ _id: msg.contactId });
  }
  if (contact) sourceRefs.contact = 'outbound_email.contacts/' + contact._id;
  else unknowns.push('contact (sender not in CRM)');

  // 2. company firmographics
  let company = null;
  if (contact && contact.companyId) {
    try { company = await oe.collection('companies').findOne({ _id: typeof contact.companyId === 'string' && contact.companyId.length === 24 ? new ObjectId(contact.companyId) : contact.companyId }); } catch (e) {}
    if (company) sourceRefs.company = 'outbound_email.companies/' + company._id;
  }
  if (!company) unknowns.push('company firmographics');

  const hs = firstHs(contact && contact.hsCodes) || firstHs(company && company.hsCodes) || null;
  const country = (contact && contact.country) || (company && company.country) || null;
  if (!hs) unknowns.push('HS code');
  if (!country) unknowns.push('destination country');

  // 3. opt-out / suppression
  const supp = email ? await oe.collection('suppressions').findOne({ email, active: true }) : null;
  const suppressed = !!supp || !!(contact && contact.doNotContact);

  // 4. comms history (prior sent + this thread)
  const priorSent = email ? await oe.collection('messages').find({ toEmail: email }).sort({ sentAt: -1 }).limit(5).project({ subject: 1, status: 1, sentAt: 1 }).toArray() : [];

  // 5. trade intel (HS-level market), bounded
  let intel = [], supplier = [], tariff = null;
  if (hs) {
    intel = await cs.collection('buyer_summaries').find({ hs_codes: String(hs) }).sort({ total_value_usd: -1 }).limit(5).project({ buyer_name: 1, buyer_country: 1, total_value_usd: 1, annual_volume: 1 }).toArray();
    supplier = await cs.collection('supplier_summaries').find({ hs_codes: String(hs), supplier_country: { $regex: 'india', $options: 'i' } }).sort({ total_value_usd: -1 }).limit(5).project({ supplier_name: 1, supplier_country: 1, iec: 1 }).toArray();
    if (country) {
      tariff = await dh.collection('macmap_tariff').findOne({ HsCode: String(hs), ImportingCountry: { $regex: '^' + String(country).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', $options: 'i' } }, { projection: { HsCode: 1, ProductName: 1, ImportingCountry: 1, ExportingCountry: 1, Mode: 1, Year: 1, Data: 1 } });
    }
  }
  if (!tariff) unknowns.push('import tariff for this HS+country');

  const buyerName = (contact ? ((contact.firstName || '') + ' ' + (contact.lastName || '')).trim() : '') || inbound.fromName || email;
  const product = await productName(hs);
  return {
    buyer: { email, name: buyerName, country, hs, product },
    contact: contact || null,
    company: company ? { name: company.name, country: company.country, industry: company.industry, buyerTier: company.buyerTier, hsCodes: company.hsCodes } : null,
    suppressed, suppressionReason: supp ? supp.type : (contact && contact.doNotContact ? 'contact.doNotContact' : null),
    priorSent, intel, supplier, tariff,
    unknowns, sourceRefs,
    accessLimitations: 'read-only; summaries are HS-level market data, not this buyer\'s own shipments'
  };
}

/* ---- Product Resolver helpers: keyword -> HS candidates (grounded in our hscodes) ---- */
async function hsByText(keyword, limit = 15) {
  const cs = await CS();
  const rx = String(keyword || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!rx) return [];
  return cs.collection('hscodes').find({ description: { $regex: rx, $options: 'i' } }).limit(limit).project({ hsCode: 1, description: 1 }).toArray();
}
async function hsByCodes(codes) {
  if (!codes || !codes.length) return [];
  const cs = await CS();
  const ors = codes.map(c => ({ hsCode: { $regex: '^' + String(c).replace(/[^0-9]/g, '') } })).filter(o => o.hsCode.$regex.length > 1);
  if (!ors.length) return [];
  return cs.collection('hscodes').find({ $or: ors }).limit(40).project({ hsCode: 1, description: 1 }).toArray();
}

/* ---- PROACTIVE targeting by HS code (outbound, no inbound) ---- */
// customs-data artifacts / non-buyer entities (PREFIX match — many have trailing junk)
const JUNK_NAME = /^(to\s*order|to\s*orde|to the order|order of|the order|sin\s*(razon|nombre)|varios?|a\s*ordem|a\s*l.?ordre|cliente|consumidor|particular|no\s*aplica|mercanc|unknown|various|same as|consignee|notify|no\s*name|not available|n\/?a\b|confidential|private|individual|same company)/i;
function isJunkName(n) {
  if (!n) return true;
  const t = String(n).trim();
  if (t.length < 3 || JUNK_NAME.test(t)) return true;
  const d = t.toUpperCase().replace(/[^A-Z]/g, '');   // despace/depunct to catch mangled "T O THE ORDER" variants
  return d.startsWith('TOTHEORD') || d.startsWith('TOORDER') || d.startsWith('TOTHEODER') || d.startsWith('TOODER');
}
// is this HS one India actually exports? (one check per HS, not per buyer — cheap fit-gate)
async function hsHasIndiaSuppliers(hs) {
  const cs = await CS();
  const n = await cs.collection('supplier_summaries').countDocuments({ hs_codes: String(hs), supplier_country: { $regex: 'india', $options: 'i' } }, { maxTimeMS: 6000 }).catch(() => 0);
  return { ok: n > 0, count: n };
}
async function targetsByHs(hs, limit = 10) {
  const cs = await CS();
  const raw = await cs.collection('buyer_summaries')
    .find({ hs_codes: String(hs) })
    .sort({ 'recommendation.priority_score': -1, total_value_usd: -1 })
    .limit(limit * 6)
    .project({ buyer_name: 1, buyer_country: 1, total_shipments: 1, total_value_usd: 1, annual_volume: 1, buyer_tier: 1, hs_codes: 1, buyer_uuid: 1, recommendation: 1 })
    .toArray();
  // drop junk names AND aggregate-bucket docs (a real company doesn't import 25+ distinct HS codes)
  return raw.filter(b => !isJunkName(b.buyer_name) && (b.hs_codes || []).length <= 25).slice(0, limit);
}

/* Customer directory search — by name / company / email (CRM contacts). */
async function searchCustomers(q, limit = 40) {
  const cs = await CS();
  let query = {};
  if (q && String(q).trim()) {
    const rx = new RegExp(String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query = { $or: [{ firstName: rx }, { lastName: rx }, { companyName: rx }, { email: rx }] };
  }
  const docs = await cs.collection('contacts').find(query)
    .sort({ totalReplied: -1, totalSent: -1 }).limit(limit)
    .project({ firstName: 1, lastName: 1, companyName: 1, email: 1, country: 1, hsCodes: 1, totalSent: 1, totalReplied: 1, doNotContact: 1 }).toArray();
  return docs.map(d => ({
    name: ((d.firstName || '') + ' ' + (d.lastName || '')).trim() || d.companyName || d.email || '—',
    company: d.companyName || '', email: d.email || '', country: d.country || '',
    hs: (Array.isArray(d.hsCodes) ? d.hsCodes[0] : d.hsCodes) || '',
    sent: d.totalSent || 0, replied: d.totalReplied || 0, optOut: !!d.doNotContact,
  }));
}

/* KNOWN buyers (CRM contacts) with a real email — targetable by HS, directly sendable (gated). */
async function knownBuyersByHs(hs, limit = 10) {
  const cs = await CS();
  const raw = await cs.collection('contacts')
    .find({ hsCodes: String(hs), email: { $exists: true, $ne: '' }, doNotContact: { $ne: true } })
    .sort({ totalReplied: -1, totalSent: 1 })
    .limit(limit)
    .project({ email: 1, firstName: 1, lastName: 1, companyName: 1, country: 1, hsCodes: 1, buyerTier: 1, productName: 1 })
    .toArray();
  return raw.map(c => ({
    buyer_name: c.companyName || ((c.firstName || '') + ' ' + (c.lastName || '')).trim() || norm(c.email),
    buyer_country: c.country || null,
    hs_codes: Array.isArray(c.hsCodes) ? c.hsCodes : [String(hs)],
    searchedHs: String(hs),
    email: norm(c.email),
    buyer_tier: c.buyerTier || null,
    total_shipments: null, total_value_usd: null,
    productName: c.productName || null, known: true,
  }));
}

/* ---- PURCHASE side: real Indian EXPORTERS for an HS (the right RFQ targets) ---- */
async function indiaExportersByHs(hs, limit = 8) {
  const cs = await CS();
  const raw = await cs.collection('supplier_summaries')
    .find({ hs_codes: String(hs), supplier_country: { $regex: 'india', $options: 'i' } })
    .sort({ total_value_usd: -1 }).limit(limit * 2)
    .project({ supplier_name: 1, iec: 1, total_value_usd: 1, total_shipments: 1 })
    .toArray();
  return raw.filter(s => s.supplier_name && !isJunkName(s.supplier_name))
    .slice(0, limit)
    .map(s => ({ name: s.supplier_name, iec: s.iec || null, shipments: s.total_shipments || null, valueUsd: s.total_value_usd || null }));
}

/* Rank Indian exporters for an HS: score by export volume + value, add plain labels. (Auto-sourcing step 2.) */
async function scoreSuppliers(hs, limit = 6) {
  const sup = await indiaExportersByHs(hs, 12);
  if (!sup.length) return [];
  const maxShip = Math.max.apply(null, sup.map(s => s.shipments || 0).concat([1]));
  const maxVal = Math.max.apply(null, sup.map(s => s.valueUsd || 0).concat([1]));
  return sup.map(s => {
    const volume = (s.shipments || 0) / maxShip, value = (s.valueUsd || 0) / maxVal;
    const score = Math.round(100 * (0.5 * volume + 0.5 * value));
    const labels = ['🇮🇳 exports this product'];
    if ((s.shipments || 0) >= 2000) labels.unshift('🏭 high-volume exporter');
    if ((s.valueUsd || 0) >= 5e7) labels.push('💰 large exporter');
    return { name: s.name, iec: s.iec, shipments: s.shipments, valueUsd: s.valueUsd, score, labels };
  }).sort((a, b) => b.score - a.score).slice(0, limit);
}

/* Import duty % for an HS into a destination country (macmap tariff). Returns {duty_pct, raw} or null. */
async function tariffFor(hs, country) {
  if (!hs || !country) return null;
  const dh = await DH();
  const t = await dh.collection('macmap_tariff').findOne(
    { HsCode: String(hs), ImportingCountry: { $regex: '^' + String(country).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', $options: 'i' } },
    { projection: { HsCode: 1, ImportingCountry: 1, Data: 1, Year: 1, Mode: 1 } });
  if (!t) return null;
  const n = parseFloat(String(t.Data).replace(/[^0-9.]/g, ''));
  return { duty_pct: isNaN(n) ? null : n, country: t.ImportingCountry, year: t.Year, raw: t.Data };
}

/* Sourcing tracker: one doc per buyer requirement being auto-sourced (own DB only). */
async function saveSourcing(doc) {
  const jv = await JV();
  const r = await jv.collection('sourcing').insertOne(Object.assign({ createdAt: new Date() }, doc));
  return r.insertedId;
}
async function updateSourcing(id, patch) {
  const jv = await JV();
  await jv.collection('sourcing').updateOne({ _id: new ObjectId(id) }, { $set: Object.assign({ updatedAt: new Date() }, patch) });
}
async function listSourcing(limit = 20) {
  const jv = await JV();
  return jv.collection('sourcing').find({}).sort({ createdAt: -1 }).limit(limit)
    .project({ buyerEmail: 1, subject: 1, 'requirement.product': 1, 'requirement.quantity': 1, 'requirement.destination': 1, hs: 1, stage: 1, suppliers: 1, rfqIds: 1, quotationId: 1, landed: 1, response: 1, createdAt: 1 }).toArray();
}
// STAGED outcomes (positive→CRM, negative→newsletter). Written to our own DB only — real CRM/newsletter writes are senior-gated.
async function saveCrmUpdate(doc) { const jv = await JV(); const r = await jv.collection('crm_updates').insertOne(Object.assign({ createdAt: new Date(), staged: true }, doc)); return r.insertedId; }
async function saveNewsletter(doc) { const jv = await JV(); const r = await jv.collection('newsletter_list').insertOne(Object.assign({ createdAt: new Date(), staged: true }, doc)); return r.insertedId; }

async function buildOutreachContext(buyer, searchedHs) {
  const cs = await CS(), dh = await DH();
  // use the HS we actually searched on (fix: buyer.hs_codes[0] could be a different product)
  const hs = String(searchedHs || firstHs(buyer.hs_codes) || buyer.hs || '') || null;
  const country = buyer.buyer_country || null;
  const unknowns = ['buyer email (enrichment needed before any real send)'];
  let supplier = [], tariff = null;
  if (hs) {
    supplier = await cs.collection('supplier_summaries').find({ hs_codes: String(hs), supplier_country: { $regex: 'india', $options: 'i' } }).sort({ total_value_usd: -1 }).limit(5).project({ supplier_name: 1, supplier_country: 1, iec: 1 }).toArray();
    if (country) tariff = await dh.collection('macmap_tariff').findOne({ HsCode: String(hs), ImportingCountry: { $regex: '^' + String(country).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', $options: 'i' } }, { projection: { HsCode: 1, ProductName: 1, ImportingCountry: 1, Mode: 1, Year: 1, Data: 1 } });
  }
  if (!tariff) unknowns.push('import tariff for this HS+country');
  const product = await productName(hs);
  return {
    buyer: { email: null, name: buyer.buyer_name, country, hs, product },
    buyerStats: { shipments: buyer.total_shipments, valueUsd: buyer.total_value_usd, annualVolume: buyer.annual_volume, tier: buyer.buyer_tier },
    company: null, intel: [], supplier, tariff, priorSent: [],
    suppressed: false, suppressionReason: null,
    unknowns, sourceRefs: { buyer_summaries: 'common-service.buyer_summaries/' + (buyer._id || buyer.buyer_uuid) },
    accessLimitations: 'proactive target from customs data; NO CRM contact/email yet — enrichment + suppression check required before any real send'
  };
}

/* ---- decision (deterministic) ---- */
function decide(ctx) {
  if (ctx.suppressed) return { action: 'DO_NOT_CONTACT', reason: 'buyer opted out / suppressed (' + (ctx.suppressionReason || '') + ')' };
  // sender not in CRM → likely not a tracked buyer (logistics/vendor/accounting/new lead) → human triage, no auto-draft.
  if (!ctx.contact) return { action: 'NEEDS_REVIEW', reason: 'sender not in CRM — not a tracked buyer (could be logistics/vendor/new lead); human triage before any reply' };
  // known buyer replied to our outreach → draft a grounded response (flag unknowns).
  return { action: 'RESPOND', reason: 'known buyer replied to our outreach — draft a grounded response' + (ctx.unknowns.length ? ' (unknowns: ' + ctx.unknowns.join(', ') + ')' : '') };
}

/* ---- Jarvis-DB writes (own DB only) ---- */
async function recordEvent(inbound) {
  const jv = await JV();
  const sourceMsgId = String(inbound._id);
  const existing = await jv.collection('events').findOne({ sourceMsgId }); // app-level dedup (unique index deferred)
  if (existing) return { deduped: true, eventId: existing._id };
  const r = await jv.collection('events').insertOne({ sourceMsgId, type: 'inbound_reply', fromEmail: inbound.fromEmail, subject: inbound.subject, receivedAt: inbound.receivedAt, at: new Date() });
  return { deduped: false, eventId: r.insertedId };
}

// Follow-up candidates: emailable outreach/reply drafts we actioned >= N days ago, with NO reply since, not yet followed up.
async function followupCandidates(days = 5, limit = 30) {
  const jv = await JV(), oe = await OE();
  const cutoff = new Date(Date.now() - days * 86400000);
  // NOTE: createdAt is a STRING for n8n-written docs, a Date for service-written ones — so filter the date in JS, not Mongo.
  const docs = await jv.collection('pending_review')
    .find({ type: { $in: ['outreach', 'reply'] }, draft: { $ne: null }, status: { $in: ['approved', 'edited', 'sent'] } })
    .limit(limit * 4).toArray();
  const out = [], seen = new Set();
  for (const d of docs) {
    const email = d.buyer && d.buyer.email;
    if (!email || /enrichment pending/i.test(email)) continue;
    if (seen.has(email.toLowerCase())) continue;   // one follow-up per buyer
    const created = d.createdAt instanceof Date ? d.createdAt : new Date(d.createdAt);
    if (!(created <= cutoff)) continue;   // too recent
    const already = await jv.collection('pending_review').findOne({ type: 'followup', 'buyer.email': email });
    if (already) continue;
    const replied = await oe.collection('inboundemails').findOne({ fromEmail: { $regex: '^' + String(email).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', $options: 'i' }, receivedAt: { $gt: created } });
    if (replied) continue;
    seen.add(email.toLowerCase());
    out.push({ id: String(d._id), name: d.buyer.name, email, type: d.type, subject: d.draft.subject, createdAt: created });
    if (out.length >= limit) break;
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out;
}

// Pipeline funnel: counts by status + type (the in-house "CRM status" view).
async function pipelineStats() {
  const jv = await JV();
  const [byStatus, byType, sent, total] = await Promise.all([
    jv.collection('pending_review').aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
    jv.collection('pending_review').aggregate([{ $group: { _id: '$type', n: { $sum: 1 } } }]).toArray(),
    jv.collection('communication_history').countDocuments({ direction: 'outbound_sent', shadow: { $ne: true } }).catch(() => 0),
    jv.collection('pending_review').countDocuments({}),
  ]);
  const s = {}; byStatus.forEach(x => { s[x._id || 'unknown'] = x.n; });
  const t = {}; byType.forEach(x => { t[x._id || 'unknown'] = x.n; });
  return { total, byStatus: s, byType: t, sentLogged: sent };
}

/* ---- Live Mailbox journey: real inbound emails (contact@aaziko.com) tied to what Jarvis did with each ----
 * Source: outbound_email.inboundemails (every doc is toEmail=contact@aaziko.com).
 * Joins pending_review by source.inboundId so a sales person sees, per mail: Received -> Drafted -> Reviewed -> Sent.
 * Read-only on the mailbox; no writes here. */
async function mailboxJourney(limit = 25) {
  const oe = await OE(), jv = await JV();
  const lim = Math.min(Number(limit) || 25, 60);
  const PROJ = { fromEmail: 1, fromName: 1, subject: 1, bodyText: 1, receivedAt: 1, toEmail: 1, inReplyTo: 1, messageId: 1 };
  // (a) most-recent arrivals from BOTH feeds: production inboundemails + our live poller (live_inbox = genuinely fresh)
  const [recP, recL] = await Promise.all([
    oe.collection('inboundemails').find({}).sort({ receivedAt: -1 }).limit(lim).project(PROJ).toArray(),
    jv.collection('live_inbox').find({}).sort({ receivedAt: -1 }).limit(lim).project(PROJ).toArray(),
  ]);
  // (b) every email Jarvis has ALREADY acted on (draft linked via source.inboundId) — keep journeys visible even if older
  const prs = await jv.collection('pending_review')
    .find({ 'source.inboundId': { $exists: true, $ne: null } })
    .sort({ createdAt: -1 }).limit(80)
    .project({ 'source.inboundId': 1, status: 1, 'qa.verdict': 1, type: 1, role: 1, createdAt: 1 }).toArray();
  const byInbound = {}; const linked = new Set();
  for (const p of prs) {
    const k = p.source && p.source.inboundId; if (!k) continue; linked.add(k);
    const prev = byInbound[k];
    if (!prev || new Date(p.createdAt) > new Date(prev.createdAt)) byInbound[k] = p;   // latest draft per mail
  }
  // fetch acted-on docs not already in the recent windows (from both feeds)
  const haveIds = new Set([...recP, ...recL].map(m => String(m._id)));
  const needOids = [...linked].filter(id => !haveIds.has(id))
    .map(id => { try { return new ObjectId(id); } catch (e) { return null; } }).filter(Boolean);
  let exP = [], exL = [];
  if (needOids.length) {
    [exP, exL] = await Promise.all([
      oe.collection('inboundemails').find({ _id: { $in: needOids } }).project(PROJ).toArray(),
      jv.collection('live_inbox').find({ _id: { $in: needOids } }).project(PROJ).toArray(),
    ]);
  }
  // merge + dedup by messageId: prefer the copy that HAS a draft, else the production copy (it carries replies[] for threads)
  const tagged = [];
  recP.forEach(m => tagged.push({ m, prod: true })); exP.forEach(m => tagged.push({ m, prod: true }));
  recL.forEach(m => tagged.push({ m, prod: false })); exL.forEach(m => tagged.push({ m, prod: false }));
  const pick = {};
  for (const t of tagged) {
    const key = t.m.messageId || ('id:' + String(t.m._id));
    const cur = pick[key];
    if (!cur) { pick[key] = t; continue; }
    const tL = linked.has(String(t.m._id)), cL = linked.has(String(cur.m._id));
    if (tL && !cL) pick[key] = t;                                   // the drafted copy wins
    else if (tL === cL && t.prod && !cur.prod) pick[key] = t;       // else production copy wins (has replies[])
  }
  const mails = Object.values(pick).map(t => t.m)
    .sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt)).slice(0, 80);
  // COA/spec PDFs parsed for these mails (by messageId)
  const msgIds = mails.map(m => m.messageId).filter(Boolean);
  let coaByMsg = {};
  if (msgIds.length) {
    try {
      const agg = await jv.collection('coa_docs').aggregate([
        { $match: { messageId: { $in: msgIds } } },
        { $group: { _id: '$messageId', n: { $sum: 1 }, coa: { $sum: { $cond: [{ $eq: ['$looksLikeCoa', true] }, 1, 0] } } } }
      ]).toArray();
      agg.forEach(x => { coaByMsg[x._id] = x; });
    } catch (e) {}
  }
  const out = [];
  for (const m of mails) {
    let c = null; try { c = await peekContact(m.fromEmail); } catch (e) {}
    const p = byInbound[String(m._id)];
    let stage = 'received', stageLabel = 'Received';
    if (p) {
      const qa = p.qa && p.qa.verdict;
      if (p.status === 'sent') { stage = 'sent'; stageLabel = 'Replied — sent'; }
      else if (p.status === 'rejected') { stage = 'rejected'; stageLabel = 'Draft rejected'; }
      else if (p.status === 'approved' || p.status === 'edited') { stage = 'approved'; stageLabel = 'Approved — ready to send'; }
      else if (qa === 'N/A') { stage = 'triage'; stageLabel = 'Needs human triage'; }   // Jarvis saw it, no auto-draft
      else if (qa === 'BLOCK') { stage = 'blocked'; stageLabel = 'Draft flagged by QA'; }
      else { stage = 'drafted'; stageLabel = 'Draft ready for review'; }
    }
    out.push({
      id: String(m._id), fromEmail: m.fromEmail, fromName: m.fromName || '',
      subject: m.subject || '(no subject)',
      snippet: String(m.bodyText || '').replace(/\s+/g, ' ').trim().slice(0, 140),
      receivedAt: m.receivedAt, isReply: !!m.inReplyTo,
      isBuyer: !!c, buyerName: c ? (((c.firstName || '') + ' ' + (c.lastName || '')).trim() || c.companyName) : null,
      country: c && c.country, hs: c && firstHs(c.hsCodes),
      draftId: p ? String(p._id) : null, draftStatus: p ? p.status : null, qa: (p && p.qa && p.qa.verdict) || null,
      role: (p && p.role) || null, draftType: (p && p.type) || null,
      coaCount: (m.messageId && coaByMsg[m.messageId]) ? coaByMsg[m.messageId].n : 0,
      stage, stageLabel
    });
  }
  return out;
}

/* ---- Full conversation thread for one inbound mail (so the team sees the whole back-and-forth) ----
 * Source: the inbound doc's own body + its embedded replies[] (each carries from/to/date/subject/body, both sides).
 * Our side = any @aaziko address. Read-only. */
async function mailThread(inboundId) {
  const oe = await OE(), jv = await JV();
  let oid; try { oid = new ObjectId(inboundId); } catch (e) { return null; }
  let m = await oe.collection('inboundemails').findOne({ _id: oid });
  if (!m) m = await jv.collection('live_inbox').findOne({ _id: oid });   // live-poller mail (no replies[]; messages-merge still gives both sides)
  if (!m) return null;
  const OURS = /aaziko/i;
  const htmlToText = (h) => String(h || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
  const bodyOf = (x) => { const t = String(x.bodyText || '').trim(); return t || htmlToText(x.bodyHtml).slice(0, 4000); };
  const nsub = (s) => String(s || '').replace(/^\s*(re|fwd|fw)\s*:\s*/gi, '').trim().toLowerCase();
  const msgs = [];
  msgs.push({ from: m.fromEmail || '', fromName: m.fromName || '', to: m.toEmail || '', date: m.receivedAt || m.sentAt || m.createdAt || null, subject: m.subject || '', body: bodyOf(m).slice(0, 4000), dir: OURS.test(m.fromEmail || '') ? 'us' : 'buyer' });
  for (const r of (m.replies || [])) {
    msgs.push({ from: r.fromEmail || '', fromName: r.fromName || '', to: r.toEmail || '', date: r.sentAt || r.receivedAt || null, subject: r.subject || '', body: bodyOf(r).slice(0, 4000), dir: OURS.test(r.fromEmail || '') ? 'us' : 'buyer' });
  }
  // merge OUR outbound sends to this buyer on the same thread (messages collection), so both sides show
  const buyerEmail = OURS.test(m.fromEmail || '') ? (m.toEmail || '') : (m.fromEmail || '');
  const subjKey = nsub(m.subject);
  if (buyerEmail) {
    try {
      const sent = await oe.collection('messages')
        .find({ toEmail: { $regex: '^' + buyerEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', $options: 'i' } })
        .project({ fromEmail: 1, toEmail: 1, subject: 1, bodyText: 1, sentAt: 1, createdAt: 1, status: 1 }).limit(60).toArray();
      for (const s of sent) {
        if (nsub(s.subject) !== subjKey) continue;                 // same thread only
        if (s.status && /fail|bounce|error/i.test(s.status)) continue;
        msgs.push({ from: s.fromEmail || 'contact@aaziko.com', fromName: 'Aaziko', to: s.toEmail || '', date: s.sentAt || s.createdAt || null, subject: s.subject || '', body: bodyOf(s).slice(0, 4000), dir: 'us' });
      }
    } catch (e) {}
  }
  // de-dup (same dir+minute+first 80 chars) and sort chronologically
  const seen = new Set();
  const uniq = msgs.filter(x => { const k = x.dir + '|' + String(x.date).slice(0, 16) + '|' + String(x.body).slice(0, 80); if (seen.has(k)) return false; seen.add(k); return true; });
  uniq.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  return { inboundId: String(m._id), subject: m.subject || '', count: uniq.length, buyerEmail,
    participants: [...new Set(uniq.map(x => x.from).filter(Boolean))], messages: uniq };
}

// ---- Buyer REQUIREMENTS store (aaziko_jarvis.requirements): the spec a product MUST meet, per buyer/deal ----
const normProd = (s) => String(s || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
async function saveRequirement(req) {
  const jv = await JV();
  const doc = {
    product: req.product || null, hs: req.hs || null,
    buyerEmail: (req.buyerEmail || '').toLowerCase() || null, buyerName: req.buyerName || null,
    destination: req.destination || null, quantity: req.quantity || null,
    parameters: Array.isArray(req.parameters) ? req.parameters : [],
    sourceMsgId: req.sourceMsgId || null, subject: req.subject || null, updatedAt: new Date()
  };
  const key = doc.sourceMsgId ? { sourceMsgId: doc.sourceMsgId } : { product: doc.product, buyerEmail: doc.buyerEmail };
  await jv.collection('requirements').updateOne(key, { $set: doc, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
  const saved = await jv.collection('requirements').findOne(key, { projection: { _id: 1 } });
  return saved && saved._id;
}
async function listRequirements(limit = 60) {
  const jv = await JV();
  return jv.collection('requirements').find({}).sort({ updatedAt: -1 }).limit(limit).toArray();
}
async function getRequirement(id) {
  const jv = await JV();
  try { return await jv.collection('requirements').findOne({ _id: new ObjectId(id) }); } catch (e) { return null; }
}
// deterministic product-match score: HS exact, name equal/contains, acronym (DAP↔Di Ammonium Phosphate), token overlap
function productMatchScore(aProd, bProd, aHs, bHs) {
  let score = 0;
  if (aHs && bHs && String(aHs) === String(bHs)) score += 100;
  const na = normProd(aProd), nb = normProd(bProd);
  if (!na || !nb) return score;
  if (na === nb) score += 80;
  else if (na.includes(nb) || nb.includes(na)) score += 40;
  const words = (s) => s.split(' ').filter(Boolean);
  const acr = (s) => words(s).map(w => w[0]).join('');
  const aAcr = acr(na), bAcr = acr(nb);   // "di ammonium phosphate" → "dap"
  // one product's acronym appears as a WORD in the other (DAP ↔ "DAP Technical" / "Di Ammonium Phosphate")
  if (aAcr.length >= 3 && words(nb).includes(aAcr)) score += 50;
  if (bAcr.length >= 3 && words(na).includes(bAcr)) score += 50;
  if (na.replace(/ /g, '') === bAcr || nb.replace(/ /g, '') === aAcr) score += 50;
  const ta = new Set(words(na).filter(w => w.length > 2)); const tb = words(nb).filter(w => w.length > 2);
  score += tb.filter(w => ta.has(w)).length * 10;
  return score;
}
async function findRequirementsForCoa(coaProduct, coaHs, limit = 5) {
  const jv = await JV();
  const all = await jv.collection('requirements').find({}).limit(200).toArray();
  return all.map(r => ({ r, s: productMatchScore(coaProduct, r.product, coaHs, r.hs) }))
    .filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit)
    .map(x => Object.assign({ _matchScore: x.s }, x.r));
}

// COA/spec documents parsed from a mail's PDF attachments (aaziko_jarvis.coa_docs, populated by scripts/coa-ingest.js).
async function coaForMessage(messageId) {
  const jv = await JV();
  if (!messageId) return [];
  return jv.collection('coa_docs').find({ messageId }).project({ text: 0 }).sort({ parsedAt: 1 }).limit(20).toArray();
}
// concatenated text of a mail's COA/price/quotation docs (for parseQuote) — price_list/quotation/invoice docs first
async function coaTextForMessage(messageId) {
  const jv = await JV();
  if (!messageId) return '';
  const docs = await jv.collection('coa_docs').find({ messageId }).project({ text: 1, 'spec.doc_type': 1 }).limit(20).toArray();
  const w = (d) => /price|quot|invoice/i.test((d.spec && d.spec.doc_type) || '') ? 0 : 1;
  docs.sort((a, b) => w(a) - w(b));
  return docs.map(d => d.text || '').filter(Boolean).join('\n\n').slice(0, 4000);
}

// Role of the inbound sender RELATIVE to Aaziko, from OUR OWN history (grounded, best-effort; null = unknown → let the LLM decide).
// supplier = we sent them an RFQ (they are quoting us to supply); buyer = we sent them buyer outreach.
async function detectRoleByData(inbound) {
  const jv = await JV();
  const email = norm(inbound.fromEmail);
  if (!email) return { role: null, reason: '' };
  const rx = { $regex: '^' + email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', $options: 'i' };
  const rfq = await jv.collection('pending_review').findOne({ type: 'rfq', $or: [{ 'draft.to': rx }, { 'buyer.email': email }, { 'supplier.email': email }] });
  if (rfq) return { role: 'supplier', reason: 'we sent this address an RFQ — this is their quote/reply' };
  const out = await jv.collection('pending_review').findOne({ type: { $in: ['outreach', 'reply', 'followup'] }, $or: [{ 'draft.to': rx }, { 'buyer.email': email }] });
  if (out) return { role: 'buyer', reason: 'we sent this address buyer outreach — buyer thread' };
  return { role: null, reason: '' };
}

async function savePendingReview(doc) {
  const jv = await JV();
  const r = await jv.collection('pending_review').insertOne(Object.assign({ status: 'pending', createdAt: new Date() }, doc));
  return r.insertedId;
}
async function listPending(status) {
  const jv = await JV();
  const q = status ? { status } : {};
  return jv.collection('pending_review').find(q).sort({ createdAt: -1 }).limit(100).toArray();
}
async function getPending(id) {
  const jv = await JV();
  return jv.collection('pending_review').findOne({ _id: new ObjectId(id) });
}
async function clearPending() {
  const jv = await JV();
  const r = await jv.collection('pending_review').deleteMany({});
  return r.deletedCount;
}
async function deletePending(id) {
  const jv = await JV();
  const r = await jv.collection('pending_review').deleteOne({ _id: new ObjectId(id) });
  return r.deletedCount;
}
// Phase 3.1 — record a REAL send (not shadow) after the gated send workflow confirms it went out.
async function markSent(id, to) {
  const jv = await JV();
  await jv.collection('pending_review').updateOne({ _id: new ObjectId(id) }, { $set: { status: 'sent', sentAt: new Date(), sentTo: to, shadow: false } });
  await jv.collection('communication_history').insertOne({ pending_id: new ObjectId(id), buyer_email: to, direction: 'outbound_sent', status: 'sent', shadow: false, at: new Date() });
}
async function reviewPending(id, action, editedBody, reviewer) {
  const jv = await JV();
  const map = { approve: 'approved', reject: 'rejected', edit: 'edited' };
  const status = map[action] || 'pending';
  const set = { status, reviewedAt: new Date(), reviewer: reviewer || 'tester' };
  if (editedBody != null && action !== 'reject') set['draft.body'] = editedBody; // Approve & Edit both keep the reviewer's current text
  await jv.collection('pending_review').updateOne({ _id: new ObjectId(id) }, { $set: set });
  // SHADOW: approve does NOT send. Log the (simulated) outcome to communication_history.
  const pr = await getPending(id);
  await jv.collection('communication_history').insertOne({
    pending_id: new ObjectId(id), buyer_email: pr.buyer && pr.buyer.email, direction: 'outbound_draft',
    status: status, shadow: true, subject: pr.draft && pr.draft.subject, at: new Date()
  });
  return pr;
}

module.exports = {
  recentInboundReplies, getInbound, peekContact, buildContext, decide, productName,
  hsByText, hsByCodes, targetsByHs, knownBuyersByHs, searchCustomers, hsHasIndiaSuppliers, indiaExportersByHs, scoreSuppliers, buildOutreachContext,
  tariffFor, recordEvent, savePendingReview, saveSourcing, updateSourcing, listSourcing, saveCrmUpdate, saveNewsletter, listPending, getPending, reviewPending, markSent, pipelineStats, followupCandidates, mailboxJourney, mailThread, detectRoleByData, coaForMessage, coaTextForMessage, saveRequirement, listRequirements, getRequirement, findRequirementsForCoa, clearPending, deletePending, close,
  _norm: norm
};
