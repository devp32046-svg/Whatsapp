# CGPE AI WhatsApp Gateway — Features & Functionalities

A detailed description of everything this platform delivers. The project is a **high-fidelity WhatsApp Business simulator UI** wired to a **live production AI bot** (n8n at `https://ai.cgpe.in`), letting you test complete multi-user insurance workflows — text, voice, attachments, tasks, reminders and notifications — without physical WhatsApp handsets.

---

## 1. System Overview

```
┌───────────────────────────────────────────────────────────────┐
│  FRONTEND — WhatsApp Simulator UI (src/public/index.html)      │
│  Roles: 👤 Client · 🔧 Admin · 🧑‍💼 Team   |  Language picker    │
└───────────────┬───────────────────────────────────────────────┘
                │  POST /api/chat · POST /api/upload · GET /api/inbox
┌───────────────▼───────────────────────────────────────────────┐
│  BACKEND — Express proxy (server.js) on Render                 │
│  • Chat proxy & response normalization                         │
│  • Media upload → Cloudinary (raw-serving, foldered)           │
│  • Inbox poll → reads ui_inbox from MongoDB                    │
└───────────────┬───────────────────────────────────────────────┘
                │  HTTPS webhook  +  shared MongoDB
┌───────────────▼───────────────────────────────────────────────┐
│  AI BRAIN — n8n workflow "CGPE — WhatsApp Gateway + AI Brain"  │
│  • Multi-lingual GPT agent with tools                          │
│  • Sarvam voice transcription (Indian languages)               │
│  • Policies, claims, tickets, leads, reminders, notifications  │
│  • Reminder Engine (scheduled) + Notify (cross-user)           │
└───────────────────────────────────────────────────────────────┘
```

---

## 2. Frontend UI Features

### 2.1 Multi-Role Workspace
Instant, state-isolated switching between three operational roles from the top bar:

| Role | Who it simulates | Default identity |
|------|------------------|------------------|
| 👤 **Client** | Policyholder / new inquiry chatting with the bot | Selectable (see client dropdown) |
| 🔧 **Admin** | CGPE operations desk — claims, tasks, reports | `919601775061` |
| 🧑‍💼 **Team** | Internal staff (Ops Lead / Claims / Sales) | Selectable member (see team dropdown) |

Each role has its own independent chat thread; switching roles never mixes conversations.

**Team-member dropdown:** on the Team tab a dropdown lets you switch between all internal members — **Priya Desai (Ops Lead)**, **Amit Shah (Claims Officer)**, **Kunal Mehta (Sales Specialist)**. Each member has an **isolated task inbox** (`conversations["team_" + phone]`), so a task assigned to Kunal appears only in Kunal's tab, and each member's pushed notifications/reminders are polled per their own phone.

### 2.2 Multi-Client Dropdown (real DB clients)
The Client workspace has a dropdown pre-loaded with **authentic clients matched to their 9-digit LIC policy numbers**:

- Agrawal Rajesh (#9012) — `919876500009`
- AARDESHANA ANILBHAI (#864805904) — `919825100001`
- AGHERA KANTIBHAI (#864805911) — `919825100002`
- AGRAVAT PARIXIT (#864805922) — `919825100003`
- AMDAWADI KARSHANBHAI (#864805933) — `919825100004`

Each client keeps an **isolated conversation history** (`conversations["client_" + phone]`); switching clients loads their independent thread with no state contamination.

### 2.3 New Lead / Custom User
`+ Add Custom User…` opens a modal to enter any new prospect's name and phone (e.g. a number **not** in the database). New leads get a **language-first onboarding** flow instead of existing-policyholder options.

### 2.4 Language Control (🌐 header picker)
A dedicated language dropdown lets **any user** (client/admin/team) force the conversation language:

- 🌐 **Auto** — bot detects language from the message
- 🇮🇳 **हिन्दी (Hindi)** — locks replies + voice transcription to Hindi
- 🇮🇳 **ગુજરાતી (Gujarati)** — locks to Gujarati
- 🇬🇧 **English**

The chosen language is remembered **per phone number** and sent with every message (`lang` field), so the bot both **transcribes** and **replies** in the correct language and script.

### 2.5 Text Messaging
Type any message; it is sent to the live AI bot via the proxy. Bot replies render with:
- **Clickable links** (URLs auto-linkified, HTML-escaped for safety)
- **Interactive reply buttons** (e.g. `[yes] [no]`) that the bot returns
- Typing indicator while the AI processes

### 2.6 Voice Messaging (voice-in → AI reply)
- Tap the 🎤 mic to record a live voice note (Web Audio API → WAV)
- The audio uploads through `/api/upload` and is sent to the bot as `type: audio`
- The bot **transcribes** it (Sarvam, Indian-language ASR) and replies
- **No confirmation step** — voice goes straight to the bot for a fast, natural flow
- Transcription language follows the header language picker (or auto-detect)

### 2.7 File Attachments
The 📎 button uploads PDFs, images, or documents. Files are proxied to public hosting and passed to the AI engine (with filename) for OCR / parsing. Supported message types: `image`, `document`, `video`, `audio`.

### 2.8 Admin → Team Task Assignment
From the Admin tab, **📌 Assign Task to Team**:
- Pick a team member (Priya Desai / Amit Shah / Kunal Mehta)
- Enter task instructions and a priority (High 🔴 / Medium 🟡 / Normal 🟢)
- The selected member receives a formatted **Task Card** with `[✅ Accept] [❌ Decline]` **in their own inbox**
- A "switch to that member" shortcut jumps straight to the assignee's tab
- On Accept/Decline, an **acknowledgment card** is generated in the Admin inbox

### 2.9 Live Inbox (pushed messages)
The UI polls `GET /api/inbox` every 5 seconds and renders any messages the bot **proactively pushed** to the current user:
- ⏰ **Scheduled reminders** (from the Reminder Engine)
- 🔔 **Cross-user notifications** (e.g. a team member's reassignment request routed to Admin)

Polling is per-phone, so each client and each team member sees only their own pushed messages. This makes the simulator "live" — messages that arrive on real WhatsApp also surface in the UI.

### 2.10 Quality-of-life
- 🌙 Dark / light theme toggle
- Per-conversation clear-chat
- Sidebar with recent-message previews
- Async targeted router: replies are routed to the correct user's thread even if you switch users mid-request (no cross-talk / race conditions)

---

## 3. Backend Features (Express — `server.js`)

### 3.1 `POST /api/chat` — Chat proxy
Forwards the UI payload to the live CGPE webhook and **normalizes** the response so the UI always gets a clean shape:
- Proper object `{ ok, reply, buttons }` → passed through
- Plain string → wrapped as a reply
- Empty / null → friendly "try again" fallback
- Connection failure → graceful error message
- 90s timeout (AI can take up to ~60s)

### 3.2 `POST /api/upload` — Media upload
Receives base64 media and returns a **public, raw-serving URL** the bot can download:
- **Cloudinary** (primary) — reliable from cloud hosts like Render, serves raw bytes, stores everything in a configurable folder (`cgpe-audio` by default)
- litterbox / catbox — local-dev fallbacks
- Env-driven: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_UPLOAD_PRESET`, `CLOUDINARY_FOLDER`

### 3.3 `GET /api/inbox` — Inbox poll
Returns undelivered pushed messages (reminders / notifications) for a given phone from the `ui_inbox` MongoDB collection, marks them delivered, and returns them once. Fails soft (empty list) if the DB isn't configured, so the UI never breaks. Env-driven: `MONGODB_URI` (+ optional `MONGO_DB`).

---

## 4. AI Bot Capabilities (n8n)

### 4.1 Multi-Lingual Conversation
- Understands and replies in **Gujarati, Hindi, and English** (plus romanized Gujlish / Hinglish)
- **Strict language policy**: mirrors the customer's language and script for the whole conversation; a pure-Hindi speaker gets pure Hindi (Devanagari), a Gujarati speaker gets Gujarati script — never drifts into another language, never replies in Telugu/Tamil/etc.
- Honors the explicit language selection passed from the UI

### 4.2 Voice Transcription (Sarvam ASR)
- Voice notes are transcribed by **Sarvam Saarika v2.5** — purpose-built for Indian languages (won't misread Hindi as another language the way generic models do)
- Uses the user's selected language code (`hi-IN` / `gu-IN` / `en-IN`) or auto-detect

### 4.3 Policy Services (with verification)
- Looks up policy details, premium, maturity, due dates
- **Security-first**: refuses to reveal policy data on an unverified number; asks for policy number or DOB first
- Refuses bulk data dumps and stays in-character against prompt-injection

### 4.4 Business Tools
The AI agent can call structured tools:
- **Tickets** — create / update, with a guard to avoid duplicate open tickets per client
- **Claims** — log claims (even with partial details), list missing documents, advance claim stages
- **Leads** — register and update prospects with interest/stage/summary
- **Reminders** — create / update / fetch scheduled reminders
- **Notify** — send a targeted message (with optional Accept/Reject buttons) to a specific person (team member or admin)
- **Reports** — trigger family financial report generation
- **Team ops** — team-member task queries and status

### 4.5 Cross-User Notifications
When one user's action concerns another (e.g. a team member requests a task reassignment), the bot calls **Notify** to route a message to the right person (admin/team). Notifications are stored and surfaced in the UI inbox, and delivered over real WhatsApp when live.

---

## 5. Scheduled Reminder System

A user can ask in natural language, e.g. *"remind me to talk to Ved Parekh today at 3, send me a reminder at 2:30."* The bot:
1. Understands the task and the reminder time
2. Creates a reminder (`create_reminder`) with the fire time and the requester's phone

The **Reminder Engine** (separate n8n workflow) then:
- Runs **every 15 minutes**
- Finds due reminders (times are interpreted in **IST**)
- AI-drafts a short, warm reminder message
- Delivers it via WhatsApp **and** writes it to the UI inbox
- **One-time reminders fire once and stop**; recurring ones reschedule

Works for **all roles** — the reminder is tied to whoever requested it.

---

## 6. Notification & Reminder Delivery to the UI

```
Reminder Engine / Notify  ──writes──►  ui_inbox (MongoDB)
                                            │
UI (polls every 5s)  ──►  /api/inbox  ──►  reads undelivered for the current phone,
                                            marks delivered, returns them once
                                            │
                                   rendered into the active chat
```

- ⏰ Reminders appear in the requesting user's chat
- 🔔 Notifications appear in the target user's chat (e.g. Admin, or a specific team member)
- Each message shows exactly once (server-side `delivered` flag)

---

## 7. Deployment & Configuration

**Live app:** `https://whatsapp-2r9v.onrender.com/` (Render)
**Live AI bot:** `https://ai.cgpe.in` (n8n)

**Environment variables (Render):**

| Variable | Purpose |
|----------|---------|
| `PORT` | Server port (3000 in prod) |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary account for media uploads |
| `CLOUDINARY_UPLOAD_PRESET` | Unsigned upload preset |
| `CLOUDINARY_FOLDER` | Folder for uploads (default `cgpe-audio`) |
| `MONGODB_URI` | MongoDB connection for the UI inbox |
| `MONGO_DB` | (optional) DB name if not in the URI |

**Run locally:**
```bash
npm install
npm run dev        # or: node server.js
```

---

## 8. Notes & Limitations

- **Real WhatsApp delivery** of reminders/notifications requires the recipient number to be verified/allow-listed and the bot's `commSendMode` set to `live`; in the simulator these instead surface via the UI inbox.
- The language buttons in the new-lead onboarding are UI-side; the header language picker is the reliable, bot-aware control.
- The simulator is a testing surface — it faithfully exercises the live bot's logic, which is what ultimately runs on production WhatsApp.

---

*Built for **C. G. Patel (CGPE)** — next-generation insurance automation across Gujarat & India.*
