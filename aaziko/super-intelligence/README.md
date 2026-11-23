# Aaziko Super Intelligence — Trade Opportunity Platform

A 5-phase, read-only trade analysis system that continuously analyzes the MongoDB data warehouse to identify non-obvious, actionable business opportunities and emerging risks.

---

## Architecture

```
phase1/   Data inventory + entity map        (know what you have)
phase2/   Entity profiling + behavior         (know who your players are)
phase3/   News, sanctions, commodities        (know the external environment)
phase4/   Opportunity scoring + anomaly       (find the signal)
           + alert generation
phase5/   Backtesting + calibration           (verify and tune)
lib/      Shared: db.js (read-only), entity-resolver.js
reports/  JSON outputs (git-ignored)
server.js HTTP API — all phases on-demand
```

---

## Quick Start

```bash
# Install (runs from repo root)
cd aaziko/super-intelligence

# Generate alerts for a product
node phase4/alert-generator.js --hs 690810

# Score opportunities
node phase4/opportunity-scorer.js --hs 690810 --origin IN

# Detect anomalies
node phase4/anomaly-detector.js --hs 690810

# Full data inventory
node phase1/inventory.js --priority

# Entity behavior classification
node phase2/behavior-classifier.js "LAMINAM SPA"

# Backtest scoring quality
node phase5/backtester.js --hs 690810 --threshold 65

# Start HTTP API
node server.js --port 3030
```

---

## Phase Reference

### Phase 1 — Data Inventory
| Script | Purpose |
|--------|---------|
| `phase1/inventory.js` | Count records per collection, capture schema sample |
| `phase1/data-quality.js` | Completeness checks, stale-data detection |
| `phase1/entity-map.js` | Cross-DB entity canonical key map |

### Phase 2 — Entity Intelligence
| Script | Purpose |
|--------|---------|
| `phase2/entity-profiler.js` | Full profile: imports/exports/outreach/contacts |
| `phase2/trade-graph.js` | Buyer-supplier network by HS code or company |
| `phase2/behavior-classifier.js` | MANUFACTURER / TRADER / END_BUYER / INTERMEDIARY |

### Phase 3 — External Intelligence
| Script | Purpose |
|--------|---------|
| `phase3/news-monitor.js` | DuckDuckGo news scraping, 7 category classification |
| `phase3/sanctions-checker.js` | Country risk tiers + SDN name patterns + HS controls |
| `phase3/commodity-tracker.js` | Implicit price from VALUE_USD/QUANTITY, trend detection |

### Phase 4 — Opportunity & Anomaly
| Script | Purpose |
|--------|---------|
| `phase4/opportunity-scorer.js` | Weighted 7-dimension scoring: EMERGING_BUYER, VOLUME_GAP, etc. |
| `phase4/anomaly-detector.js` | Price anomaly, circular trade, split shipments, supplier switch |
| `phase4/alert-generator.js` | Unified prioritized alert feed (CRITICAL/HIGH/MEDIUM/LOW) |

### Phase 5 — Validation & Tuning
| Script | Purpose |
|--------|---------|
| `phase5/backtester.js` | Precision/recall vs actual shipment records |
| `phase5/calibrator.js` | Hill-climbing weight optimizer per HS code |

---

## HTTP API

Start: `node server.js --port 3030`

| Method | Path | Body |
|--------|------|------|
| GET  | `/health` | — |
| POST | `/phase4/alerts` | `{"hs":"690810","entityName":"..."}` |
| POST | `/phase4/opportunities` | `{"hs":"690810","originCountry":"IN"}` |
| POST | `/phase4/anomalies` | `{"hs":"690810"}` |
| POST | `/phase2/classify` | `{"entityName":"LAMINAM SPA"}` |
| POST | `/phase3/sanctions` | `{"importerName":"...","importerCountry":"RU","hsCodes":["854231"]}` |
| POST | `/phase5/backtest` | `{"hs":"690810","threshold":65}` |
| GET  | `/reports/alerts.json` | returns last saved report |

---

## Security & Data Rules

- **Read-only**: this platform never writes to source collections.
- **No credential storage**: DB URI is loaded from `aaziko/.secrets/mongo-uri.txt` (git-ignored).
- **Sanctions disclaimer**: the checker is a screening indicator only; always verify against official OFAC/EU/UN/BIS lists before any adverse action.
- **All aggregates must include `$limit`**: enforced by `lib/db.js`.
- **Reports are git-ignored**: `reports/*.json` contain potentially sensitive entity data.

---

## Outputs

All scripts write JSON to `reports/`:
- `reports/inventory.json`
- `reports/data-quality.json`
- `reports/entity-map.json`
- `reports/opportunities.json`
- `reports/alerts.json`
- `reports/backtest.json`
- `reports/calibration.json`
- `reports/news-monitor.json`

---

## DB Connection

Credentials: `aaziko/.secrets/mongo-uri.txt`
Host: Wits Box `100.70.212.45:27017`
Auth source: `admin`

The `lib/db.js` layer enforces read-only access and requires `limit` on every query.
