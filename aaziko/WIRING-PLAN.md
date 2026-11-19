# Wiring Plan — ATES Jarvis Sales slice (DISCOVERY-CONFIRMED 2026-10-01)

Phase 0 discovery ran read-only against `100.70.212.45:27017` (87 DBs). All collection **names, field names, counts and indexes below are CONFIRMED from `aaziko/discovery-report.json`** — no more ⚠ guesses. The only open items are marked **[pick]** (a choice to make) or **[verify-shape]** (field exists; its sub-structure to eyeball on first real read).

---

## Source-of-truth decisions (locked + VALIDATED 2026-10-01)
> **Key learning from live validation:** `outbound_email` is a **self-contained CRM** — a contact's `companyId` resolves in **`outbound_email.companies`**, NOT in `common-service.companies`. And `common-service.companies` (4,152) ≠ `buyer_summaries` (5.6M): different entity sets, so name-joins between them rarely match. So: **outreach identity lives entirely in `outbound_email`**; `common-service` is the **enrichment universe** (trade intel by HS/country/name).

| Concern | DB.collection | Why |
|---|---|---|
| Outreach identity: contact → company | `outbound_email.contacts` (8,695) → `outbound_email.companies` (5,790) | self-contained; `contact.companyId` resolves here. VALIDATED. |
| Registered-company / trade profile (enrichment) | `common-service.companies` (4,152) | Aaziko's own registered companies + rich profile; match by **name/HS**, not by outbound `companyId` |
| People / contacts / outreach-state | `outbound_email.contacts` (8,695) | the live outreach engine's store |
| Opt-out / suppression | `outbound_email.suppressions` (8) + contact `doNotContact` | live suppression list |
| Comms history (sent / replies) | `outbound_email.messages` (18,685) + `outbound_email.inboundemails` (1,234) | live send log; `idempotencyKey` already present |
| Sending identity + daily cap | `outbound_email.sendingidentities` (3) + `outbound_email.campaigns.dailySendCap` (5) | governance already modelled here |
| Buyer trade-intel | `common-service.buyer_summaries` (5.64M) | has built-in `recommendation.priority_score`/`priority_tier` + `name_variants` |
| Supplier match | `common-service.supplier_summaries` (769,851) | |
| Deep shipment history | `common-service.standard_port_data` (222.1M) | bounded only (well indexed) |
| Tariff | `Dhruval2.macmap_tariff` (4.57M) | idx `ix_tariff_lookup` |
| Regulatory / compliance | `Dhruval2.macmap_regulatory` (6.23M) | idx HsCode6Digit, ImportingCountry |
| Deep entity intel (optional) | `trade_intelligence.entity_product_profiles` (885) or HTTP :3077 | sparse; use when present |

> `common-service`: `buyers`, `deals`, `leads`, `products`, `unsubscribes` are **EMPTY** — do NOT depend on them. `custom30` (all 4 collections) **EMPTY**. Use the collections above.

---

## Credentials to create in n8n (MongoDB node binds ONE DB per credential)
| Credential name | DB | Access |
|---|---|---|
| `Aaziko RO - common-service` | common-service | **read-only** |
| `Aaziko RO - outbound_email` | outbound_email | **read-only** |
| `Aaziko RO - Dhruval2` | Dhruval2 | **read-only** |
| `Aaziko RO - trade_intelligence` (optional) | trade_intelligence | read-only |
| `Aaziko Jarvis RW` | aaziko_jarvis (net-new) | read-write |
| `Aaziko Intelligence RW` (optional) | aaziko_intelligence (net-new) | read-write |

HTTP creds (later): `outbound_email` send API, Trade Intelligence Engine (:3077), Landed/Logistic cost calculators.
**Request a dedicated read-only Mongo user** (abhi admin creds mile hain — fine for discovery, par outreach ke liye RO user ideal).

---

## READ nodes (Context Builder) — fixed templates, read-only, projection + limit always

| # | Jarvis step | Credential | Collection | Query (CONFIRMED fields) | Projection / limit / index |
|---|---|---|---|---|---|
| 1 | Resolve CONTACT (identity entry) | RO outbound_email | `contacts` | `{ email: <buyerEmail.trim()> }` | proj `email,firstName,lastName,companyId,companyName,country,hsCodes,doNotContact,status,workflowState,totalSent,totalReplied,buyerTier`; limit 1; idx `email_1`. **Normalize email first** (trim + URL-decode — real data has `%20`/leading-space junk) |
| 2 | Company firmographics | RO outbound_email | `companies` | `{ _id: ObjectId(contact.companyId) }` | proj `name,country,industry,size,buyerTier,importCountries,exportCountries,hsCodes,productCategories`; limit 1; idx `_id_`. (contact.companyId resolves HERE, not in common-service) |
| 2b | Registered-company profile (enrichment, optional) | RO common-service | `companies` | `{ companyName: /<name>/i }` **or** `{ email: <buyerEmail> }` | proj `companyName,country,email,hsCodes,buyerTier,mainProduct,portBrainData`; limit 1; idx `companyName_1`/`email_1`. Often 0 hits (different entity set) — do not block on it |
| 3 | Opt-out / suppression | RO outbound_email | `suppressions` | `{ email: <buyerEmail>, active: true }` | limit 1 → any hit = **DO_NOT_CONTACT**; idx `email_1_active_1`. (ALSO honor contact.`doNotContact`.) |
| 4 | Comms history (sent) | RO outbound_email | `messages` | `{ toEmail: <buyerEmail> }` sort `{ sentAt:-1 }` | proj `subject,status,sentAt,openCount,clickCount,campaignId,idempotencyKey`; limit 10; idx `toEmail_1`,`sentAt_-1` |
| 5 | Comms history (replies) | RO outbound_email | `inboundemails` | `{ fromEmail: <buyerEmail> }` sort `{ receivedAt:-1 }` | proj `subject,preview,receivedAt,inReplyTo`; limit 5; idx `fromEmail_1`,`receivedAt_-1` |
| 6 | Buyer trade-intel | RO common-service | `buyer_summaries` | `{ buyer_name: /<name>/i }` **or** `{ hs_codes: <hs> }` sort `{ "recommendation.priority_score":-1 }` | proj `buyer_country,total_shipments,total_value_usd,annual_volume,hs_codes,buyer_tier,recommendation`; limit 5; idx `buyer_name_1`/`hs_codes_1` **[verify-shape: recommendation]** |
| 7 | Supplier match | RO common-service | `supplier_summaries` | `{ hs_codes: <hs> }` sort `{ total_value_usd:-1 }` | proj `supplier_name,supplier_country,iec,hs_codes,dest_countries`; limit 5; idx `hs_codes_1` |
| 8 | Tariff | RO Dhruval2 | `macmap_tariff` | `{ HsCode: <hs>, ImportingCountry: <destCountry>, ExportingCountry: <origin> }` | proj `HsCode,ProductName,ImportingCountry,ExportingCountry,Mode,TargetYear,Year,Data`; limit 1; idx `ix_tariff_lookup` **[verify-shape: Data]** |
| 9 | Regulatory (optional) | RO Dhruval2 | `macmap_regulatory` | `{ HsCode6Digit: <hs6>, ImportingCountry: <destCountry> }` | proj `HsCode6Digit,ImportingCountry,Mode,Data`; limit 5; idx `HsCode6Digit_1` |
| 10 | Deep shipment (optional) | RO common-service | `standard_port_data` | `{ HS_CODE: <hs>, DESTINATION_COUNTRY: <country>, data_type: <'import'> }` | proj bounded; limit 20; idx `HS_CODE_1_ORIGIN_COUNTRY_1_DESTINATION_COUNTRY_1` — **never full scan** |
| 11 | Entity intel (optional) | RO trade_intelligence | `entity_product_profiles` | `{ entity_id: <id> }` or by hs6 | limit 3; idx `ix_entity_hs6`/`ix_hs6`; sparse (885) |
| 12 | Buyer score (optional) | HTTP GET | Trade Intelligence Engine :3077 | `?buyer=<id>` | — |

**Rule:** FIXED templates (never AI-generated). Projection + limit always. `standard_port_data` (222M) heavy aggregation belongs in a backend worker, not an n8n node.

**[pick] Identity match key:** buyer input se hum `companyName` (regex) + `email` dono try karenge; `buyer_summaries` link `buyer_name` / `name_variants` se (companyId se nahi — summaries company-keyed nahi hain).

## LOGIC nodes (no credentials) — deterministic Code now, LLM later
Assemble Context Packet (`$('NodeName').all()` se har read re-source — "mongo node replaces output" trap avoid) → Commercial Comparison → **Decision** (CONTACT / CREATE_INTERNAL_TASK / DO_NOT_CONTACT) → Route (IF) → Draft → **QA** (no fake price/MOQ/duty; unknown stays UNKNOWN) → QA-passed (IF) → **Human Approval** → Recheck + Idempotency.

## WRITE nodes (Jarvis's OWN DB only — never source data)
| Step | Node | Credential | Collection (aaziko_jarvis) | Unique key |
|---|---|---|---|---|
| Persist event | insert | Jarvis RW | `events` | `sourceMsgId` |
| Open/update case | upsert | Jarvis RW | `cases` | `case_id` |
| Log activity | insert | Jarvis RW | `communication_history` | — |
| Action ledger | insert | Jarvis RW | `actions` | `idempotencyKey` |
| Schedule review | insert | Jarvis RW | `reviews` | — |
| Internal task | insert | Jarvis RW | `tasks` | — |

## SEND node (later phase, test-only)
`outbound_email` send API via HTTP POST → **only** the approved test recipient, after human approval + recheck + suppression re-check + idempotencyKey. Choose `sendingidentities` (status active, under `dailyLimit`).

---

## Status
- ✅ **Done:** Phase 0 discovery (read-only), field contract confirmed above, Jarvis-DB schema script ready.
- ▶ **Next (Phase 1):** wire `ATES-Jarvis-Sales-Slice-WIRED.json` read nodes to the queries above + create the RO credentials in n8n → test bounded reads.
- 🔑 **Needs write access to `aaziko_jarvis`:** run `aaziko-jarvis-schema.js` → enable write nodes. (admin creds can do this; run only on Ved's OK.)
