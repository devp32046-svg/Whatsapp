# Sample Buyer Emails — for testing the Auto-Sourcing loop

Panel → **⚙️ Auto-sourcing loop** → **Run the full loop** → paste the **Body** into the big box
(From / Subject optional; paste the **Response** into the last field to test positive/negative).

---

## 1. Cotton T-shirts  — ✅ covered (full loop, positive → CRM)
**From:** buyer@lumiere.example
**Subject:** Cotton t-shirts sourcing
**Body:**
Hello, we are looking to source cotton t-shirts, 180 GSM combed cotton, GOTS certified. Quantity around 10,000 pcs, delivered to Hamburg. Could you help us find Indian suppliers and share pricing?
**Response (optional):** The landed price works for us. Please go ahead and send the proforma invoice.

---

## 2. Leather safety gloves — ✅ covered (full loop, positive → CRM)
**From:** buyer@safeworks.example
**Subject:** Leather safety gloves sourcing
**Body:**
Dear Sir/Madam, We are a safety equipment distributor in the UK. We are looking to source leather safety gloves (cowhide split leather, industrial grade), around 20,000 pairs. Please share your best price, MOQ, and delivery lead time, CIF Felixstowe. Thank you.
**Response (optional):** The pricing works well for us. Please proceed and send the proforma invoice.

---

## 3. Basmati rice — ✅ covered (full loop, NEGATIVE → newsletter)
**From:** imports@gulffoods.example
**Subject:** Basmati rice requirement
**Body:**
We are a food importer in Dubai. Looking to source 1121 Sella Basmati Rice, 25 MT, CIF Jebel Ali. Please share Indian suppliers and your best price.
**Response (optional):** Thanks but the price is higher than our current supplier, we will pass for now.

---

## 4. Wooden furniture — ✅ covered (full loop)
**From:** procurement@nordichome.example
**Subject:** Wooden furniture sourcing
**Body:**
Hi, we are a home furnishing retailer in Sweden. We would like to source solid wood dining chairs and tables, around 2 containers. Please share Indian manufacturers, pricing, MOQ and lead time, CIF Gothenburg.
**Response (optional):** Looks good, please send the proforma invoice to proceed.

---

## 5. Turmeric powder — ❌ NOT covered (honest "no suppliers" stop)
**From:** procurement@spicehaus.example
**Subject:** Turmeric powder requirement
**Body:**
Hello, We are a spice importer based in Germany. We would like to source turmeric powder (curcumin 3-5%), food grade, around 20 MT per shipment, delivered CIF Hamburg. Please share your best price, MOQ, and delivery lead time.
> Expect: requirement + HS understood, but "No Indian suppliers in our data for this product" — no RFQ/quotation (honest stop; shows the data-coverage gap).

---

## 6. Not a product requirement — (should say "not a requirement")
**From:** ops@dblogistics.example
**Subject:** Shipping documents
**Body:**
Dear Sir, Please find attached the bill of lading and arrival notice for the Mundra shipment. Kindly arrange the duty payment and share the challan copy.
> Expect: Jarvis recognises this is NOT a sourcing requirement (it's logistics/ops) → stops, does not draft anything.

---

### Notes
- Covered sectors in our supplier data: apparel/textiles, leather, rice, furniture, many chemicals/engineering.
- Not covered: spices and some agri-commodities (data gap — the loop stops honestly).
- Everything runs in SHADOW — drafts only, nothing is sent; CRM/newsletter writes are staged.
