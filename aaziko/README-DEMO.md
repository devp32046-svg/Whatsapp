# Aaziko ATES Jarvis — n8n Feasibility Demo

**Question this answers:** *Can the ATES Jarvis process actually run inside n8n?*
**Answer:** Yes. This is a runnable proof-of-concept of the **Sales vertical slice**.

- Workflow file: `ATES-Jarvis-Sales-Slice-DEMO.json`
- Self-contained: **no credentials, no API keys, no database** required.
- Everything is **mock data** inside Code nodes — the point is to prove the *process shape* works in n8n, not to wire real systems yet.

---

## How to run (2 minutes)

1. Open any n8n (cloud or self-hosted) → **Workflows → Import from File** → pick `ATES-Jarvis-Sales-Slice-DEMO.json`.
2. Click the **RUN DEMO (Staging Trigger)** node → **Execute Workflow**.
3. Open the **DEMO OUTPUT — Audit Trace** node to see the result.

One click sends **3 mock buyer cases** through the full pipeline and produces **3 different, correct outcomes**.

---

## What one run proves (actual output)

| Buyer | Situation | Jarvis decision | Result |
|---|---|---|---|
| Nordwind Handels (DE) — cotton bags | Clean opportunity | **CONTACT** | Draft → QA **PASS** → human approval → **simulated send (TEST inbox)** → CRM activity + next **review** scheduled |
| Blue Ridge Imports (US) — ceramic mugs | **Aaziko owes a quotation (15 days)** | **CREATE_INTERNAL_TASK** | Buyer **NOT chased** — internal quotation task created instead |
| Brightwave Retail (GB) — LED bulbs | Draft contains an unverified price | **CONTACT** | Independent **QA BLOCKS** the unsupported claim → **no send** → human review |

This demonstrates the guarantees from the ATES charter:

- Event intake + dedup + historical-vs-live detection (**CORE-01**)
- Identity / case resolution, ambiguous → human (**CORE-02**)
- Bounded, read-only context; unknowns stay **UNKNOWN** (**CORE-03**)
- Deterministic commercial math — no invented price/savings
- Decision engine where **sending is only one option** (**COMM-01**)
- **"Aaziko owes work" → internal task, not a chase message** (communication rules)
- Independent **QA blocks unsupported claims before send** (**COMM-02**)
- **Human approval gate** + latest-state recheck + **idempotency key** (**ACTION-01**)
- **Zero real sends** — TEST recipient only
- CRM activity + a future **REVIEW** (not a blind "resend after N days") (**CRM-01**)
- Full **audit trace** at the end

---

## The map: this demo → production

n8n stays the **orchestrator**. Each mock node is swapped for a real one later:

| Demo (mock) | Production |
|---|---|
| Code node with stub events | Webhook / IMAP / Schedule trigger + Mongo `aaziko_jarvis.events` (unique index dedup) |
| Code node "Context Builder" | HTTP Request → Aaziko read-only APIs (buyer, CRM, vendor, tariff, logistics) + query templates |
| Code node "Decision / Draft / QA" | LLM nodes with narrow input/output contracts |
| Code node "Human Approval (sim)" | **Wait-for-webhook** approval (WhatsApp / Slack / n8n Form) |
| Code node "Simulated Send" | HTTP → approved email provider, writing the `actions` ledger |
| Department routing | Sub-workflows (`executeWorkflow`) per department |

Heavy data processing (millions of rows, joins) belongs in **backend services**, not n8n nodes — n8n passes bounded job requests and receives bounded results.

---

## Scope / honesty

- This proves **feasibility and process design**, not production readiness.
- No real Aaziko data, API, CRM or mailbox is touched.
- Real deployment still needs: an n8n instance, verified API/DB access, and the phased GO/NO-GO plan (Discovery → staging → shadow → controlled test send → pilot).
