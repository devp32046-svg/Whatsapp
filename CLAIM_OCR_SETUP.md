# Insurance Claim OCR - Complete Setup Guide

## 🎯 What You're Building

```
Customer sends claim PDF via WhatsApp
    ↓
n8n captures message + PDF
    ↓
Express server receives → Sarvam OCR
    ↓
Extract text + Analyze with AI
    ↓
Split response:
├─ Customer: Summary + Next Steps ✅
└─ Admin: Red Flags + Inconsistencies 📍
    ↓
Admin approves/rejects on WhatsApp
    ↓
Customer gets: APPROVED/REJECTED + reason
```

---

## 📋 Prerequisites

✅ **Already Have:**
- Express server (running on port 3000)
- MongoDB (cgpe-connect)
- n8n workflows (ai.cgpe.in)
- WhatsApp Gateway (T6JlzF4El2bSb2h3)
- Sarvam API key: `sk_r8qxua9i_EXV1ompjRk5FYfN9DZzJpj9P`

✅ **Ready To Use:**
- `/api/claim/analyze` endpoint (Express)
- `SarvamOCR` service class
- MongoDB `claim_analyses` collection

---

## 🔧 STEP 1: Verify Setup (5 min)

### Check .env has Sarvam key
```bash
cat .env | grep SARVAM_API_KEY
# Should show: SARVAM_API_KEY=sk_r8qxua9i_EXV1ompjRk5FYfN9DZzJpj9P
```

### Verify service file exists
```bash
ls -la src/services/sarvam-ocr.js
# Should exist and be ~2KB
```

### Start server
```bash
npm start
# Should show: "CGPE Chat UI running at http://localhost:3000"
```

---

## 📡 STEP 2: Test API Endpoint (5 min)

### Create test PDF (or use existing claim)
```bash
# Use your real claim PDF: Manipal_Cigna_Claim.pdf
# Convert to base64:
base64 -w 0 Manipal_Cigna_Claim.pdf > pdf.b64
```

### Test endpoint
```bash
curl -X POST http://localhost:3000/api/claim/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "base64PDF": "'"$(cat pdf.b64)"'",
    "fileName": "Manipal_Cigna_Claim.pdf",
    "clientPhone": "919876543210",
    "claimNumber": "CLM-2024-001"
  }' | jq .
```

### Expected Response
```json
{
  "success": true,
  "data": {
    "fileName": "Manipal_Cigna_Claim.pdf",
    "extractedText": "... full OCR text ...",
    "analysis": {
      "claim_summary": {...},
      "coverage_flags": {...},
      "inconsistencies": {...}
    },
    "documentId": "507f1f77bcf86cd799439011"
  }
}
```

---

## 🔄 STEP 3: n8n Workflow Setup (15 min)

### Create new workflow: "Insurance Claim Processor"

#### Trigger 1: WhatsApp Incoming Message
```
Node: Webhook
- Method: POST
- Path: cgpe-claim-webhook
- Authentication: None (or use WhatsApp token)
```

#### Trigger 2: Message has Attachment (PDF)
```
Node: If
- Condition: {{ $json.message.type == 'document' }}
- True path: Process PDF
- False path: Send info message
```

#### Process PDF Steps

**Step 1: Extract File**
```
Node: Function
JavaScript:
  const docUrl = $input.all()[0].json.message.document.link;
  return { documentUrl: docUrl };
```

**Step 2: Download to base64**
```
Node: HTTP Request
- Method: GET
- URL: {{ $json.documentUrl }}
- Return: Binary response
- Save as: pdfBuffer
```

**Step 3: Convert to base64**
```
Node: Function
JavaScript:
  const buffer = $json.body;
  const base64 = Buffer.from(buffer).toString('base64');
  return { base64PDF: base64 };
```

**Step 4: Call Express API**
```
Node: HTTP Request
- Method: POST
- URL: https://ai.cgpe.in/api/claim/analyze
  (or http://localhost:3000/api/claim/analyze for testing)
- Headers: Content-Type: application/json
- Body:
  {
    "base64PDF": {{ $json.base64PDF }},
    "fileName": {{ $json.message.document.filename }},
    "clientPhone": {{ $json.sender_phone }},
    "claimNumber": {{ $json.message.text || 'MANUAL' }}
  }
```

**Step 5: Format Customer Response**
```
Node: Function
JavaScript:
  const analysis = $input.first().json.data.analysis;
  return {
    summary: analysis.claim_summary,
    flags: analysis.coverage_flags,
    nextSteps: [
      "✅ We received your claim",
      "📋 Summary: " + JSON.stringify(analysis.claim_summary),
      "⚠️ Items needing review: " + Object.keys(analysis.coverage_flags).length,
      "👤 Admin will contact you within 24 hours"
    ]
  };
```

**Step 6: Send to Customer (WhatsApp)**
```
Node: WhatsApp Send Message
- To: {{ $json.sender_phone }}
- Message:
  "Hi {{ $json.customer_name }},

Your claim has been received ✅

📋 CLAIM SUMMARY:
Policy: {{ $json.analysis.claim_summary.policy_number }}
Hospital: {{ $json.analysis.claim_summary.hospital_name }}
Claimed: ₹{{ $json.analysis.claim_summary.claim_amount }}
Dates: {{ $json.analysis.claim_summary.treatment_dates }}

⚠️ Items Flagged for Review:
{{ $json.nextSteps.join('\n') }}

Our team is reviewing your claim. You'll hear from us within 24 hours.

Claim ID: {{ $json.documentId }}"
```

**Step 7: Notify Admin (Separate Message)**
```
Node: WhatsApp Send Message
- To: ADMIN_PHONE (hardcoded admin number)
- Message:
  "🚨 NEW CLAIM SUBMITTED

Claim ID: {{ $json.documentId }}
Customer: {{ $json.sender_phone }}
Amount: ₹{{ $json.analysis.claim_summary.claim_amount }}

⚠️ FLAGS:
{{ $json.analysis.inconsistencies.join('\n') }}

Action Needed: Review and approve/reject
Link: https://ai.cgpe.in/admin/claims/{{ $json.documentId }}"
```

**Step 8: Store to MongoDB** (optional in n8n)
```
Node: MongoDB
- Operation: Insert
- Database: cgpe-connect
- Collection: claim_analyses
- Data: {{ $json.data }}
```

---

## 🎯 STEP 4: Admin Approval Flow (10 min)

### Option A: WhatsApp Buttons
```
Admin message with buttons:
- APPROVE ✅
- REJECT ❌
- REQUEST MORE INFO ❓

Webhook captures button response
→ Updates DB status
→ Sends to customer
```

### Option B: Web Dashboard
```
URL: http://localhost:3000/admin/claims
- Shows pending claims
- Displays OCR results + flags
- One-click approve/reject
- Syncs with WhatsApp
```

---

## 🧪 STEP 5: Testing (10 min)

### Test 1: Simple Text PDF
```
Create test PDF with:
- Policy number: POL-2024-001
- Claimed amount: ₹50,000
- Hospital: Apollo Hospital

Upload via WhatsApp or API
Verify: Text extracted correctly
```

### Test 2: Handwritten Form
```
Use your real Manipal Cigna claim
Verify: Handwriting recognized
Check: Dates, amounts readable
```

### Test 3: Flag Detection
```
Claim with known issues:
- Date inconsistency
- Policy number mismatch
- Excluded procedure

Verify: Flags triggered correctly
```

### Test 4: Customer Message
```
Verify customer gets:
✅ Summary text
📍 Flag count
⏱️ Timeline

No OCR errors shown
```

### Test 5: Admin Alert
```
Verify admin gets:
- Claim details
- Red flags
- Approval link
```

---

## 📊 Database Schema

```javascript
// claim_analyses collection
{
  _id: ObjectId,
  documentId: "507f...",
  fileName: "Manipal_Cigna_Claim.pdf",
  clientPhone: "919876543210",
  claimNumber: "CLM-2024-001",
  
  extractedText: "... full OCR text ...",
  tables: [ {...}, {...} ],
  
  analysis: {
    claim_summary: {
      policy_number: "POL-2024-001",
      hospital_name: "Breach Candy",
      claim_amount: 463751,
      treatment_dates: "2024-01-15 to 2024-01-22"
    },
    coverage_flags: {
      pre_existing_condition: "⚠️ Mentioned",
      network_hospital: "✅ Yes",
      required_auth: "⚠️ Missing"
    },
    inconsistencies: [
      "Age mismatch: ID says 45, form says 46",
      "Policy number digit error: check last 2 digits"
    ]
  },
  
  status: "pending_review",  // or "approved", "rejected"
  admin_notes: "Needs policy verification",
  admin_decision: "APPROVED",
  admin_decided_by: "9898012346",
  admin_decided_at: ISODate,
  
  createdAt: ISODate,
  updatedAt: ISODate,
  source: "whatsapp-ocr"
}
```

---

## 🚨 Troubleshooting

### Issue: "File not found"
```
Solution: Base64 encoding wrong
Verify: base64 -w 0 file.pdf doesn't have newlines
```

### Issue: "Invalid API key"
```
Solution: Check .env SARVAM_API_KEY
Verify: sk_r8qxua9i_EXV1ompjRk5FYfN9DZzJpj9P is correct
Test: curl -H "Authorization: Bearer sk_..." https://api.sarvam.ai/status
```

### Issue: "Timeout - PDF too large"
```
Solution: Sarvam max 10 pages per request
Fix: Split PDF using Python (pypdf or pdfplumber)
```

### Issue: "Handwriting not recognized"
```
Solution: Image quality low
Try: Increase PDF resolution in scanner
Or: Use Sarvam's `image_enhancement` flag
```

### Issue: "Checkbox misread"
```
Solution: Hardened prompt catches common errors
If still occurs: Add to prompt validation rules
Example: If "substance abuse" appears as diagnosis, flag it
```

---

## 📈 Phase 2 (Later)

Once WhatsApp flow is solid:

1. **Admin Dashboard**
   - Pending claims list
   - One-click approve/reject
   - Historical analytics

2. **Auto-Validation**
   - Check policy number against DB
   - Validate claimed amounts
   - Cross-reference hospital network

3. **Customer Portal**
   - Track claim status
   - View OCR results
   - Download approved summary

4. **Analytics**
   - Average processing time
   - Common flags
   - Approval rate by type

---

## ✅ Checklist

- [ ] Sarvam API key in .env
- [ ] `src/services/sarvam-ocr.js` exists
- [ ] `/api/claim/analyze` endpoint works
- [ ] n8n workflow created (8 steps)
- [ ] Customer message tested
- [ ] Admin alert tested
- [ ] 2-3 real claims processed successfully
- [ ] Flags triggered correctly
- [ ] MongoDB storing results

---

## 🎬 Go Live

Once all tests pass:
1. Enable n8n workflow (activate)
2. Publicize WhatsApp number for claims
3. Train admin on approval process
4. Monitor first 10 claims closely
5. Refine prompts based on learnings

---

**Everything ready. Start with test endpoint, then build n8n workflow.** 🚀
