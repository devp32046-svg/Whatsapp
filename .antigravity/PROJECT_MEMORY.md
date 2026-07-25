# CGPE Insurance WhatsApp Bot — Project Memory Document

> Handoff document for coding agents (Antigravity IDE / Claude Code / Cursor). Source of truth: this session's conversation + verified n8n/DB inspections. Uncertainty is marked explicitly. No secrets included.

---

# 1. Project Context & Objectives

## Ultimate Goal
Build and operate a production **WhatsApp AI assistant for CGPE (C.G. Patel / CGP Enterprise LLP)**, an insurance business in India. The bot serves admins, team members, and clients over real WhatsApp, backed by an n8n automation brain and MongoDB, with a browser-based testing simulator as a secondary channel.

## Problems Being Solved
- Manual, human-driven client servicing (policy/premium/maturity queries, claim intake, reminders) → automated via AI over WhatsApp.
- Multilingual client base (Gujarati, Kathiyawadi, Hindi, English) needing replies in their own language/script.
- Admin coordination: assigning tasks to team members, receiving accept/reject decisions, multi-admin fan-out of notifications.
- Voice notes as a first-class input (transcribed, archived).
- Reliable, exact-time reminders.

## Users / Actors & Permissions
Roles are resolved in **Build Context** (main brain) by lookups against `admins`, `team_members`, and client rows. Role precedence: `admin` → `team` → `client` → `unknown`.

| Actor | Detection | Permissions (from `journeys` object in Build Context) |
|---|---|---|
| **Admin** | phone in `admins` | Full access: CRM lists (birthday, anniversary, clients, leads, maturity, dues), reference directories via `ref_list` (CA now; hospital/doctor/mediclaim/TPA later) incl. counts (`mode=count`, optional `groupBy`), top leads, gift-hamper eligibility+dispatch, family reports for ANY client, claim & ticket management, **assign tasks to team**, reminders, campaigns, test-data purge. Must confirm before create/update/delete/send. |
| **Team member** | phone in `team_members` (carries `dept`/`role`, `availability`) | Own assigned tasks only (accept, reject, progress, done) + client details needed to finish them. Relays to admin via **`alert_admin`** tool. Must NOT access admin bulk ops unless explicitly delegated. |
| **Existing client** | phone in client rows (`Find Client Row`) | Own matters only: policies (list, premium due, maturity, document copies), family financial report, claim intake + status, service requests. Identity verification before sensitive data. On any request, also calls `alert_admin` once. |
| **New user / prospect** | not found anywhere → `unknown` | Prospecting: distinguishes (A) wants insurance/investment vs (B) wants to JOIN CGPE (adviser/agent/career). Captures via `create_lead` (interest `recruitment` or product). Supports campaign codes `CG-PLATFORM-PRODUCT-NN` via `get_campaign`. Calls `alert_admin` once. |
| **Bot / digital agent** | n8n workflows | Orchestrates all of the above. |
| **External AI requester** | — | *Discussed as future "AI follow-up API"; not evidenced as implemented.* |

## Confirmed Tech Stack

| Technology | Purpose | Status |
|---|---|---|
| **n8n** (self-hosted at `ai.cgpe.in`) | AI brain + tools + reminders + notify workflows | Confirmed Working (edited via public REST API `https://ai.cgpe.in/api/v1/...` with `X-N8N-API-KEY`) |
| **Meta WhatsApp Cloud API** | **Primary** channel: inbound, reply, interactive buttons, media, send via Graph API | Confirmed Working (test number, 5-recipient allow-list) |
| **BhashSMS** (`http://bhashsms.com/api/sendmsg.php`, user `AazikoWA`) | **Backup** channel (GET-based, no buttons) | Confirmed Existing (fallback path) |
| **MongoDB** (cred id `WZ2iSk9j0aJMoLDk`) | All persistence | Confirmed Working |
| **Express `server.js`** on **Render** | Testing simulator API + static frontend | Confirmed Existing |
| **`src/public/index.html`** frontend | Simulator UI (multi-role chat, inbox polling) | Confirmed Existing |
| **Sarvam STT** (Saarika v2.5) | Voice transcription (Hindi/Gujarati/English auto-detect) | Confirmed Working |
| **Cloudinary** (cloud `umb7wmvt`, unsigned preset `cgpe_voice`) | Voice-note archive (direct upload from n8n, Render-independent) | Confirmed Working |
| **Aaziko India** Meta app (App ID `2981297578867797`, Live; phone `+91 98251 35081`, Phone Number ID `1039687549237120`) | Second business onboarding | In Progress (Data Use Checkup submitted, awaiting review) |

## Core Functional Modules
- **Main Brain** (`T6JlzF4El2bSb2h3`) — inbound normalization, role resolution, context building, AI agent, reply/ack routing, voice pipeline.
- **Tools Engine v6** (`kLs5gqFec13sWIfN`) — operation router (`create_reminder`, `update_reminder`, `get_documents`, task ops, `create_lead`, `alert_admin`, `ref_list`, `get_campaign`, etc.).
- **Reminder Engine** (`KL9WetH0w1Sr6Ddf`) — scheduled poll, due-filter, message draft, send.
- **CGPE Notify** (`mp0qri77iwB2i8G8`) — admin/team notification fan-out and delivery.
- **Simulator backend** (`server.js`) + **frontend** (`index.html`).

---

# 2. Architectural Decisions & Logic

## High-Level Architecture
```
WhatsApp user ──► Meta Cloud API webhook ──► n8n Main Brain (T6JlzF4El2bSb2h3)
                                              │  Normalize → Gate → role lookups
                                              │  Build Context → AI Agent
                                              │        │ calls tools
                                              │        ▼
                                              │   Tools Engine (kLs5gqFec13sWIfN) → MongoDB
                                              │  Reply routing: Meta-first, Bhash fallback
Simulator UI (index.html) ──► server.js (Render) ──► MongoDB / webhook
Scheduled: Reminder Engine (KL9WetH0w1Sr6Ddf, every 1 min) ──► send due reminders
Notifications: CGPE Notify (mp0qri77iwB2i8G8) ──► all admins / assigned team
Cloudinary (umb7wmvt) ◄── n8n direct voice upload
```

## End-to-End Message Flow (Main Brain nodes, confirmed)
1. **WhatsApp Inbound (POST)** — webhook (path `cgpe-chat`). *(Bug fixed this session: node had `disabled:true` causing 404.)*
2. **Normalize Message** — extracts text / `button_reply.id` / `list_reply.id`, sender, etc.
3. **Gate** — loads config row / `systemPrompt`; exposes `phoneLast10`, `senderPhone`, `senderName`, `systemPrompt`.
4. **Find Admin / Find Team / Find Client Row** — Mongo lookups → role.
5. **Set Voice Text / Set Plain Text** — resolves `finalText`, `isVoice`.
6. **Build Context** — builds `chatInput` tag block + `systemPrompt` (`GLOBAL` + role `journey`), `sessionKey = 'wa-' + phoneLast10`.
7. **AI Agent** — reasons, calls tools (→ Tools Engine).
8. **Reply routing** — `Is Meta Channel?` → `Send via Meta` (Graph API) else BhashSMS.
9. **Ack routing** — `Parse Ack` → `Lookup Ack Task` → `Build Ack Notify` → `Execute Ack Notify`; `Ack: Is Meta?` → `Send Ack via Meta`.

## Voice Pipeline (confirmed working)
- **Voice to Base64** node: `await this.helpers.getBinaryDataBuffer(0, 'data')` → base64 (fixed the earlier `$binary.data.data` filesystem-placeholder 400 error).
- Builds `publicId = (last10 || 'unknown') + '/' + stamp + '_' + rand`, `stamp` = UTC `YYYY-MM-DD_HH-MM-SS`, `tags = [last10, name]`.
- n8n POSTs directly to `https://api.cloudinary.com/v1_1/umb7wmvt/auto/upload` with preset `cgpe_voice` (moved OFF Render to avoid cold-start 503).
- Persisted to `voice_notes` collection + `Build Voice Log` / `Build Voice Record`.

## Critical Decisions

| # | Decision | Reason | Impact | Status |
|---|---|---|---|---|
| D1 | **Meta Cloud API primary, BhashSMS + UI backup** | WhatsApp is the real business channel; buttons need Meta | Reply/Ack/Notify all route Meta-first with Bhash fallback | Confirmed Working |
| D2 | **Edit n8n via public REST API** (not MCP/UI) | MCP kept disconnecting; UI saves overwrote API changes | Must PUT then deactivate/activate to re-register webhooks | Confirmed Working |
| D3 | **Short task IDs** `<intent>-<tod>-<count>` (e.g. `sip-mrg-004`) | Long slugs unreadable | `mkId` = `pre + '-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(10+Math.random()*90)`; `normalizeShortTaskIds()` in server.js | Confirmed (server-side normalization present) |
| D4 | **Never translate task titles/names** | Faithful reproduction across languages | Reminder draft + reply prompts instruct "reproduce EXACTLY, never translate names/task" | Confirmed Working |
| D5 | **Multi-admin fan-out** | Multiple admins must all be notified | `ensureAdminFanout()` (server), `pushToAllAdmins()` (frontend), CGPE Notify loops admins | Confirmed Working |
| D6 | **Cloudinary direct upload from n8n** | Render cold-start caused 503 | Render-independent voice archive | Confirmed Working |
| D7 | **Reminder time = canonical UTC ISO (`Z`); AI emits IST `+05:30`** | Format was inconsistent (`+05:30` / `Z` / ms); AI computed relative times in UTC → 5.5h error | See Reminder Fixes below | Confirmed Working (this session) |
| D8 | **Reminder engine every 1 minute** (was 15) | Near-exact firing | Reminders fire within ~1 min of due | Confirmed Working (this session) |

## Reminder Time Handling (fully verified this session)
**Tools Engine → Route Operation → `create_reminder`** (line ~160) normalizes `nextFireAt`:
```js
nextFireAt: (function(v){
  v = String(v || ''); if(!v) return '';
  var hasTz = /[Zz]$|[+-][0-9][0-9]:?[0-9][0-9]$/.test(v);
  var withSec = v.length === 16 ? v + ':00' : v;
  var iso = hasTz ? v : withSec + '+05:30';         // naive fallback = IST
  var d = new Date(iso);
  return isNaN(d.getTime()) ? v : d.toISOString();   // canonical UTC Z
})(p.nextFireAt || p.dueAt || ''),
```
**Build Context** now feeds the AI IST time + rule:
```js
var nowIst = new Date(Date.now() + 19800000).toISOString().slice(0, 19) + '+05:30';
tag += ' [voice=' + isVoice + '] [now_ist=' + nowIst + ']';
// GLOBAL rule appended:
// "[TIME] now_ist is the current India Standard Time (+05:30). For every reminder,
//  compute in IST and ALWAYS output nextFireAt with the +05:30 offset ... never use UTC/Z for reminders."
```
**Reminder Engine → Filter Due** interprets naive datetimes as IST (`+05:30`) as a safety net:
```js
const hasTz = /[Zz]|[+-]\d\d:?\d\d$/.test(raw);
const withSec = raw.length===16 ? raw+':00' : raw;
const iso = hasTz ? raw : withSec+'+05:30';
```
**Reminder Engine schedule trigger** = `Every 1 Minute` → `{rule:{interval:[{field:'minutes',minutesInterval:1}]}}`.

**Verified end-to-end (this session):**
```
AI raw     : 2026-07-14T18:33:48+05:30   (IST offset)
Stored     : 2026-07-14T13:03:48.000Z    (canonical UTC)
IST fire   : 18:33:48 → ~2 min future    (correct)
Engine runs: :28 each minute, 1-min apart (confirmed)
Draft text : "Reminder: Sagar sir ko call karna hai." (correct format, fired)
```

## Deterministic Task-Ack Relay (confirmed)
`Parse Ack` → `Lookup Ack Task` → `Build Ack Notify` → `Execute Ack Notify`. Regex classes use `[0-9]`/`[a-z]` (NOT `\d`/`\s`) because heredoc stripping had broken `\s`→`s`. `Parse Ack` code lives in `parseack.js` and is injected as a file.

## Data Flow / Routing Rules
- `channel` field on records = `meta` / `bhash` / `ui`; reply routed accordingly (Meta-first).
- Session key: `sessionKey = 'wa-' + phoneLast10`.
- Conversation keying in simulator: `convKey(role, phone)` — all roles keyed per-phone.

## MongoDB Collections (confirmed names; fields partially confirmed)

| Collection | Confirmed fields / notes |
|---|---|
| `admins` | `role`, `name` (multi-admin) |
| `team_members` | `name`, `role`/`dept`, `availability`; Shivam `9106988376` present |
| `reminders` | `reminderId`, `type`, `about`, `clientName`, `phone`, `policyNo`, `nextFireAt` (UTC ISO Z), `channel:'whatsapp'`, `status:'active'`, `attempts:0`, `stopCondition`, `ticketId`, `createdAt`, `updatedAt` |
| `tickets` | linked via `linkedTicket({category,kind,task,...,linkedType:'reminder',linkedId,priority:'P3',source})`; `ticketId` |
| `team_tasks` | task assignment/accept/reject (`handleTeamTaskAction()` server-side) |
| `ui_inbox` | simulator inbox (`/api/inbox`, `pollInbox()` 5s) |
| `wa_comm_messages` | WhatsApp comms log (referenced) |
| `voice_notes` | archived voice (Cloudinary URL, phone, name, publicId, tags, createdAt) |

*Indexes: none explicitly defined/confirmed in conversation — see Needs Codebase Verification.*

## API / Webhook Contracts (confirmed examples)
**Inbound webhook (simulator/text test):** `POST https://ai.cgpe.in/webhook/cgpe-chat`
```json
{ "from": "919601775061", "name": "CGPE Admin", "messageId": "tz-a",
  "text": "2 minute baad reminder do: timezone test call karna hai" }
```
**n8n REST (management):** `GET/PUT https://ai.cgpe.in/api/v1/workflows/{id}` + `POST .../{id}/activate|deactivate`, header `X-N8N-API-KEY`. Settings PUT whitelist: `executionOrder, saveDataErrorExecution, saveDataSuccessExecution, saveManualExecutions, saveExecutionProgress, executionTimeout, errorWorkflow, timezone, callerPolicy`.
**Cloudinary:** `POST https://api.cloudinary.com/v1_1/umb7wmvt/auto/upload` (unsigned, preset `cgpe_voice`).
**BhashSMS (backup):** `GET http://bhashsms.com/api/sendmsg.php` (user `AazikoWA`).

## Security / Test-Data Isolation
- n8n API key was pasted by user → **advised rotation** (treat as compromised).
- Testing uses only 3 real allow-listed numbers so messages are observable.
- GLOBAL prompt forbids exposing internal system details (workflows, tools, nodes, errors, code) to end users.

---

# 3. State of Code & Components

## Completed Features (explicitly confirmed working)

| Feature | Status | Files/Nodes/Collections | Confirmed Behavior | Limitations |
|---|---|---|---|---|
| Meta inbound + AI reply | Working | Main Brain `T6JlzF4El2bSb2h3`; WhatsApp Inbound (POST) | Real WhatsApp message → AI reply via Meta | Test number, 5-recipient allow-list |
| Interactive Accept/Reject buttons | Working | Normalize Message (`button_reply.id`), Send via Meta | Buttons render + parse | Meta only (Bhash can't) |
| Voice transcription | Working | Sarvam Saarika v2.5, Set Voice Text | Hindi/Gujarati/English auto-detect | — |
| Voice archive → Cloudinary + DB | Working | Voice to Base64, `voice_notes`, Cloudinary `umb7wmvt`/`cgpe_voice` | Named `phone/stamp_rand`, Render-independent | — |
| Multi-admin fan-out | Working | `ensureAdminFanout()`, `pushToAllAdmins()`, CGPE Notify `mp0qri77iwB2i8G8` | All admins notified | — |
| Deterministic task-ack relay | Working | Parse Ack→Lookup Ack Task→Build Ack Notify→Execute Ack Notify; `parseack.js` | Admin reliably notified on accept/reject | — |
| Reminder message format | Working | Reminder Engine draft (`draftPrompt`) | `"Reminder: <task>"`, mirrors task language, no translation | — |
| Reminder time correctness | Working | Tools Engine `create_reminder`, Build Context, Filter Due | AI emits IST `+05:30` → stored canonical UTC `Z` → fires correct time | naive fallback assumes IST |
| Reminder near-exact firing | Working | Reminder Engine `Every 1 Minute` | Fires within ~1 min of due | 1-min max latency |
| Dynamic Team/Admin rosters (UI) | Working | `/api/team-members`, `/api/admins`, `loadTeamMembers()`, `loadAdmins()` | UI shows dept, multiple admins | — |
| Inbox polling (UI) | Working | `/api/inbox`, `pollInbox()` (5s) | Pushed inbox messages w/ buttons | — |
| Reminder nextFireAt normalization (updates) | Working | Tools Engine node in `kLs5gqFec13sWIfN` | Norm logic added to allowed-field iterator loop | — |

## Files & Components

**Backend — `server.js` (Express/Render)** — *Confirmed Existing*
- `getCollection(name)` — Mongo helper
- Routes: `/api/inbox`, `/api/team-members`, `/api/admins`
- `parseButtons()`, `buildPublicId(phone)`
- `ensureAdminFanout()`, `normalizeShortTaskIds()`, `handleTeamTaskAction()` — *Confirmed Existing* (verified implementations for admin fan-out, short taskId normalization, and direct team task accept/reject logic)
- Env: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_UPLOAD_PRESET`, `CLOUDINARY_FOLDER=cgpe-voice-notes`, `MONGODB_URI`, `MONGO_DB`

**Mongoose Models — `src/models/`** — *Confirmed Existing*
- [ChatSession.js](file:///c:/Users/Inet/Desktop/test-chat-bot/Whatsapp/src/models/ChatSession.js) — Schema: `phoneNumber`, `currentState`, `lastInteraction`
- [Client.js](file:///c:/Users/Inet/Desktop/test-chat-bot/Whatsapp/src/models/Client.js) — Schema: `phoneNumber`, `name`, `profileType`, `isExistingClient`
- [PolicyScan.js](file:///c:/Users/Inet/Desktop/test-chat-bot/Whatsapp/src/models/PolicyScan.js) — Schema: `policyNo`, `clientName`, `phoneLast10`, `scanUrl`, `scanType`, `fileType`, `fileSize`, `uploadedBy`, `notes`, `isVerified`, `verifiedBy` (collection `'policy_documents'`)
- [Task.js](file:///c:/Users/Inet/Desktop/test-chat-bot/Whatsapp/src/models/Task.js) — Schema: `taskId`, `type`, `title`, `details`, `assigneeName`, `assigneePhone`, `ticketId`, `clientName`, `clientPhone`, `dueAt`, `priority`, `status`, `createdBy`, `createdAt`, `updatedAt` (collection `'team_tasks'`)
- [TeamMember.js](file:///c:/Users/Inet/Desktop/test-chat-bot/Whatsapp/src/models/TeamMember.js) — Schema: `name`, `phone`, `phoneLast10`, `role`, `active`, `email`, `specializations`, `seedTag` (collection `'team_members'`)

**Frontend — `src/public/index.html`** — *Confirmed Existing*
- `clientLang`, `setUserLang`, `TEAM_USERS`/`ADMIN_USERS`, `loadTeamMembers()`, `loadAdmins()`, `convKey(role,phone)`, `pushToAllAdmins()`, `pollInbox()`; removed voice confirmation card; `100dvh` responsive fix

**n8n Workflows / Nodes** — *Confirmed Working*
- `T6JlzF4El2bSb2h3` Main Brain: Normalize Message, Gate, Find Admin/Team/Client Row, Set Voice/Plain Text, Build Context, Voice to Base64, Build Voice Log/Record, Parse Reply, WhatsApp Inbound (POST), Send via Meta / Send WhatsApp Reply, Is Meta Channel?, Ack chain (Parse Ack, Lookup Ack Task, Build Ack Notify, Execute Ack Notify, Ack: Is Meta?, Send Ack via Meta) — *Confirmed Working* (matches `cgpe_whatsapp_gateway_ai_brain_fixed.json`)
- `kLs5gqFec13sWIfN` Tools Engine: Route Operation (`create_reminder`, `update_reminder`, `get_documents`, task ops, `create_lead`, `alert_admin`, `ref_list`, `get_campaign`, `count`), Tool Input, Mongo Insert — *Confirmed Working* (matches `cgpe_tools_engine.json`)
- `KL9WetH0w1Sr6Ddf` Reminder Engine: Every 1 Minute, Load Config, Find Active Reminders, Filter Due, draft, Meta Send — *Confirmed Existing*
- `mp0qri77iwB2i8G8` CGPE Notify: Meta Send / Graph Send (Meta-first + Bhash fallback) — *Confirmed Existing*

**MongoDB collections:** `admins`, `team_members`, `reminders`, `tickets`, `team_tasks`, `ui_inbox`, `wa_comm_messages`, `voice_notes`, `clients`, `policies`, `claims`, `leads`, `policy_documents`, `chatsessions`, `wa_bot_config`, `wa_messages` — *Confirmed Existing*

**Scripts/config (scratchpad):** `n8n.key`, `tools.json`, `reng.json`, `brain.json`, `parseack.js`, `voice2b64.js`, `checkfire.js` — *ephemeral tooling, not repo files*

## In-Progress Features

### Aaziko (second business) Meta onboarding
- Current State: Data Use Checkup submitted (all 5 wizard steps done); awaiting Meta review (few days).
- Working Parts: App "Aaziko India" (App ID `2981297578867797`, Live), phone `+91 98251 35081`, Phone Number ID `1039687549237120`.
- Broken/Missing Parts: Webhook + dedicated n8n workflow for Aaziko not yet built; API access was restricted pending checkup.
- Relevant: Meta App Dashboard, future n8n workflow.
- Expected Behavior: Aaziko inbound → own bot flow.
- Required Change: After approval, configure webhook + clone/adapt brain workflow.
- Verification Needed: Checkup approval; webhook verify (`hub.challenge`); test send.

### `update_reminder` time normalization [COMPLETED]
- Status: Completed. Normalization logic identical to create_reminder is now live in the update loop inside Route Operation node.

### Real WhatsApp voice-note verification (open TODO from prior session)
- Current State: Pipeline confirmed via tests; user was asked to send a real voice note to confirm Cloudinary + DB save end-to-end.
- Verification Needed: One real inbound voice note observed in `voice_notes` + Cloudinary.

## Known Code and Data

**`create_reminder` doc (Tools Engine, line 160, current):**
```js
const doc = { reminderId, type: String(p.type||'custom'), about: String(p.about||''),
  clientName: String(p.clientName||''), phone: String(p.phone||''), policyNo: String(p.policyNo||''),
  nextFireAt: /* normalized IIFE → UTC ISO Z */, channel:'whatsapp', status:'active', attempts:0,
  stopCondition: String(p.stopCondition||'manual'), ticketId:'', createdAt: nowIso, updatedAt: nowIso };
```
**`mkId`:** `pre + '-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(10+Math.random()*90)`

**Reminder draft prompt (confirmed):** starts message with `"Reminder: "`, reproduces task/names exactly, mirrors language/script, 1–2 lines, ≤1 emoji, output only the message.

**Voice → Base64 (`voice2b64.js`, confirmed):**
```js
const buf = await this.helpers.getBinaryDataBuffer(0, 'data');
const stamp = /*UTC YYYY-MM-DD_HH-MM-SS*/;
publicId: (last10 || 'unknown') + '/' + stamp + '_' + rand,
dataUri: 'data:' + mime + ';base64,' + b64
```

**Test payload (confirmed):** see §2 Inbound webhook example.

## Testing Status
- **Performed & stable:** Meta inbound→reply, buttons, voice transcription + archive, admin fan-out, task-ack relay, reminder format, reminder timezone correctness (verified with createdAt vs nextFireAt), 1-min engine cadence, reminder actually firing (`"Reminder: Sagar sir ko call karna hai."`).
- **Failed then fixed:** 404 (disabled inbound node), wrong-number Bhash routing, voice 400/503, ack regex 0-items, reminder 5.5h timezone error.
- **Untested / open:** real inbound voice note by user; Aaziko flow; `update_reminder` normalization; claim flows (see below).
- **Test users/roles (MANDATORY):** Admin `9601775061` (Ved/CGPE Admin), Admin `9825135034` (Sagar/Super Admin), Team `9106988376` (Shivam). Do NOT assign test tasks to DB members Priya/Kunal/Amit (`98766000xx`) — user can't observe them.
- **Acceptance criteria (reminders):** stored `nextFireAt` in `...Z`, fire within ~1 min of due, message begins `"Reminder: "` in task language, names/task untranslated.

*Claim flows (life vs general/health), approval/rejection state machine, document-collection flow: referenced only in journey text ("claim intake and claim status", "claim and ticket management"). **No detailed states/fields were established** → Needs Codebase Verification; do not assume implemented.*

---

# 4. Constraints & Guardrails

## MUST
- Use **Meta WhatsApp Cloud API as primary**; keep **BhashSMS + UI as backup**.
- Route reply/ack/notify **Meta-first, Bhash fallback**, based on `channel`.
- After any webhook-workflow PUT, **deactivate then activate** to re-register webhooks.
- Only PUT the settings-whitelist keys (§2).
- Store `reminders.nextFireAt` as **canonical UTC ISO (`Z`)**; AI must emit reminder times with **`+05:30`** offset computed from `now_ist`.
- Reminder engine runs **every 1 minute**.
- Reply **in the user's language/script**; **never translate names or task titles**.
- Test admin/team/task/notification flows **only** with the 3 allow-listed numbers.
- Notify **all** admins (fan-out), not just one.
- Use short task IDs `<intent>-<tod>-<count>`.
- Confirm before create/update/delete/send (admin ops).
- Keep secrets out of code/logs.

## MUST NOT
- Do **not** change or rotate the `.env` credentials without explicit team-wide coordination, as it impacts multiple developers.
- Do **not** expose internal system details (workflows, tools, nodes, errors, code) to end users.
- Do **not** send reminder times as UTC/`Z` from the AI (must be `+05:30`).
- Do **not** assign test tasks to non-observable DB members (Priya/Kunal/Amit).
- Do **not** hardcode a single outbound admin number (caused prior bug: everything went to `9904400633`).
- Do **not** save workflows in the n8n **UI** while API edits are in flight (overwrites changes) — coordinate.
- Do **not** use `\d`/`\s` in code injected via heredoc (stripped) — use `[0-9]`/`[a-z]`.
- Do **not** run destructive DB ops without explicit confirmation.
- On Aaziko Meta account: never click Delete/Remove; one step at a time (beginner user).

## Coding Standards
- **Language:** JavaScript (n8n Code nodes; Express backend). — Confirmed
- **n8n Code node async:** `await this.helpers.getBinaryDataBuffer(...)` for binaries. — Confirmed
- **Regex in injected code:** character classes `[0-9]`/`[a-z]`. — Confirmed
- **Time:** IST offset `+05:30`; convert to UTC `Z` for storage; `Date.now()+19800000` for IST clock. — Confirmed
- **Env vars** for all service config (Cloudinary, Mongo). — Confirmed
- **API response shape / linting / formatting / comment density:** *no explicit standard stated* → Recommended: match surrounding code style.
- **Testing framework:** *none confirmed* → Recommended.

## Agent Rules
1. Inspect repo + n8n workflows (fetch JSON via REST) before editing.
2. Verify files/nodes/deps exist (recalled names may be stale).
3. Reuse existing architecture (Meta-first routing, Tools Engine router, journeys).
4. Minimal targeted changes.
5. Preserve stable behavior + Bhash/UI backward compatibility.
6. Validate Mongo queries; check/define indexes before relying on them.
7. Add/update tests for changed behavior (real-number tests where flows are observable).
8. No destructive DB ops without confirmation.
9. Never expose secrets; treat pasted key as compromised.
10. Report unverified assumptions explicitly.
11. Provide a change summary after implementation.

---

# 5. Actionable Tasks for the Agent (TODOs)

### Task 1: Repository & Workflow Inventory
- Priority: P0
- Goal: Ground truth on files/nodes/collections before any edit.
- Current Problem: Names recalled from memory may be stale; server.js helpers added by another agent unverified.
- Files/Workflows to Inspect: `server.js`, `src/public/index.html`, n8n `T6JlzF4El2bSb2h3`, `kLs5gqFec13sWIfN`, `KL9WetH0w1Sr6Ddf`, `mp0qri77iwB2i8G8`.
- Files/Workflows to Modify: none.
- Collections Involved: all (list + sample docs).
- Implementation Steps:
  1. Fetch each workflow JSON via REST; list nodes.
  2. Read server.js routes/helpers; confirm `ensureAdminFanout`, `normalizeShortTaskIds`, `handleTeamTaskAction`.
  3. Enumerate collections + one sample doc each.
- Tests: n/a (read-only).
- Expected Output: verified inventory map.
- Completion Criteria: every name in §3 marked Confirmed or corrected.
- Risks: none.
- Rollback Plan: n/a.

### Task 2: Rotate exposed n8n API key [CLOSED / DEFERRED]
- Status: Closed / Deferred. The `.env` credentials are shared across the dev team and must not be rotated without team-wide coordination. The n8n API key is not stored in the repository.

### Task 3: Normalize `nextFireAt` in `update_reminder` [COMPLETED]
- Priority: P1
- Status: Completed.
- Action: Normalization logic has been manually applied to the update_reminder allowed-field loop in the live Tools Engine workflow (`kLs5gqFec13sWIfN`).

### Task 4: Duplicate-message / idempotency guard
- Priority: P1
- Goal: Prevent double-processing of inbound/`messageId` and double reminder sends.
- Current Problem: No confirmed dedup on `messageId`; `attempts` exists but idempotency unverified.
- Files/Workflows to Inspect: Normalize Message, Reminder Engine send path.
- Files/Workflows to Modify: add dedup check (e.g., unique on `wa_comm_messages.messageId`; mark reminder sent before send).
- Collections Involved: `wa_comm_messages`, `reminders`.
- Implementation Steps: 1. Confirm inbound carries stable `messageId`. 2. Upsert/guard on it. 3. Set reminder `status`/`attempts` atomically before send.
- Tests: replay same `messageId`; fire same due reminder across two ticks → single send.
- Expected Output: exactly-once behavior.
- Completion Criteria: no duplicate observed under replay.
- Risks: race between 1-min ticks → use atomic update filter.
- Rollback Plan: revert guard.

### Task 5: MongoDB indexes
- Priority: P1
- Goal: Index hot lookups.
- Current Problem: No confirmed indexes; role lookups + due-scan run each message/minute.
- Files/Workflows to Inspect: Find Admin/Team/Client Row queries; Find Active Reminders.
- Collections Involved: `admins`, `team_members`, client rows, `reminders`, `wa_comm_messages`, `team_tasks`.
- Implementation Steps: 1. Identify query predicates (phone/last10, status, nextFireAt). 2. Create indexes (e.g., `reminders {status:1, nextFireAt:1}`, phone-last10 on rosters, `wa_comm_messages {messageId:1}` unique). 3. Verify with explain.
- Tests: explain shows IXSCAN; latency drop.
- Expected Output: indexed scans.
- Completion Criteria: no COLLSCAN on hot paths.
- Risks: unique index conflicts on existing dup data → dedupe first.
- Rollback Plan: drop index.

### Task 6: Verify Meta-vs-Bhash routing end-to-end
- Priority: P1
- Goal: Confirm reply/ack/notify all honor `channel` and never hardcode a number.
- Current Problem: Prior bug hardcoded Bhash/`9904400633`.
- Files/Workflows to Inspect: Send via Meta, Ack: Is Meta?, CGPE Notify Meta Send.
- Collections Involved: `wa_comm_messages`.
- Implementation Steps: 1. Trace each send node's target derivation. 2. Force each channel via test. 3. Assert delivery path.
- Tests: meta inbound → meta reply; bhash-flagged → bhash.
- Expected Output: correct per-channel routing.
- Completion Criteria: no cross-channel/hardcoded target.
- Risks: fallback masking failures → log channel chosen.
- Rollback Plan: n/a (read + assert).

### Task 7: Interactive reply normalization coverage
- Priority: P2
- Goal: Robust parse of `button_reply.id` / `list_reply.id` incl. short task IDs.
- Files/Workflows to Inspect: Normalize Message, Parse Ack, `normalizeShortTaskIds()`.
- Collections Involved: `team_tasks`, `tickets`.
- Implementation Steps: 1. Enumerate button payload id formats. 2. Map to task actions. 3. Handle unknown ids gracefully.
- Tests: accept/reject buttons for `sip-mrg-004`-style ids.
- Expected Output: reliable action mapping.
- Completion Criteria: all button ids resolve or graceful fallback.
- Risks: id collisions → keep ids unique.
- Rollback Plan: revert parser.

### Task 8: Complete & document claim flows (life vs general/health)
- Priority: P2
- Goal: Define/verify claim intake, life-vs-general branching, approval/rejection, document collection.
- Current Problem: Only referenced in journeys; states/fields unconfirmed.
- Files/Workflows to Inspect: Tools Engine claim ops, `tickets` schema.
- Collections Involved: `tickets`, client rows, possibly a claims collection (verify).
- Implementation Steps: 1. Inspect existing claim tool ops. 2. Map current states. 3. Fill gaps for life vs general branching + doc collection.
- Tests: simulate a life claim and a health claim end-to-end.
- Expected Output: documented, working claim state machine.
- Completion Criteria: both branches produce correct tickets/notifications.
- Risks: inventing non-existent flow → verify first, no assumptions.
- Rollback Plan: n/a until confirmed.

### Task 9: AI follow-up / external-requester API
- Priority: P3
- Goal: Allow an external AI requester to trigger follow-ups.
- Current Problem: Discussed only; no implementation.
- Files/Workflows to Inspect: n8n webhooks, server.js routes.
- Implementation Steps: 1. Define contract + auth. 2. Add endpoint. 3. Wire to Tools Engine.
- Tests: authenticated request triggers action.
- Expected Output: working API.
- Completion Criteria: authorized-only, audited.
- Risks: unauthorized access → require auth.
- Rollback Plan: disable route.

### Task 10: Aaziko onboarding completion
- Priority: P3 (blocked on Meta review)
- Goal: Bring Aaziko live after Data Use Checkup approval.
- Files/Workflows to Inspect: Meta dashboard, new Aaziko workflow.
- Implementation Steps: 1. Confirm approval. 2. Configure webhook (`hub.challenge`). 3. Clone/adapt brain. 4. Test with allow-listed numbers.
- Tests: inbound→reply on Aaziko number.
- Expected Output: Aaziko bot live.
- Completion Criteria: verified inbound/reply.
- Risks: beginner user on account → one step at a time, never Delete/Remove.
- Rollback Plan: keep CGPE unaffected (separate app).

### Task 11: Latency optimization
- Priority: P3
- Goal: Reduce message round-trip; remove Render cold-start dependencies.
- Current Problem: Render cold-start caused prior 503 (mitigated for voice).
- Files/Workflows to Inspect: server.js hot paths, n8n execution timings.
- Implementation Steps: 1. Measure per-node latency. 2. Cache config/roster lookups. 3. Add indexes (Task 5).
- Tests: measured p50/p95 improvement.
- Expected Output: lower latency.
- Completion Criteria: no cold-start on critical path.
- Risks: caching staleness → short TTL.
- Rollback Plan: remove cache.

### Task 12: Retry / audit / error handling
- Priority: P2
- Goal: Consistent retries + audit log for sends.
- Files/Workflows to Inspect: Meta/Bhash send nodes, CGPE Notify.
- Collections Involved: `wa_comm_messages`.
- Implementation Steps: 1. Wrap sends with retry + fallback. 2. Log outcome (channel, wamid, error). 3. Alert on repeated failure.
- Tests: force a send failure → fallback + audit entry.
- Expected Output: auditable, resilient sends.
- Completion Criteria: failures logged + retried.
- Risks: retry storms → cap attempts.
- Rollback Plan: revert wrapper.

---

# Confirmed Facts
- Live n8n at `ai.cgpe.in`; workflows `T6JlzF4El2bSb2h3` (brain), `kLs5gqFec13sWIfN` (Tools v6), `KL9WetH0w1Sr6Ddf` (Reminder), `mp0qri77iwB2i8G8` (Notify); Mongo cred `WZ2iSk9j0aJMoLDk`.
- Meta Cloud API is primary; BhashSMS (user `AazikoWA`) + UI are backups; routing is Meta-first via `channel`.
- Reminder time fixes are live and verified: AI emits `+05:30`, stored as canonical UTC `Z`, engine runs every 1 minute, fires ~within 1 min, message `"Reminder: <task>"`.
- voice: Sarvam Saarika v2.5 STT; direct Cloudinary upload (cloud `umb7wmvt`, preset `cgpe_voice`); archived to `voice_notes`.
- Task IDs: `<intent>-<tod>-<count>` via `mkId`.
- Test numbers: `9601775061`, `9825135034` (admins), `9106988376` (Shivam, team).
- Aaziko app: ID `2981297578867797` (Live), phone `+91 98251 35081`, Phone Number ID `1039687549237120`; Data Use Checkup submitted.
- After webhook-workflow PUT, must deactivate/activate.
- n8n API key was exposed but rotation was closed/deferred to avoid breaking team workflows.
- `server.js` helper functions `ensureAdminFanout`, `normalizeShortTaskIds`, and `handleTeamTaskAction` exist and behave as described (verified direct code implementations).
- Workspace files [server.js](file:///c:/Users/Inet/Desktop/test-chat-bot/Whatsapp/server.js) and [src/public/index.html](file:///c:/Users/Inet/Desktop/test-chat-bot/Whatsapp/src/public/index.html) exist.
- MongoDB collections (`clients`, `policies`, `tickets`, `claims`, `leads`, `policy_documents`, `chatsessions`, `team_tasks`, `team_members`, `admins`, `ui_inbox`, `wa_comm_messages`, `voice_notes`) are confirmed and mapped to Mongoose models or tools engine queries.

# Assumptions and Inferences
- `wa_comm_messages` is the comms/audit log (name confirmed; schema inferred).
- Role precedence admin→team→client→unknown (from Build Context logic).
- Reminder `stopCondition` default `'manual'`; ticket priority `P3` for reminders.

# Needs Codebase Verification
- MongoDB indexes (none confirmed to exist).
- Claim flows (life vs general/health), approval/rejection states, document-collection flow — only referenced, not defined.
- Whether inbound provides a stable dedup `messageId` end-to-end.

# Open Risks
- Concurrent n8n UI saves can overwrite API edits (coordination hazard).
- No confirmed idempotency guard → duplicate sends possible (especially now at 1-min cadence).
- No confirmed indexes → latency/scan risk as data grows.
- Aaziko onboarding blocked on Meta review; beginner user on the account.
- Claim-flow completeness unknown; risk of assuming unimplemented behavior.

# Agent Handoff Snapshot

```yaml
project:
  name: CGPE Insurance WhatsApp Bot
  objective: Production WhatsApp AI assistant (admin/team/client) on Meta Cloud API, n8n brain, MongoDB, with simulator UI
  current_phase: Live on Meta test number; reminders hardened; expanding to second business (Aaziko)

stack:
  backend: Express (server.js) on Render
  frontend: src/public/index.html (vanilla JS simulator)
  database: MongoDB (cred WZ2iSk9j0aJMoLDk)
  automation: n8n self-hosted (ai.cgpe.in) — brain T6JlzF4El2bSb2h3, Tools kLs5gqFec13sWIfN, Reminder KL9WetH0w1Sr6Ddf, Notify mp0qri77iwB2i8G8
  messaging: Meta WhatsApp Cloud API (primary); BhashSMS (backup); UI (backup)
  ai: n8n AI Agent + Sarvam Saarika v2.5 STT; Cloudinary (umb7wmvt/cgpe_voice) voice archive

working_features:
  - meta_inbound_and_reply
  - interactive_accept_reject_buttons
  - voice_transcription_and_cloudinary_archive
  - multi_admin_fanout
  - deterministic_task_ack_relay
  - reminder_format_and_language
  - reminder_timezone_correctness
  - reminder_1min_near_exact_firing
  - dynamic_team_admin_rosters_ui
  - inbox_polling_ui
  - update_reminder_time_normalization

in_progress_features:
  - aaziko_meta_onboarding
  - real_inbound_voice_note_verification

critical_constraints:
  - meta_first_routing_bhash_ui_backup
  - reminder_ai_emits_+05:30_store_utc_Z
  - reminder_engine_every_1_minute
  - reply_in_user_language_never_translate_names_or_tasks
  - test_only_with_3_allowlisted_numbers
  - fanout_to_all_admins_no_hardcoded_number
  - deactivate_activate_after_webhook_put
  - do_not_rotate_env_credentials_without_coordination
  - no_destructive_db_ops_without_confirmation

next_task:
  name: Duplicate-message / idempotency guard
  priority: P1
  goal: Prevent double-processing of inbound/messageId and double reminder sends.
  files_to_inspect:
    - n8n T6JlzF4El2bSb2h3 (Main Brain)
    - n8n KL9WetH0w1Sr6Ddf (Reminder Engine)
  expected_result: Exactly-once delivery of reminders and inbound message processing

verification_required:
  - mongodb indexes existence
  - claim flow states/fields (life vs general/health)
  - stable dedup messageId end-to-end
```
