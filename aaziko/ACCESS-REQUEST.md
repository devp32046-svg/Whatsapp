# Access Request — Aaziko ATES Jarvis (Phase 0 Discovery)

**To:** [Senior / System Owner]
**From:** Ved
**Re:** Read-only access to the real DBs, tools & APIs (per the system inventory)

---

Sir, ATES Jarvis ka **feasibility demo ho chuka hai** (poora Sales process n8n me chal raha hai, abhi mock data pe). Ab isse **real Aaziko systems** se jodna hai. System inventory ke hisaab se neeche wali cheezein chahiye.

**Sab kuch READ-ONLY chahiye — Phase 0 me koi production write nahi hoga.** Host: `100.70.212.45:27017`.

---

## A. Network access (sabse pehle)
- Host `100.70.212.45` private/Tailscale IP hai — usko reach karne ke liye **Tailscale/VPN access** chahiye (mere machine ko network me add karo).

## B. MongoDB — READ-ONLY user
Ek read-only Mongo user (find/aggregate allowed; insert/update/delete **nahi**). In DBs pe:

**1. `common-service`** (main DB — 306 collections). Key collections:
- Buyers/companies/CRM: `companies`, `buyers`, `vendors`, `contacts`, `accounts`, `leads`, `deals`
- Trade-intelligence: `standard_port_data`, `shortlist_buyer_seller`, `enhanced_buyer_seller`, `buyer_summaries`, `supplier_summaries`, `hs_code_summaries`, `market_medians_by_hs`, `market_trends`
- Products: `products`, `categories`, `hscodes`, `productscores`
- Orders/quotes: `orders`, `quotes`, `quotation_*`, `proforma_invoices`, `invoices`, `negotiations`, `samples`, `disputes`
- Comms: `messages`, `inboundemails`, `messageevents`, `messagetemplates`, `campaigns`, `sequences`, `sendingdomains`, `sendingidentities`, `suppressions`, `unsubscribes`
- Compliance/customs: `compliancerequirements`, `compliancechecks`, `certificates`, `governmentincentives`
- Logistics: `freightorders`, `shippinglines`, `shipmenttrackings`, `containers`, `ports`, `packing_lists`

**2. `Dhruval2`** — macmap tariff, DGFT/RBI/BIS, eximpedia scrapes
**3. `Dhruval`** — `shortlist_buyer_seller` sampling frame (~9.9M)
**4. `trade_intelligence`** — buyer-scoring engine data (:3077)
**5. `outbound_email`** — prospecting/CRM mailer
**6. `product-service`**, **7. `vendor-service`**, **8. `admincrm-service`**, **9. `order-service`**, **10. `lsq-service`**, **11. `buyer-service`**, **12. `custom30`** (Live Custom 3.0)

## C. Tools / engines — access + kaise call karein
- **PortBrain** — buyer/supplier search (222M shipments)
- **Trade Intelligence Engine** (:3077) — buyer-scoring dashboard
- **Live Custom 3.0** + **CRM Compliance Custom 3.0** + **Compliance AI**
- **Landed-Cost / Logistic-Cost** calculators
- **Outbound Email engine**, **AdminCRM**, **LSQ**

## D. APIs — base URL + auth (read endpoints)
- `product-service`, `vendor-service`, `lsq-service`, `order-service`, `admincrm-service`
- `outbound_email` — sending + reply-ingestion (`inboundemails`/`messageevents`) kaise hota hai

## E. Email / sending (aage ke phase ke liye)
- Sending config: `sendingidentities` (7 aaziko addresses), `sendingdomains` (Mailgun/Zoho/Workspace)
- Ek **test mailbox** — controlled test-send ke liye (real buyers ko kabhi nahi, sirf approved test recipient)

## F. Build environment
- Ek **dedicated / staging n8n** (production wala nahi) — editor + API-key access
- Relevant **service repos / branch**, existing **schedulers/cron** ki list (taaki n8n duplicate na kare), aur **roles/permissions** (kaun kya approve karta hai)

---

## Safety commitments
- Phase 0 me **sirf read** — production data me koi change nahi.
- Raw production data ko kahin **copy/duplicate nahi** karunga; sirf metadata + controlled query templates.
- Jarvis ke apne naye records **alag DB** (`aaziko_jarvis` / `aaziko_intelligence`) me jaayenge, source data me **nahi**.
- Koi **secret/credential kisi external service** ko nahi bheja jaayega.
- Har external action (email send etc.) sirf **human approval** ke baad, aur pehle **test recipient** pe.

## Access milte hi pehla kaam
Ek **read-only inventory + gap-analysis report** dunga: kaunsi collections/fields Jarvis ke kaunse step ko feed karti hain, kya missing hai, aur wiring plan — bina kuch chhue.
