/**
 * Builds a small, real, text-based claim PDF (no dependencies) so the claim-OCR
 * pipeline can be tested end to end. Deliberately contains a few INCONSISTENCIES
 * (age mismatch, bill total that does not add up, date order) so we can check
 * whether the analyser actually flags them instead of just echoing the text.
 */
const fs = require('fs');

const LINES = [
  'STAR HEALTH INSURANCE - CLAIM FORM',
  '',
  'Policy Number      : POL-SH-2024-778213',
  'Policyholder Name  : PATEL RAMESHBHAI KANTILAL',
  'Date of Birth      : 12-MAR-1969',
  'Age (ID proof)     : 57',
  'Age (Claim form)   : 55',
  'Contact            : 9601775061',
  '',
  'Claim Number       : CLM-TEST-OCR-01',
  'Hospital           : SHREE KRISHNA HOSPITAL, SURAT',
  'Admission Date     : 08-JUL-2026',
  'Discharge Date     : 05-JUL-2026',
  'Diagnosis          : ACUTE APPENDICITIS - LAPAROSCOPIC APPENDECTOMY',
  'Room Category      : Single Private AC (policy limit: Shared)',
  '',
  'BILL BREAKDOWN',
  'Room Rent (3 days)          :  45,000',
  'Surgeon / OT Charges        :  82,500',
  'Medicines and Consumables   :  31,200',
  'Diagnostics / Lab           :  12,800',
  'Gloves, Gowns, Housekeeping :   6,400',
  'Registration / Admin        :   2,100',
  'TOTAL CLAIMED               : 2,15,000',
  '',
  'Bank Account       : HDFC 50100xxxxxx4471',
  'Nominee            : PATEL NILABEN RAMESHBHAI',
  'Documents Attached : Discharge summary, Final bill, Lab reports',
  'Signature          : (signed)'
];

function buildPdf(lines) {
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  let content = 'BT\n/F1 11 Tf\n50 760 Td\n14 TL\n';
  lines.forEach((l, i) => { content += (i === 0 ? '(' + esc(l) + ') Tj\n' : 'T*\n(' + esc(l) + ') Tj\n'); });
  content += 'ET';

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length ' + Buffer.byteLength(content) + ' >>\nstream\n' + content + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xref = pdf.length;
  pdf += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  offsets.forEach(o => { pdf += String(o).padStart(10, '0') + ' 00000 n \n'; });
  pdf += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
  return Buffer.from(pdf, 'latin1');
}

const out = buildPdf(LINES);
fs.writeFileSync('test-claim-ocr.pdf', out);
console.log('wrote test-claim-ocr.pdf  (' + out.length + ' bytes)');
console.log('planted issues: age 57 vs 55 | discharge BEFORE admission | bill items sum 1,80,000 vs claimed 2,15,000 | room upgrade vs policy | IRDAI non-payables (gloves/gowns, admin)');
