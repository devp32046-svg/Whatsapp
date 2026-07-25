/**
 * Claim OCR Processor using Google Gemini API
 * Handles: Handwritten forms, scanned documents, tables, bills
 * Uses Gemini's native document/vision capabilities for PDF analysis
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");
// oversized claim PDFs are split and passed as several file_data parts in one call
const { buildGeminiParts } = require("./pdf-split");

class ClaimOCRProcessor {
  constructor(apiKey) {
    this.apiKey = apiKey || process.env.GEMINI_API_KEY;
    this.client = new GoogleGenerativeAI(this.apiKey);
    // gemini-flash-latest handles PDFs + vision natively and is the model
    // available on this project's free tier. Override with GEMINI_MODEL in .env.
    this.modelName = process.env.GEMINI_MODEL || "gemini-flash-latest";
  }

  /**
   * Extract text + tables from a PDF using Gemini (native document input)
   */
  async extractFromPDF(filePath, documentType = "insurance_claim") {
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      const fileSize = fs.statSync(filePath).size;
      console.log(
        `[Gemini OCR] Processing: ${path.basename(filePath)} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`
      );

      const base64PDF = fs.readFileSync(filePath).toString("base64");

      console.log("[Gemini OCR] Calling Gemini API for extraction...");

      const model = this.client.getGenerativeModel({
        model: this.modelName,
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: 8192,
        },
      });

      const prompt = `You are an expert insurance claim document analyzer. Analyze this ${documentType} document and extract:

1. ALL TEXT from the document (preserve structure)
2. ALL TABLES found (with headers and data)
3. KEY INFORMATION: Claim/Policy Numbers, Policyholder Name, Hospital/Provider Name, Treatment Dates, Claimed Amount, Diagnosis/Condition, any checkboxes or selections.

Return ONLY valid JSON with this exact structure:
{
  "extracted_text": "Full OCR text here",
  "tables": [{ "title": "...", "headers": [...], "rows": [...] }],
  "key_info": {
    "policy_number": "...",
    "policyholder_name": "...",
    "hospital_name": "...",
    "claimed_amount": "...",
    "diagnosis": "..."
  }
}`;

      const result = await model.generateContent([
        {
          inlineData: {
            data: base64PDF,
            mimeType: "application/pdf",
          },
        },
        { text: prompt },
      ]);

      const responseText = result.response.text();

      // responseMimeType is application/json, but guard anyway
      let parsedData;
      try {
        parsedData = JSON.parse(responseText);
      } catch (e) {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        parsedData = jsonMatch
          ? JSON.parse(jsonMatch[0])
          : { extracted_text: responseText, tables: [], key_info: {} };
      }

      console.log("[Gemini OCR] Extraction completed successfully");

      return {
        success: true,
        text: parsedData.extracted_text || "",
        tables: parsedData.tables || [],
        key_info: parsedData.key_info || {},
        metadata: {
          model: this.modelName,
          provider: "gemini",
        },
        raw_response: parsedData,
      };
    } catch (error) {
      console.error("[Gemini OCR] Error:", error.message);
      return {
        success: false,
        error: error.message,
        text: "",
      };
    }
  }

  /**
   * Pull the bill out as individual line items, for the pre-submission review.
   *
   * analyzeClaimText() only returns summary-level fields; the deduction waterfall needs every
   * charge separately so each one can be classified payable / non-payable / room-linked.
   * Accepts a file path or a Buffer, and any mimeType - claim bills arrive as photos at least
   * as often as PDFs.
   */
  async extractStructuredClaim(fileOrBuffer, mimeType = "application/pdf") {
    try {
      const buf = Buffer.isBuffer(fileOrBuffer)
        ? fileOrBuffer
        : fs.readFileSync(fileOrBuffer);

      const model = this.client.getGenerativeModel({
        model: this.modelName,
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: 8192,
          temperature: 0,          // extraction, not writing - never let it paraphrase amounts
        },
      });

      const prompt = `You are a TPA claims scrutiny officer reading a health insurance claim file.

Extract EVERY billed charge as its OWN line. This is the most important rule:
- NEVER merge several charges into one line, even if the bill groups them.
- NEVER invent a line that is not printed on the document.
- Copy the description as printed. Amounts are numbers only (no commas, no currency symbol).
- A claim file usually holds SEVERAL bills - the main IPD bill plus OPD cash bills, service
  vouchers, pharmacy bills and imaging bills, often mixed in among medical reports. Find and
  itemise EVERY bill you can see, not just the first one.
- If a page is a report and not a bill, ignore it for "bills" but still use it for the
  patient/date/diagnosis fields.
- If the itemised break-up is NOT present (only a lump-sum total), set
  has_full_itemized_breakup to false and put whatever totals you can see as lines.

Return ONLY this JSON:
{
  "doc_type": "discharge_summary|itemized_bill|payment_receipt|pharmacy_bill|investigation_report|prescription|implant_invoice|claim_form|kyc|other|mixed",
  "patient_name": null,
  "patient_age": null,
  "admission_date": null,
  "discharge_date": null,
  "diagnosis": null,
  "hospital_name": null,
  "room_rent_per_day": null,
  "has_full_itemized_breakup": true,
  "implant_used": false,
  "implant_invoice_present": null,
  "policy_terms": {
    "policy_number": null, "insurer": null,
    "sum_insured": null, "room_rent_limit_per_day": null,
    "co_pay_pct": null, "deductible": null, "sublimit": null,
    "policy_start_date": null
  },
  "bills": [
    { "bill_type": "IPD_MAIN|OPD|PHARMACY|IMAGING|OTHER",
      "bill_number": null,
      "stated_total": null,
      "lines": [{ "description": "string", "amount": 0, "non_payable": false, "room_linked": false }] }
  ]
}
Dates as YYYY-MM-DD. Use null for anything not visible on the document.

"policy_terms" comes from the POLICY SCHEDULE / policy copy / cashless card / pre-auth letter if
one is in the file. Claim files very often include it. Fill only what is actually printed and
leave the rest null - NEVER guess a room-rent limit or a co-pay. A room limit written as a
percentage ("1% of sum insured") must be converted to rupees per day. The policy start date is
the FIRST inception date, not this year's renewal date.

"stated_total" is the grand total PRINTED on that bill (net amount / total bill amount / gross
total). Copy it exactly as printed - do NOT add the lines up yourself. Leave it null if the bill
does not show a total. This is how a missing page or a bill left out of the file gets caught.

For each line also judge two flags, using IRDAI norms:

"non_payable" = true only for non-medical / lifestyle / administrative charges an indemnity
policy never pays: attendant or visitor charges, extra bed, baby food, beauty or cosmetic items,
telephone / TV / internet / newspaper, toiletries, laundry, packaged water, documentation and
medical-record charges, admission / registration charges, surcharges, gloves / masks / PPE,
vitamins and tonics not part of treatment, sanitary items, take-home devices.
NEVER set it true just because a line sounds incidental - implants and prosthetics, pharmacy
actually administered, diagnostics, OT consumables that are part of the surgical package, and the
patient's own prescribed diet are all PAYABLE.

"room_linked" = true only for charges that scale with room category: the room rent line, nursing,
surgeon / consultant / doctor visit fees, OT charges, anaesthetist. Set it FALSE for medicines and
pharmacy, implants, diagnostics and investigations, flat-rate consumables, and ambulance - under
IRDAI these are fixed-cost and are NOT proportionately reduced.

If a line is non_payable, room_linked must be false.`;

      // A claim file can be 50 MB of scans. Gemini's limit is per file, so an oversized PDF is
      // split and passed as several file_data parts in this one call - see pdf-split.js.
      const prep = await buildGeminiParts(buf, mimeType, this.apiKey);
      if (prep.split) {
        console.log(`[Gemini OCR] ${(buf.length / 1048576).toFixed(1)} MB / ${prep.pages} pages -> ${prep.chunks} chunks`);
      }
      const parts = prep.parts.slice();
      if (prep.split) {
        parts.push({ text: 'These files are PARTS OF ONE document, in page order. Treat them as a single claim file.' });
      }
      parts.push({ text: prompt });

      // The free tier throttles hard and answers 429 with a retry delay. Without this a single
      // burst lost the whole document - the 51 MB Komal file died on exactly this.
      // 503 (overloaded) is retried the same way.
      let result = null, lastErr = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          result = await model.generateContent(parts);
          break;
        } catch (e) {
          lastErr = e;
          const msg = String(e && e.message || e);
          const retriable = /\b(429|503)\b|Too Many Requests|overloaded|quota/i.test(msg);
          if (!retriable || attempt === 3) { throw e; }
          const asked = (msg.match(/retry in ([\d.]+)s/i) || [])[1];
          const waitMs = asked ? Math.ceil(Number(asked) * 1000) + 1000 : (attempt + 1) * 20000;
          console.log(`[Gemini OCR] ${/429/.test(msg) ? 'rate limited' : 'overloaded'}, ` +
            `${Math.round(waitMs / 1000)}s baad retry (${attempt + 1}/3)`);
          await new Promise(r => setTimeout(r, waitMs));
        }
      }
      if (!result) { throw lastErr || new Error('Gemini did not respond'); }

      const responseText = result.response.text();
      let parsed;
      try {
        parsed = JSON.parse(responseText);
      } catch (e) {
        // Gemini has returned JSON with the final brace missing before; salvage what we can
        // rather than discarding a whole document's extraction.
        const m = responseText.match(/\{[\s\S]*\}/);
        if (!m) { throw new Error("Gemini did not return JSON"); }
        parsed = JSON.parse(m[0]);
      }

      const bills = Array.isArray(parsed.bills) ? parsed.bills : [];
      const lineCount = bills.reduce(
        (n, b) => n + ((b && Array.isArray(b.lines)) ? b.lines.length : 0), 0);
      console.log(
        `[Gemini OCR] structured: doc_type=${parsed.doc_type} bills=${bills.length} lines=${lineCount}`
      );

      return { success: true, data: parsed, lineCount: lineCount };
    } catch (error) {
      console.error("[Gemini OCR] extractStructuredClaim error:", error.message);
      return { success: false, error: error.message, data: null, lineCount: 0 };
    }
  }

  /**
   * Analyze extracted text for insurance claim details
   */
  async analyzeClaimText(extractedText, extractedTables = []) {
    try {
      console.log("[Gemini OCR] Analyzing claim text...");

      const analysisPrompt = this.buildAnalysisPrompt(
        extractedText,
        extractedTables
      );

      const model = this.client.getGenerativeModel({
        model: this.modelName,
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: 4096,
        },
      });

      const result = await model.generateContent(analysisPrompt);
      const analysis = result.response.text();

      return {
        success: true,
        analysis: analysis,
        raw_response: analysis,
      };
    } catch (error) {
      console.error("[Gemini OCR] Analysis error:", error.message);
      return {
        success: false,
        error: error.message,
        analysis: "",
      };
    }
  }

  /**
   * Build comprehensive analysis prompt
   */
  buildAnalysisPrompt(text, tables) {
    return `You are an expert insurance claim analyst. Analyze this insurance claim document and provide a comprehensive analysis in JSON format.

EXTRACTED TEXT:
${text}

TABLES FOUND:
${tables.length > 0 ? JSON.stringify(tables, null, 2) : "None"}

REQUIRED ANALYSIS:
Provide ONLY valid JSON (no markdown, no extra text) with this exact structure:
{
  "claim_summary": {
    "policy_number": "extracted value or null",
    "policyholder_name": "extracted value or null",
    "date_of_birth": "YYYY-MM-DD or null",
    "hospital_name": "extracted value or null",
    "hospital_address": "extracted value or null",
    "admission_date": "YYYY-MM-DD or null",
    "discharge_date": "YYYY-MM-DD or null",
    "treatment_duration_days": number or null,
    "diagnosis": "extracted value or null",
    "treatment_type": "EMERGENCY/PLANNED/OTHER or null",
    "claimed_amount": number or null,
    "currency": "INR"
  },
  "coverage_flags": {
    "network_hospital": "✅ COVERED / ⚠️ UNCLEAR / ❌ NOT COVERED",
    "pre_authorization": "✅ OBTAINED / ⚠️ MISSING / ❌ NOT APPLICABLE",
    "emergency_admission": "✅ COVERED / ⚠️ NEEDS_REVIEW / ❌ NOT EMERGENCY",
    "pre_existing_condition": "✅ NOT_MENTIONED / ⚠️ MENTIONED / ❌ MIGHT_AFFECT",
    "waiting_period": "✅ MET / ⚠️ UNCLEAR / ❌ NOT_MET"
  },
  "inconsistencies": [
    {
      "type": "SPECIFIC_TYPE",
      "severity": "HIGH/MEDIUM/LOW",
      "details": "What inconsistency was found",
      "action_required": "What to verify",
      "impact": "How it affects claim"
    }
  ],
  "risk_assessment": {
    "overall_risk_score": "LOW/MEDIUM/HIGH",
    "risk_level": "number 1-10",
    "risk_factors": ["factor1", "factor2"],
    "recommendation": "APPROVE/REQUEST_CLARIFICATION/REJECT/HOLD"
  },
  "action_items": [
    {
      "priority": "HIGH/MEDIUM/LOW",
      "item": "What needs to be done",
      "reason": "Why it's needed"
    }
  ]
}

IMPORTANT:
- Return ONLY valid JSON, no other text
- If a field is unknown, use null
- Be thorough but accurate
- Flag any suspicious patterns
- Consider Indian insurance norms and forms`;
  }

  /**
   * Main processing function: Extract + Analyze
   */
  async processClaimFile(filePath, claimMetadata = {}) {
    try {
      console.log("[Gemini OCR] Starting claim processing...");

      // Step 1: Extract from PDF
      const extraction = await this.extractFromPDF(filePath);
      if (!extraction.success) {
        return { success: false, error: extraction.error };
      }

      // Step 2: Analyze extracted text
      const analysis = await this.analyzeClaimText(
        extraction.text,
        extraction.tables
      );
      if (!analysis.success) {
        return { success: false, error: analysis.error };
      }

      // Step 3: Parse analysis JSON
      let parsedAnalysis;
      try {
        parsedAnalysis = JSON.parse(analysis.analysis);
      } catch (e) {
        const jsonMatch = analysis.analysis.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsedAnalysis = JSON.parse(jsonMatch[0]);
        } else {
          console.warn(
            "[Gemini OCR] Could not parse analysis as JSON, returning raw text"
          );
          parsedAnalysis = { raw_analysis: analysis.analysis };
        }
      }

      return {
        success: true,
        data: {
          fileName: path.basename(filePath),
          filePath: filePath,
          extractedText: extraction.text,
          tables: extraction.tables,
          analysis: parsedAnalysis,
          metadata: {
            ...claimMetadata,
            provider: "gemini",
            model: this.modelName,
            processedAt: new Date().toISOString(),
          },
        },
      };
    } catch (error) {
      console.error("[Gemini OCR] Processing error:", error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Process large PDFs (Gemini handles multi-page PDFs natively)
   */
  async processLargePDF(filePath, pageLimit = 10) {
    console.log(
      `[Gemini OCR] Note: Gemini handles multi-page PDFs natively (limit hint: ${pageLimit})`
    );
    return this.processClaimFile(filePath);
  }
}

module.exports = ClaimOCRProcessor;
