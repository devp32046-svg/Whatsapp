# Exports — 8 dashboard companies

Source: MongoDB `common-service.standard_port_data` (222,282,898 rows)
Query:  `{ IMPORTER_NAME: { $in: [ the 8 companies on the console ] } }`  (index `IMPORTER_NAME_1`)
Extract is READ-ONLY — nothing was written to MongoDB.

10,848 documents total:
  SEADRILL PETROLEUM SERVICES LTDA 6556 · O BEHRENS AND CO PTY LIMITED 3683 · COSENTINO LATINA LTDA 193
  ETHIO CERAMICS PRIVATE LIMITED COMP 177 · AL ZAIN BUILDING MAT TR 76 · GRAMARCAL … CACHOEIRO LTDA 65
  STONELAM SURFACES LLP 50 · A B M L 48

## Raw collection documents (complete, 85 fields, nothing removed)
  <company>.json                                   one array per company
  all-8-companies.json / .pretty.json              combined, with a _meta block
  8-companies-json.zip                             all of the above zipped
  standard_port_data-8-companies.ndjson            one JSON document per line
  standard_port_data-8-companies-all.xlsx          single ALL_DOCUMENTS sheet (raw_data.* flattened)
  standard_port_data-8-companies-per-company.xlsx  one sheet per company

## Raw + processed (what the engine computes)
  aaziko-8-companies-raw-and-processed.xlsx
    README · BUYERS_SUMMARY · RAW_ROWS (10,848) · EVENTS_NORMALIZED (8,446)
    PRODUCTS (684) · SUPPLIERS (1,714) · MONTHLY (4,063) · SWITCHES (3,189)

## Regenerate
  node /home/aaziko/aaziko/trade-intelligence/export-raw.js <output.xlsx>    # raw + processed workbook
  (the JSON/NDJSON dumps were produced by ad-hoc scripts against db.js getClient())
