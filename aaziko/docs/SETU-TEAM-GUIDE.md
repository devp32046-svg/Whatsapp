# 🌉 Setu — Team Guide (Sales / Sourcing)

**Setu aapka AI sourcing assistant hai.** Yeh `contact@aaziko.com` ke real emails khud padhta hai, buyer/supplier pehchanta hai, reply draft karta hai, COA (Certificate of Analysis) read karke buyer ke spec se match karta hai, CIF price nikalta hai, aur quotation draft karke deta hai. **Aapka kaam = review karna + approve karna.** Baaki Setu karta hai.

> ⚠️ Abhi **test (SHADOW) mode** — koi real email apne aap kisi customer ko nahi jaata. Jab tak aap "Approve & Send" na dabao, kuch nahi jaata, aur send sirf approved test numbers pe jaata hai.

---

## 1. Kaise kholo
Browser me: **http://localhost:4545/dashboard**
(Purana lage toh **Ctrl+Shift+R** dabao.) Left side me **📨 Live Mailbox** pe click.

---

## 2. Roz subah — kaha focus karo
Live Mailbox me har mail pe Setu ne tag lagaya hota hai:
- **🛒 Buyer** — koi humse khareedna chahta hai → **FOCUS**
- **🏭 Supplier** — Indian manufacturer humein bechna chahta hai → **FOCUS**
- **⚙️ Other** — bounce / logistics / event / spam → **ignore** (Setu isme draft nahi banata)

> Inbox ka ~84% noise hota hai (bounce/networking/events). Setu woh chhaan deta hai — aap sirf **buyer + supplier** (asli kaam) dekho.

---

## 3. Ek SUPPLIER mail handle karna (jaise Vinipul)
1. Us card pe **"Let Setu handle"** dabao (~15 sec) → Setu **supplier-style reply** banata hai (unse price/MOQ/lead-time/spec maangega). Review panel khud khulega.
2. **"💬 View thread"** dabao → poori conversation + **📎 COA specs** table (Assay, Moisture, pH…) apne aap dikhegi. Scanned COA bhi Setu OCR se padhta hai.
3. Neeche **🔍 Spec match** me seedha: **"🔗 Auto-matched to [buyer] ka requirement"** + **CONFORM** (spec theek) ya **DEVIATION** (spec me gadbad, jaise Assay kam). Aapko kuch paste nahi karna.
4. **📦 Supplier quote banner** (unka rate/MOQ) + **💰 CIF calculator** me QTY/buyer sab **auto-filled**. Aap sirf **3 cheezein** daalo:
   - **Markup %** (aapka margin)
   - **Forwarding ₹** (port tak ka kharcha)
   - **Ocean Freight $**
   → **Calculate CIF** → price ₹ aur $ dono.
5. **📧 Draft quotation** → buyer ko CIF quote (numbers Setu khud compute karta, galat nahi hote). → "open to review".
6. Review panel me **body padho → edit (zaroorat ho toh) → Approve** → **✓ Approve & Send** (gated).

---

## 4. Ek BUYER mail handle karna
1. **"Let Setu handle"** → Setu **buyer-style reply** banata hai.
2. Agar buyer ne apna **spec** diya hai, Setu use **requirement** me save kar leta hai — taaki aage jab supplier ka COA aaye, woh **apne aap us requirement se match** ho jaye.
3. Review → Approve → (gated) Send.

> Buyer ka requirement manually save karna ho: thread me **"📋 Save this thread as a buyer requirement"** → product + spec daalo → Save.

---

## 5. Aapko manually kya karna hai (bas yeh)
- **Markup % · Forwarding ₹ · Ocean Freight $** — CIF calc me (yeh per-deal change hote, isliye manual).
- **Har draft review + approve** — Setu draft deta hai, bhejne se pehle aap check karo.
- **Send** — "✓ Approve & Send" dabao (abhi gated).

Baaki sab (mail padhna, draft, COA read, spec-match, pricing-math, quotation) **Setu karta hai.**

---

## 6. Bharosa kyun karein (safety)
- **Saare numbers CODE se** aate hain (CIF, match) — AI number invent nahi karta; do guards lage hain.
- Setu **CONFORM/DEVIATION sahi** batata hai; quotation me jhooth "conforms" nahi likhता agar spec match nahi hua.
- **Supplier vs Buyer** sahi pehchanta — supplier ko landed-cost quote nahi deta.
- **SHADOW mode** — bina approve kuch nahi jaata; send sirf allowlist pe.

---

## 7. Quick tips
- Mail jaldi dikhe nahi? **↻ refresh** ya hard-refresh (Ctrl+Shift+R).
- Panel pe laal **"DB offline"** banner? → IT ko bolo (Tailscale reconnect).
- Thread window chhoti/badi karni ho → left kinare pe **↔ handle drag** karo (double-click = reset).
- "human triage" aaya = Setu ne socha yeh real buyer/supplier nahi (bounce/vendor) → aap khud dekho ya chhodo.

---

## Ek line me
**Buyer/Supplier tag → "Let Setu handle" → "View thread" (COA + auto-match) → CIF (3 manual numbers) → Draft quotation → Review → Approve & Send.**

_Koi dikkat ho toh Ved/dev ko batao._
