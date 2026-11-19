# Aaziko — Reminder/Task Fire-Engine — build instructions

> Hand this file to a Claude session and say "ye karo" — it's self-contained, no need to re-explain.
> Written 2026-11-18 by the CGPE WhatsApp-bot session, after planning this WITH Ved. This is a
> SEPARATE deliverable from the Aaziko ATES Jarvis Sales pipeline (email outreach) — do not touch
> that system while building this.

## What Ved wants

"Hum reminder set karte hain, time par reminder aata hai — waisa hi, same, bas test karna hai."

In plain terms: a reminder/task fire-engine for Aaziko — you set a reminder (any way, doesn't need
to be fancy yet), and at the right time it nudges the right person. That's the whole v1 scope.
**No natural-language "create a reminder from free text" layer yet** — that's a bigger, separate
piece (CGPE's version does it via a 70-tool AI brain; skip that entirely for v1).

## Hard constraints (non-negotiable, Ved was explicit about these)

1. **Do NOT put this in `aaziko_jarvis` — at all.** That DB (events/cases/tasks/commitments/
   communication_history/actions/reviews/outcomes/agent_audit, built 2026-10-01 for the Sales
   outreach pipeline) stays untouched. This reminder engine is a **brand-new, separate Mongo
   database** — suggest `aaziko_reminders` (or whatever name you and Ved agree on), with its own
   fresh collection(s). Do not reuse the existing `aaziko_jarvis.tasks` collection even though its
   schema looks tempting — Ved rejected that explicitly.
2. **Do NOT touch anything in the CGPE WhatsApp-bot repo's live systems**: `cgpe-connect` DB, any
   CGPE n8n workflow, the CGPE Meta WhatsApp number/credential. This is a fully separate build.
   If you host the new workflow on the same n8n server as CGPE (`ai.cgpe.in` — Ved approved this,
   see below), it must use its own brand-new credentials and touch zero existing nodes/workflows.
3. **No real client/buyer data flows through this** — this is an internal reminder tool, not the
   Sales outreach system. Keep it that way; don't wire it to `outbound_email`/`common-service`/etc.

## Confirmed decisions (already discussed with Ved, don't re-ask)

- **Scope**: fire-engine only (scheduled check → due reminder → send). Not natural-language create.
- **Hosting**: Ved approved running the new n8n workflow on the existing CGPE n8n server
  (`ai.cgpe.in`) — it's already a reliable, always-on host (unlike Aaziko's local n8n at
  `localhost:5678`, which the senior previously flagged as not proven for 24/7/live send). This is
  purely a hosting convenience — the workflow/credentials must be 100% new and isolated (see
  constraint #2). If that turns out to be awkward in practice, the fallback is Aaziko's own local
  n8n, but confirm with Ved before switching.
- **Send channel for v1 testing**: Aaziko has **no WhatsApp Business number/Meta app yet** (checked
  2026-11-18 — the whole Aaziko build so far is Gmail IMAP/SMTP + DeepInfra, zero WhatsApp/Meta
  code anywhere in `aaziko/`). Setting one up is a real prerequisite (Meta Business Manager, WABA
  verification, takes days) and nobody has started it. **Don't block on it.** Test the fire/timing
  logic now using Aaziko's existing, already-working SMTP send (cred `Zgx7DuyzK7lVX7eT`,
  `smtp.gmail.com:465`, used by the demo mail-loop workflow `3Q0zL2wU35z1KUuo`) as the interim
  notification channel. Build the engine so the "send" step is one clearly-isolated node/branch —
  swapping Email → WhatsApp later should mean replacing that one node, not re-architecting.

> **UPDATE 2026-11-18 (finalized WITH Ved this session — SUPERSEDES the SMTP/email choice above):**
> - **Send channel = WhatsApp, NOT email.** v1 testing goes through a Meta WhatsApp **TEST number**
>   from a BRAND-NEW Aaziko Meta app (never CGPE's app/number/token). Recipient field is a **phone**
>   (E.164), not email. SMTP is dropped.
> - **Reality:** a Meta HTTP 200 is NOT delivery — free-form text outside the recipient's 24h window
>   is accepted then silently fails. Prove the pipe with a template (e.g. `hello_world`), have the
>   tester message the number first to open the window, store the returned `wamid`, mark `sent`/`failed`
>   (NEVER leave a sent one `active`, or it retries every minute). Firing >24h after the last inbound
>   needs an approved template. No inbound/status webhooks in v1.
> - **Store = new Mongo db `aaziko_reminders`** on the Aaziko Mongo host `100.70.212.45:27017` (SAME
>   physical server as aaziko_jarvis / common-service — ~65 dbs — so the engine is hard-guarded to
>   that ONE db). Schedule every 1 min; quiet hours 22:00–08:00 IST (so live fire tests only fire 08:00–22:00 IST).
> - **Host = n8n on ai.cgpe.in** — reachability PROVEN 2026-11-18 (ai.cgpe.in's n8n reaches the tailnet
>   Mongo; exec 1427842 success). n8n mongo credential (isolated, db forced to `aaziko_reminders`) = `Hxh39r3Fnn77hr55`.
> - Build lives in `aaziko/reminders/` (secrets in `aaziko/.secrets/`, git-ignored). Shipped Code-node JS
>   in `lib/node-code.js`; `selftest.js` = 25/25 green (runs the exact shipped strings).
>
> **UI PIVOT 2026-11-18 (Ved): skip waiting for a Meta number — a UI page IS the v1 channel; WhatsApp later by config flip.**
> THREE workflows LIVE on ai.cgpe.in (all isolated, Aaziko mongo cred only); selftest 34/34; assert-live = LIVE code === module.
> - **Create** `rtw5Jge5FVFl2KZy` → `POST /webhook/aaziko-reminder-create` `{text, recipientPhone, nextFireAt(IST
>   "YYYY-MM-DD HH:mm"), secret}`. Bad secret/data → non-200 + error, NO insert (no silent fail).
> - **Fire Engine** `0DT9P0DwO93BQkAZ` — ACTIVE. 1-min → config-gated → Route Channel (ui | whatsapp). Config
>   `aaziko_reminders.config {key:'engine'}` = `{sendEnabled, channel, phoneNumberId, token}`; NOW channel='ui',
>   sendEnabled:true → due reminders land in `ui_inbox` (no number). Claim→Send→Mark (WA) fake-token-tested; UI
>   path live-tested (due → ui_inbox + `sent`).
> - **UI** `0NsNbYdOnHeGscjp` — ACTIVE. Chat page + feed, served by n8n. OPEN:
>   `https://ai.cgpe.in/webhook/aaziko-reminders-ui?k=<REMINDERS_CREATE_SECRET>` (key in reminders.env; keep private).
> - Control: `node aaziko/reminders/deploy/set-meta.js` (show) · `--channel ui|whatsapp` · `--set` · `--enable` · `--disable`.
> - **SWITCH TO WHATSAPP (Meta creds arrive), NO redeploy:** `META_TEST_*` in reminders.env → `set-meta.js --set`
>   (refuses CGPE META_*) → `--channel whatsapp` → `--enable`. Engine already active. WA success branch
>   (200→wamid) untested till real creds; first test: open the recipient's 24h window or use a template.

## Suggested build (adapt, don't blindly copy — but learn from these proven patterns)

Reference (read-only — for the PATTERN, never wire to it or depend on it):
CGPE's `Reminder Engine` workflow (id `KL9WetH0w1Sr6Ddf`, on `ai.cgpe.in`, in the separate CGPE
WhatsApp-bot repo) solves exactly this problem for CGPE and has already hit these bugs — worth
avoiding them from day one instead of rediscovering them:

- **IST/UTC storage bug**: whatever creates a reminder doc must store `nextFireAt` as a real UTC
  ISO timestamp. CGPE's bug was treating an IST wall-clock value as if it were already UTC (`Z`
  suffix slapped on an IST time) → fired 5.5h late. Decide ONE convention up front (recommend:
  always store UTC, convert from IST exactly once at write time) and test it explicitly.
- **n8n mongoDb aggregate + regex brace-quantifier bug**: a query string like `{"$regex":
  "^[0-9]{10}$"}` inside a mongoDb **aggregate** node silently breaks n8n's expression layer
  (`ExpressionExtensionError`), even with no `{{ }}` in sight — because n8n's `extendSyntax` runs
  over the whole query string and chokes on the `{10}`. Either use `find` instead of `aggregate`
  where possible, or write out the quantifier longhand (`[0-9][0-9]...`) if you must aggregate.
- **Quiet hours + "who gets notified when the recipient is unreachable" guard**: CGPE's engine
  checks a WhatsApp 24h-session-window before sending (irrelevant for email, skip) and has a quiet
  hours gate (no sends e.g. 22:00–08:00 IST) plus a daily send cap per recipient — worth keeping
  the quiet-hours idea even for email (nobody wants a 3am reminder ping).
- **Terminal "no items" branches must still account for 0 items safely** — a filter/switch node
  whose default path emits 0 items looks like a silent no-op success in the execution log. Make
  sure "nothing due right now" is a clean, deliberate no-op, not an accidental one.

### Minimal v1 shape

1. **New Mongo DB** (separate connection/credential from both `cgpe-connect` and `aaziko_jarvis`):
   one collection, suggest `reminders`: `{ text, setBy, recipientEmail, nextFireAt (UTC ISO),
   status ('active'|'fired'|'cancelled'), createdAt }`.
2. **A way to create a reminder** for testing — doesn't need to be pretty for v1: a webhook
   (`POST {text, recipientEmail, nextFireAt}` → insert) is enough. Natural-language parsing is
   explicitly out of scope for v1.
3. **Fire engine** (new n8n workflow, new credentials): schedule trigger (every 1–5 min) → load
   `reminders` where `status='active' AND nextFireAt <= now` → quiet-hours guard → compose a plain
   message → send via the existing Aaziko SMTP cred → mark `status='fired'`.
4. **Self-test before any real send**: like every other workflow-builder script in the CGPE repo,
   write the Compose/fire logic with inline self-tests (e.g. "due reminder at 10:00, now is 10:01
   → fires"; "due reminder but quiet hours → doesn't fire, stays active"; "already fired → doesn't
   fire again") before wiring it live.
5. Confirm with Ved before the first real send test (even to his own inbox) — same "explain, then
   get a go, then do it" rule the CGPE repo runs on; it's a sane default here too even though this
   is a different project.

## When WhatsApp is ready (later phase, not now)

Swap step 3's send node from SMTP to a WhatsApp Cloud API `httpRequest` node (Aaziko's own
phoneNumberId + token, once the Meta WABA exists) — keep the Mongo/schedule/quiet-hours logic
unchanged. Don't build this branch yet; just don't architect anything that makes the swap hard.
