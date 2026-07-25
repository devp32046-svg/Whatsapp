# 🔑 API Keys Configuration Summary

## ✅ Current Setup (Verified)

### 1. **Main WhatsApp Chatbot** 
**Workflow:** `CGPE — WhatsApp Gateway + AI Brain-2`
- **AI Model:** Google Gemini 1.5 Flash
- **Credential:** "Gemini Brain (free)" (ID: `uApBUgqCWN4CGndr`)
- **API Key:** `GEMINI_API_KEY` from .env
- **Usage:** Customer queries, general assistance, policy info, reports

### 2. **Claim OCR Workflow**
**Workflow:** `CGPE Claim OCR (Gemini)`  
- **AI Model:** Google Gemini Flash Latest
- **Credential:** "Gemini Claims (key 2)" (ID: `yIxMALReUWFoS8mZ`)
- **API Key:** `GEMINI_API_KEY_CLAIMS` from .env
- **Usage:** Claim document analysis, OCR, risk assessment

---

## 🎯 Why Separate API Keys?

**Smart Quota Management:**
- ✅ Chatbot and OCR have **separate quota limits**
- ✅ Busy chatbot **cannot exhaust** claim analysis quota
- ✅ Heavy claim processing **cannot block** customer queries
- ✅ Better **isolation and reliability**

---

## 📊 API Keys in `.env`

```bash
# Main chatbot - General queries, reports, assistance
GEMINI_API_KEY=<your-main-gemini-api-key>

# Claim OCR - Document analysis only
GEMINI_API_KEY_CLAIMS=<your-claims-gemini-api-key>
```

---

## 💰 Cost Optimization

### From OpenAI to Gemini:
- **Before:** Using GPT-5.4 (o1) - Very expensive
- **After:** Using Gemini 1.5 Flash - **~20x cheaper**

### Token Saving:
- ✅ Reduced system prompt from **~2000 tokens** → **~600 tokens**
- ✅ Compressed journey prompts by **70%**
- ✅ Short, precise responses (max 2-3 lines)
- ✅ Free tier friendly

---

## 🔧 n8n Credentials Setup

### Credential 1: Gemini Brain (free)
- **Type:** Google PaLM API
- **ID:** `uApBUgqCWN4CGndr`
- **Used in:** Main chatbot workflow
- **API Key:** From `GEMINI_API_KEY`

### Credential 2: Gemini Claims (key 2)
- **Type:** HTTP Header Auth
- **ID:** `yIxMALReUWFoS8mZ`
- **Used in:** Claim OCR workflow
- **Header:** `x-goog-api-key`
- **API Key:** From `GEMINI_API_KEY_CLAIMS`

---

## 📝 Workflow Updates

### Updated Files:
1. ✅ `cgpe_whatsapp_gateway_ai_brain_fixed.json` - Switched to Gemini
2. ✅ System prompts optimized for token efficiency
3. ✅ Added automation scripts for easy updates

### Scripts Created:
- `update-gateway-workflow.js` - Update workflow from local file
- `setup-gemini-credential.js` - List and verify credentials  
- `activate-workflow.js` - Activate workflow after updates

---

## 🧪 Testing

### Test the Main Bot:
```
Send WhatsApp message: "DUDHAGARA PRAVINBHAI SAVJIBHA no report aapo"
```

### Test Claim OCR:
```
POST base64 PDF to: /cgpe-claim-webhook
```

---

## ⚠️ Important Notes

1. **Never mix the API keys** - Keep chatbot and OCR separate
2. **Monitor quota usage** - Check Google AI Studio dashboard
3. **Free tier limits:**
   - Gemini Flash: 15 requests/minute, 1M tokens/day
   - Separate quotas for each API key
4. **Cost effective:**
   - Gemini Flash is FREE up to quota limits
   - Much cheaper than GPT when exceeding free tier

---

## 🚀 Future Improvements

- [ ] Add rate limiting if hitting quota
- [ ] Implement fallback to second key if one exhausts
- [ ] Add usage monitoring dashboard
- [ ] Consider upgrading to paid tier if needed

---

**Last Updated:** July 25, 2026  
**Status:** ✅ Active and Working
