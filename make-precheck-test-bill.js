// A bill whose correct answer is already known, so one WhatsApp round-trip proves the whole
// chain at once: OCR -> line classification -> deduction waterfall.
//
// These are the exact eight lines from the health-claim-review skill's worked example. With the
// policy values printed on the sheet, the only correct outcome is:
//
//   Total bill       Rs 2,00,000
//   Claimable        Rs 1,25,437
//   Non-claimable    Rs   74,563
//   Proportionate deduction Rs 50,625 at ratio 0.625
//
// If the bot replies with those numbers, every stage in between is right.
const fs = require('fs');

const LINES = [
  'SHREE KRISHNA MULTISPECIALITY HOSPITAL',
  'Surat, Gujarat            Phone: 0261-2345678',
  '',
  'FINAL ITEMIZED BILL  (IPD)',
  '--------------------------------------------------------------',
  'Patient Name       : RAJESH KUMAR',
  'Bill Number        : IPD/2026/00871',
  'Admission Date     : 01/06/2026',
  'Discharge Date     : 06/06/2026',
  'Diagnosis          : Acute Cholecystitis - Laparoscopic Cholecystectomy',
  'Room Category      : Private Deluxe  (Rs 8,000 per day x 5 days)',
  '',
  'ITEMIZED CHARGES',
  '--------------------------------------------------------------',
  'Description                                          Amount (Rs)',
  '--------------------------------------------------------------',
  'Room rent (5 days @ 8,000)                              40,000',
  'Nursing charges                                         15,000',
  'Surgeon fee                                             60,000',
  'OT charges                                              20,000',
  'Investigations / diagnostics                            25,000',
  'Medicines / pharmacy                                    30,000',
  'Consumables / gloves (non-medical)                       8,000',
  'Attendant / food charges                                 2,000',
  '--------------------------------------------------------------',
  'GROSS TOTAL                                           2,00,000',
  '--------------------------------------------------------------',
  '',
  'Payment Mode       : Cash / NEFT',
  'Hospital Stamp     : (stamped)',
  'Authorised Sign    : (signed)',
  '',
  '',
  'POLICY DETAILS  (the bot asks these one at a time)',
  '--------------------------------------------------------------',
  '  Sum insured ..................  500000',
  '  Room rent limit per day ......    5000',
  '  Co-pay % .....................      10',
  '  Policy start date ............  01/04/2022',
  '  PED case? ....................  NAHI',
  '  In exclusion list? ...........  NAHI',
  '',
  'EXPECTED RESULT   Claimable Rs 1,25,437   Non-claimable Rs 74,563'
];

function buildPdf(lines) {
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  let content = 'BT\n/F1 10 Tf\n40 770 Td\n13 TL\n';
  lines.forEach((l, i) => { content += (i === 0 ? '(' + esc(l) + ') Tj\n' : 'T*\n(' + esc(l) + ') Tj\n'); });
  content += 'ET';

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length ' + Buffer.byteLength(content) + ' >>\nstream\n' + content + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>'
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
fs.writeFileSync('precheck-test-bill.pdf', out);
console.log('wrote precheck-test-bill.pdf  (' + out.length + ' bytes)');
console.log('expected: total 2,00,000 | claimable 1,25,437 | non-claimable 74,563 | proportionate 50,625');
