# 🏛️ CGPE AI WhatsApp Business Gateway & Multi-Role Workspace Simulator

Welcome to the **C.G. Patel (CGPE) AI WhatsApp Gateway & Multi-Role Sandbox** — an enterprise-grade, full-stack simulation and testing platform designed for **C.G. Patel Financial & Insurance Services (CGPE)**.

This project bridges a high-fidelity **WhatsApp Business Web UI Simulator** (`http://localhost:3000`) with our **Live AI Production Backend (`https://ai.cgpe.in/webhook/cgpe-chat`)** via an Express.js media proxy server (`server.js`). It allows seamless testing of complex multi-user insurance workflows, interactive team task assignments, voice note submissions, attachment processing, and multi-lingual AI onboarding without needing physical WhatsApp handsets.

---

## 🌟 Core Architectural Architecture & System Overview

The system operates across two interconnected layers:

```
┌────────────────────────────────────────────────────────────────────────┐
│                      FRONTEND WORKSPACE SIMULATOR                      │
│                           (src/public/index.html)                      │
│                                                                        │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐  │
│  │ 👤 Client Role   │  │  🔧 Admin Role   │  │ 🧑‍💼 Team Member Role │  │
│  │ (Multi-Client &  │  │ (Task Assignment │  │ (Task Inbox & Yes/No │  │
│  │  New Lead Flow)  │  │  & Live Inbox)   │  │  Acknowledgment loop)│  │
│  └────────┬─────────┘  └────────┬─────────┘  └──────────┬───────────┘  │
│           └─────────────────────┼───────────────────────┘              │
│                                 │ Async Targeted Router                │
│                                 ▼ (targetPhone / targetRole isolation) │
└─────────────────────────────────┼──────────────────────────────────────┘
                                  │ POST /api/upload & Proxy Requests
┌─────────────────────────────────▼──────────────────────────────────────┐
│                    EXPRESS BACKEND PROXY (server.js)                   │
│                                                                        │
│  • Media Upload Proxy (`/api/upload`) ➔ tmpfiles.org / 0x0.st fallback │
│  • CORS & Payload Validation                                           │
└─────────────────────────────────┬──────────────────────────────────────┘
                                  │ HTTPS Webhook Payload
┌─────────────────────────────────▼──────────────────────────────────────┐
│                 LIVE CGPE n8n AI ENGINE & DATABASE                     │
│               (https://ai.cgpe.in/webhook/cgpe-chat)                   │
│                                                                        │
│  • 9-Digit Real LIC Policy Number Validation (`policyNo: 8648059xx`)   │
│  • Multi-Lingual NLP (`English 🇬🇧`, `Gujarati 🇮🇳`, `Hindi 🇮🇳`)         │
│  • CRM Lead Registration & Policy Verification                         │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Key Features & Enterprise Capabilities

### 1. 👥 Multi-Role Workspace with Instant Role Switching
The top navigation bar allows immediate, state-isolated switching between three dedicated operational roles:
*   **👤 Client (`SENDER_PHONE: 9198xxxx`)**: Simulates policyholders or new inquiries chatting with the CGPE AI Bot.
*   **🔧 Admin (`CGPE HQ: 919876500000`)**: Simulates the central operations desk monitoring client interactions, managing claims, and dispatching tasks to staff.
*   **🧑‍💼 Team Member (`Ops Lead / Claim Officer / Sales Specialist`)**: Simulates internal staff members receiving automated task assignments and executing workflows.

### 2. 🔢 Real Database Policy Numbers (`#8648059xx`) & Multi-Client Dropdown
Instead of testing with generic placeholders or a single dummy phone number, the Client workspace includes a **Dynamic Client Dropdown (`#clientDropdown`)** pre-populated with **authentic Gujarati client names matched to their exact 9-digit LIC Database Policy Numbers**:
1. **`Agrawal Rajesh (#9012)`** — Phone: `919876500009`
2. **`AARDESHANA ANILBHAI (#864805904)`** — Phone: `919825100001` *(Exact JSON DB Match)*
3. **`AGHERA KANTIBHAI (#864805911)`** — Phone: `919825100002`
4. **`AGRAVAT PARIXIT (#864805922)`** — Phone: `919825100003`
5. **`AMDAWADI KARSHANBHAI (#864805933)`** — Phone: `919825100004`

Every client has an **isolated conversation thread (`conversations["client_" + phone]`)**. Switching clients seamlessly loads their independent chat history without state contamination.

### 3. ➕ New Lead / Prospect Custom Modal (`#customClientModal`)
When testing how the CGPE bot handles a brand new inquiry jiska number database mein nahi hai:
*   Selecting **`+ Add Custom User...`** opens an enterprise modal allowing you to input any new prospect's Name (`e.g., Ramesh Patel (New Lead)`) and Phone (`e.g., 919812345678`).
*   New leads are NOT shown pre-existing policy options (`My Policies`, `Register Claim`). Instead, they receive a **Language-First Onboarding flow**.

### 4. 🌐 English-First & Language Selection Onboarding
To provide a clean, professional first impression for new leads without jarring mixed-language text:
1. **English Welcome Greeting**: The bot first greets new prospects in English:
   > *"Welcome to **CGPE**, [Client Name]! 🙏 We are here to assist you with premier Insurance, Wealth & Investment solutions. To begin, please select your preferred language..."*
2. **Interactive Language Buttons**:
   *   `[ 🇬🇧 English ]` ➔ Keeps UI and follow-up buttons (`📋 New Policy Inquiry`, `📞 Request Advisor Call`, `💡 Explore Services`) in English.
   *   `[ 🇮🇳 ગુજરાતી (Gujarati) ]` ➔ Immediately confirms (`ભાષા પસંદ કરી: ગુજરાતી 🇮🇳`) and switches all subsequent greetings and buttons (`📋 નવી પોલિસી પૂછપરછ`, `📞 એડવાઇઝર કૉલ`, `💡 અમારી સેવાઓ`) to pure Gujarati.
   *   `[ 🇮🇳 हिन्दी (Hindi) ]` ➔ Switches all interactions to Hindi.

### 5. 📌 Admin ➔ Team Task Assignment & Interactive Acknowledgment Loop
Admin can dispatch structured operational tasks directly to internal staff members without leaving the interface:
1. **Assign Task Modal (`openAssignTaskModal`)**: Click **`📌 Assign Task to Team`** inside the Admin tab. Select a team member (`🧑‍💼 Priya Desai (Ops Lead)`, `🧑‍💼 Amit Shah (Claims Officer)`, `🧑‍💼 Kunal Mehta (Sales Specialist)`), enter task instructions, and assign a priority level (`High 🔴`, `Medium 🟡`, `Normal 🟢`).
2. **Team Member Task Inbox Notification**: The selected team member instantly receives a formatted Task Assignment Card inside their `🧑‍💼 Team Member` chat thread with two action buttons:
   *   `[ ✅ Yes / Accept Task ]`
   *   `[ ❌ No / Decline ]`
3. **Instant Admin Acknowledgment Card**: When the team member taps `Yes` or `No`, two things happen simultaneously:
   *   The member receives instant visual confirmation that their decision was logged.
   *   An **Acknowledgment Notification Card** (`🎉 TASK ACCEPTED & ACKNOWLEDGED [TASK-xxxx]` or `⚠️ TASK DECLINED`) is automatically generated inside the **Admin Inbox (`conversations.admin`)** so the Operations Desk has real-time visibility into who is executing what task.

### 6. 🛡️ Targeted Async Message Router (`appendTargetedBotResponse`)
In a multi-user workspace, race conditions can occur if a user sends a message as `Client A` (`AARDESHANA ANILBHAI`) and quickly switches the dropdown to `Client B` (`AGRAVAT PARIXIT`) while the AI backend response is still loading.
To prevent responses from leaking into the wrong user's chat box, the frontend uses a **Targeted Async Router**:
*   Whenever an API call (`sendToCgpe`, button click, or media upload) is initiated, the exact `targetPhone` and `targetRole` are captured.
*   When the async promise resolves, the router pushes the AI reply strictly into `conversations["client_" + targetPhone]`.
*   It checks `isCurrentlyActive`: If the user is currently viewing `targetPhone`, the message renders on screen right away. If the user switched away, the message stays safely stored in the original user's history without touching the currently visible chat screen!

### 7. 🎤 Voice-In / Text-Out Audio Recording & Attachment Uploads
*   **Voice Recording (`sendAudioMessage`)**: Click the mic icon inside any chat box to record live `.wav` voice notes via the browser's Web Audio API. Once stopped, the audio is uploaded through `/api/upload` and sent to the CGPE webhook (`type: "audio"`).
*   **File Attachments (`handleFileUpload`)**: Click the `📎` icon to attach PDFs, images, or documents (`lic_policy_document.pdf`). The file is proxied through our upload server and passed to the AI engine for OCR/parsing.

---

## 🛠️ Technical Setup & Installation

### Prerequisites
*   **Node.js** (v18.0.0 or higher recommended)
*   **npm** (bundled with Node.js)

### Step-by-Step Installation

1. **Navigate to the Workspace Directory**:
   ```powershell
   cd c:\Users\Inet\Desktop\test-chat-bot\Whatsapp
   ```

2. **Install Node Dependencies**:
   ```powershell
   npm install
   ```
   *(Installs `express`, `cors`, `axios`, `form-data`, and other required server dependencies).*

3. **Start the Local Development & Proxy Server**:
   ```powershell
   npm run dev
   ```
   *(Or run directly with `node server.js`).*

4. **Access the Simulator**:
   Open your browser (Chrome/Edge/Firefox) and navigate to:
   ```text
   http://localhost:3000/
   ```

---

## 📂 Project Directory Structure

```text
Whatsapp/
│
├── server.js                  # Express Proxy Server (Port 3000) & Media Upload Handler
├── package.json               # Node.js dependencies & run scripts (`npm run dev`)
├── cgpe_seed_team_members.json # Database seeds & team member definitions
├── cgpe_report_generator.json # n8n / AI configuration definitions
│
└── src/
    └── public/
        └── index.html         # Complete Single-Page UI Simulator (HTML + Vanilla CSS + JS Engine)
```

---

## 🔌 API & Webhook Specifications

### 1. Frontend ➔ Backend Proxy (`POST /api/upload`)
Receives base64-encoded media from `index.html`, uploads to temporary public file storage, and returns a direct download URL accessible by our AI webhook.
*   **Request Body (JSON)**:
    ```json
    {
      "base64Data": "data:audio/wav;base64,UklGR...",
      "mimeType": "audio/wav",
      "filename": "voice.wav"
    }
    ```
*   **Upload Strategy**:
    1.  **Primary**: Uploads via `FormData` to `https://tmpfiles.org/api/v1/upload` (converts view URL to direct download link `/dl/`).
    2.  **Fallback**: If `tmpfiles.org` times out or fails, automatically falls back to `https://0x0.st`.

### 2. Frontend ➔ CGPE AI Webhook (`sendToCgpe`)
All text messages, button taps (`btnId`), voice notes, and file URLs are sent directly to the production AI engine via `axios/fetch`:
*   **Webhook URL**: `https://ai.cgpe.in/webhook/cgpe-chat`
*   **Payload Format**:
    ```json
    {
      "from": "919825100001",
      "name": "AARDESHANA ANILBHAI (#864805904)",
      "text": "mara policies ki details moklo",
      "type": "text",       // Or "audio" / "document" / "image"
      "mediaUrl": null      // Populated with public URL when sending files/audio
    }
    ```

---

## 🔮 Future Roadmap & Production Hardening

As C.G. Patel (CGPE) expands this platform to handle all **9,000 active policyholders**, the following production engineering upgrades are planned:

1. **Voice-First Proactive AI Reminders (Voice-Out)**:
   *   Automated AI voice note dispatches (`.ogg/.opus`) to policyholders 7 days before policy maturity (`maturityDate`) or premium FUP due date (`fupDate`).
2. **Real-Time Emotion & Sentiment Escalation (Human-in-the-Loop)**:
   *   Real-time NLP sentiment analysis on voice-to-text transcripts. If a client exhibits high anxiety, frustration, or urgent claim distress (`status: urgent`), the bot will automatically suspend automation and bridge the chat live to `🧑‍💼 Amit Shah (Claims Officer)`.
3. **Persistent Cloud Object Storage (S3 / R2)**:
   *   Replacing the temporary `tmpfiles.org` / `0x0.st` upload proxies with dedicated AWS S3 or Cloudflare R2 buckets for immutable, highly secure KYC document and voice note archiving.

---

*Built with precision for **C.G. Patel (CGPE)** — Empowering next-generation insurance automation across Gujarat & India.*
