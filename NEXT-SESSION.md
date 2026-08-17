# NEXT SESSION — CGPE WhatsApp Bot

**Naya session:** `NEXT-SESSION.md` padho + memory dekho (`memory/MEMORY.md`). Date: state as of **2026-08-17**.

---

## 0. Deploy ka niyam (iske bina live kuch mat chhedo)
n8n REST: backup → GET → edit → PUT `{name,nodes,connections,settings}` → deactivate → activate → **live code wapas padh kar verify**.
- `String.replace` me **function replacer** (`$&` trap), syntax check **`AsyncFunction`** se, anchor **theek ek baar**, `settings` sirf whitelist keys.
- **Heredoc backslash-drop**: deploy scripts **Write tool** se likho (bash heredoc `\d`→`d` kar deta hai); backslash-free regex prefer karo (`[0-9]`), read-back par regex/FFFD assert karo.
- Inline `node -e` regex/paren aksar toot-te hain → script file me likho.

## 1. Current state (sab LIVE)
- **Template reminders LIVE**: `CGPE — Reminder Firer` (`B3xv22aRjIt6waAi`) roz 10 AM `scheduled_reminders` (622 rec, our-agentCode+real-phone) se fire karta hai. `wa_bot_config.templateSend.testMode=false`. Approved templates: `cgpe_premium_reminder_30_days/_21_days`, `cgpe_premium_due_today`, `cgpe_policy_maturity_upcoming` (lang **en**). Send = Meta Cloud API.
- **Claim pipeline LIVE + verified**: WhatsApp pe file bhejo → `Claim Finalizer` (`e1cz3IAKEvQgqnVj`, Vertex A/B + **Line Items** node = §14.1 itemised, ab Vertex hai) auto-process ~2.5min → `claim-review-gen?claim=CLM-xxxx` branded PDF. Itemised tabhi bharta hai jab file me detailed BILL CUM RECEIPT ho.
- **Brain** primary = Vertex (`gemini-2.5-flash`); AI-Studio keys = fallback. Dekho [[gemini-usage-map]].

## 2. Is session me DONE
1. **Filter alignment (SENSITIVE)** — `renewal_list` + `maturity_list` (List Engine `G7xWhdusNjzKXK8W`, Format List renewal + maturity branch) me real-phone guard; agentCode pehle se tha. Aug renewal 241→**154**, maturity 4→**1**. Birthday/anniversary untouched (info-view).
2. **custom_list advance filter** — naya derived **`renewalDue`** field (commencementDate+mode se next-due) → cross-month renewal date-range kaam karta (Sagar ka "15 Aug–15 Sept" = **222 policies** verified). + agentCode alignment (custom_list pehle SAARE agents dikhata tha — leak band). Brain desc updated (renewalDue example + "CGPE ≠ agentCode value" note).
3. **Inbox date/time** — `src/public/inbox.html`: chat me day-separators (Today/Yesterday/DD Mon) + thread-list me last-msg time.
4. **Brain Gujarati fix** — `CGPE AI Brain`+`Slim Brain` systemMessage me corrupt `�` (6+7→0). Watchdog ab shaant.
5. **Lunagariya claim review** — 86-pg bundle → 180-line itemised PDF (`Claim_Review_LUNAGARIYA_HANSA.pdf`), triple-match reconcile. Live pipeline verify.
6. **Sunday scan** — sab engines chale, koi crash nahi; par ~24 staff notif FAIL (band 24h-window). Watchdog ne API-key-429 + wiring alerts pakde jo Ved tak nahi pahunche.

## 3. Important decisions
- **Sab filter = our 4 agentCodes + real-phone** (Ved: "sensitive"). listAgentCodes = `["OTHER","09210186H","9383486H","90209863"]`.
- **Gemini premium (AI-Studio keys) ~18 Aug raat expire** → HOLD, Ved keys/credits laayenge. Core Vertex pe safe. Premium-dependent (Memory Distiller/Report Gen/Reminder Engine/big-file claims) 20-day free cap pe girenge — watch.
- **Window keepalive fix** = approved **template** `cgpe_daily_update_ready` (Utility, lang en, pure-Gujarati body + 1 quick-reply button "📋 અપડેટ જુઓ"). Tap window re-open karta hai (**compulsory** — bot msg window nahi kholta). Counts-variable version REJECT (marketing risk) — simple rakha.

## 4. Pending (priority order)
1. **Window keepalive** — Ved template Meta pe approve karwaayenge → main `CGPE — Window Keepalive` (`Ajrvac19wWU2Bo2Y`) `Decide→Notify` ko session-msg ki jagah is template pe wire karun (near-end fire, config-flag gated). Critical alerts (API-down/wiring) bhi template se.
2. **Photo/doc → sahi person** (Ved ki asli ask) — abhi doc SENDER ke phone pe file hota (proof: Ved ne Hitesh+Nilamben bheje, dono Ved ke phone CLM-1199/1200 pe). Fix: OCR naam (`patientName/policyHolderName`) se sahi `clients` match ([[name-search-fuzzy]]) karke attach.
3. **Gemini AI-Studio** keys/credits + big-file claims Vertex-lean.
4. Firer report recipients → Jagdish (PDF 9898684700) / Ramesh (count 9099032033) / Ved.
5. (Optional) naye custom_list filters: **PPT-end date** (premium-paying khatam), cross-month birthday/anniversary range.

## 5. Changed files (this session)
- `src/public/inbox.html` (date/time)
- Live wf: List Engine `G7xWhdusNjzKXK8W`, Gateway `T6JlzF4El2bSb2h3` (Gujarati + custom_list desc + reminder prompt), Custom List `MT3WlXDiOJ264eLW` (renewalDue+agentCode)
- `backups/`: listengine_before_renewal_phone.json, listengine_before_maturity_phone.json, gateway_before_gujarati_fix.json, gateway_before_customlist_renewaldue_desc.json, customlist_before_renewaldue.json
- Repo: `Claim_Review_LUNAGARIYA_HANSA.html/.pdf`
- memory: `gemini-usage-map.md`, `weekend-scan-pending-fixes.md` (naye), `meta-template-send.md` (updated)

## 6. Bugs (fixed / open)
- FIXED: renewal_list/maturity_list no-phone clients gine ja rahe the.
- FIXED: brain "CGPE = agentCode" spurious condition (0 result) → desc note.
- FIXED: brain prompt corrupt Gujarati (6+7).
- OPEN: **staff notif band-window pe fail** (weekend) — fix #1 (template).
- OPEN: doc SENDER-phone pe file (not real client) — fix #2.

## 7. Ved ke pakke niyam
- Email mat bhejo; test ho to sirf `devp32046@gmail.com`. Alert sirf Ved `9601775061` (`emailRouting.onlyTo` + Error Alerter pinned).
- 3 TEST workflows inactive rehne do (delete mat). Testing numbers: **Ved 9601775061 / Sagar 9825135034 / Shiv 9106988376** — har test **naya/alag** rakho.
- `cgpe-claim-decision` webhook par **kabhi test POST mat** (Notify Customer chalta). 7 atki claim sessions permission ke bina mat chalao (clients ko msg jayega).
- Jawab Hinglish, saaf, chhota — plain copy-paste lines, artifact page nahi.

## 8. EXACT NEXT STEP
Ved ke "template approve ho gaya" bolते hi → **`CGPE — Window Keepalive` (`Ajrvac19wWU2Bo2Y`)** `Decide` node ko wire karo: near-end (age 20-23h) staff ko session-msg ki jagah **`cgpe_daily_update_ready` template** `cgpe-send-template` se fire karo (config-flag `useTemplate` gated, backup+syntax+read-back). Warna Ved priority de to fix #2 (photo→sahi client) ya PPT-end custom filter build karo.
