# Complete Workflow Test Plan

## Categories

### 1. SERVER & INFRASTRUCTURE (5 tests)
- [ ] Test 1.1: Server starts without errors
- [ ] Test 1.2: Port 8081 is accessible
- [ ] Test 1.3: MongoDB connection works
- [ ] Test 1.4: Cloudinary is configured
- [ ] Test 1.5: .env loaded correctly

### 2. API ENDPOINTS (6 tests)
- [ ] Test 2.1: GET /api/admins (returns admin list)
- [ ] Test 2.2: POST /api/upload (base64 upload works)
- [ ] Test 2.3: GET /api/test-audio (serves test file)
- [ ] Test 2.4: Static files served (src/public)
- [ ] Test 2.5: Error handling works (404s)
- [ ] Test 2.6: CORS if needed

### 3. MONGODB (4 tests)
- [ ] Test 3.1: Connect to MongoDB
- [ ] Test 3.2: Collections accessible
- [ ] Test 3.3: Insert test document
- [ ] Test 3.4: Read test document

### 4. CLOUDINARY (3 tests)
- [ ] Test 4.1: Upload credentials working
- [ ] Test 4.2: Base64 upload succeeds
- [ ] Test 4.3: File URL returned correctly

### 5. n8n INTEGRATION (3 tests)
- [ ] Test 5.1: n8n API key valid
- [ ] Test 5.2: n8n webhook accessible
- [ ] Test 5.3: CGPE Chat workflow (T6JlzF4El2bSb2h3) responds

### 6. REPORT GENERATOR (2 tests)
- [ ] Test 6.1: Report workflow (5POkiNLDhKOuVadg) accessible
- [ ] Test 6.2: Can trigger report generation

### 7. VOICE FEATURES (2 tests)
- [ ] Test 7.1: Voice upload endpoint working
- [ ] Test 7.2: Sarvam STT configured

### 8. BUSINESS LOGIC (3 tests)
- [ ] Test 8.1: Admin roster loads
- [ ] Test 8.2: Team members list accessible
- [ ] Test 8.3: Client data retrievable

---

## Test Format

Each test will show:
```
✅ PASS - Working fine
❌ FAIL - Broken, needs fix
⚠️ WARN - Working but issue detected
🔄 SKIP - Not relevant/not testable now
```

---

## Total: 28 Tests

Priority:
1. 🔴 CRITICAL (Server + DB): Tests 1.1-1.5, 3.1-3.4
2. 🟠 HIGH (API): Tests 2.1-2.6
3. 🟡 MEDIUM (n8n): Tests 5.1-5.3
4. 🟢 LOW (Optional): Tests 7.1-8.3
