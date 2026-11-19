/*
 * cif-calc.js — DETERMINISTIC FOB→CIF quotation calculator (Aaziko's real costing sheet; code computes, never the LLM).
 * Formula (from Ved's sheet):
 *   Total(₹)      = QTY × Price
 *   Markup(₹)     = Total × markup%            (manual %, on goods only)
 *   Forwarding(₹) = manual lump sum / shipment
 *   Total FOB(₹)  = Total + Markup + Forwarding
 *   FOB/kg(₹)     = Total FOB / QTY     →  FOB/kg($) = FOB/kg(₹) ÷ USD-INR
 *   O/F($)        = manual ocean freight / shipment  →  O/F/kg($) = O/F / QTY
 *   CIF/kg($)     = FOB/kg($) + O/F/kg($)       (= Cost + Freight; insurance not separately added — "CIF for now")
 * Outputs are given in BOTH ₹ and $.
 * All of QTY, Price, markup%, Forwarding, USD-INR, O/F are MANUAL inputs (Ved: markup/forwarding/OF are not fixed).
 */
'use strict';

const num = (x) => { const n = parseFloat(String(x == null ? '' : x).replace(/[, ]/g, '')); return isFinite(n) ? n : null; };
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

function computeCif(inp) {
  inp = inp || {};
  const qty = num(inp.qty), price = num(inp.pricePerKg);
  const markupPct = num(inp.markupPct) || 0, forwarding = num(inp.forwarding) || 0;
  const rate = num(inp.usdInr), of = num(inp.oceanFreight) || 0;
  const errs = [];
  if (!(qty > 0)) errs.push('QTY (kg) must be greater than 0');
  if (price == null || price < 0) errs.push('Price (₹/kg) is required');
  if (!(rate > 0)) errs.push('USD-INR rate must be greater than 0');
  if (errs.length) return { error: errs.join('; ') };

  const goods = qty * price;                       // Total goods cost (₹)
  const markup = goods * (markupPct / 100);        // Aaziko margin (₹)
  const totalFobInr = goods + markup + forwarding; // Total FOB (₹)
  const fobPerKgInr = totalFobInr / qty;           // FOB per kg (₹)
  const fobPerKgUsd = fobPerKgInr / rate;          // FOB per kg ($)
  const ofPerKgUsd = of / qty;                     // ocean freight per kg ($)
  const cifPerKgUsd = fobPerKgUsd + ofPerKgUsd;    // CIF per kg ($)
  const cifPerKgInr = cifPerKgUsd * rate;          // CIF per kg (₹)

  return {
    inputs: { qty, pricePerKg: price, markupPct, forwarding, usdInr: rate, oceanFreight: of },
    breakdown: {
      goodsInr: round(goods), markupInr: round(markup), forwardingInr: round(forwarding),
      totalFobInr: round(totalFobInr),
      fobPerKgInr: round(fobPerKgInr), fobPerKgUsd: round(fobPerKgUsd, 4),
      ofPerKgUsd: round(ofPerKgUsd, 4),
      cifPerKgUsd: round(cifPerKgUsd, 4), cifPerKgInr: round(cifPerKgInr),
      cifTotalUsd: round(cifPerKgUsd * qty), cifTotalInr: round(cifPerKgInr * qty),
    },
    note: 'CIF = Cost + Freight per the costing sheet (insurance not added separately). All figures computed by code.',
  };
}

module.exports = { computeCif };

// --- self-test (should match the sheet: CIF ≈ $7.26/kg): node aaziko/service/cif-calc.js ---
if (require.main === module) {
  const r = computeCif({ qty: 100, pricePerKg: 100, markupPct: 10, forwarding: 20000, usdInr: 95, oceanFreight: 400 });
  console.log(JSON.stringify(r, null, 2));
  console.log('\nExpected per sheet: FOB/kg ₹310 = $3.26, CIF/kg = $7.26');
}
