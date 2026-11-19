# Trade Intelligence Engine — Live Dashboard

Deterministic buyer-intelligence engine over `common-service.standard_port_data`, served as a
**live, self-refreshing dashboard**. Reads Mongo **read-only**; computed snapshots are cached to
local disk (`cache/latest.json`) and **never written back to Mongo**.

## Run

```bash
cd /home/aaziko/aaziko/trade-intelligence
node server.js                     # foreground (dev)
# or detached (survives your shell, not a reboot):
setsid nohup node server.js > logs/server.log 2>&1 < /dev/null & disown
```

Open **http://<host>:3077/** (currently port 3077). The page auto-polls every 45s and has a
**Refresh now** button.

## How it stays current

- **Every movement** — a watcher polls a DB *fingerprint* (row count + latest `DATE_ISO`) for the
  watched HS codes every `poll_seconds`. When it changes (new shipments land), it recomputes.
- **Every day** — a guaranteed full recompute at `daily_hour_utc`.
- **On demand** — `GET /api/refresh`.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /` | the dashboard |
| `GET /api/state` | latest snapshot + server status (JSON) |
| `GET /api/refresh` | force a recompute now |
| `GET /api/buyer_full?name=<IMPORTER_NAME>` | a buyer's per-product patterns across ALL HS codes (cadence, suppliers, per-supplier patterns, sourcing type, switch log) |
| `GET /api/portfolio?name=<IMPORTER_NAME>` | a buyer's HS-level portfolio summary |
| `GET /health` | liveness, run count, last error |

## Configure — `config.json`

- `watch_hs[]` — HS codes to track (string form as stored in `standard_port_data`, e.g. `"69072100"`).
  Add entries to widen the console. `label`/`family` are display text.
- `buyers_per_hs` — top-N buyers per HS (by shipment count).
- `tariff_exporter` — origin country for the tariff lanes (default `India`).
- `poll_seconds`, `daily_hour_utc` — refresh cadences.

## Stop / restart

```bash
lsof -ti tcp:3077 | xargs -r kill -TERM        # stop
```

## Gotchas (verified live)

- **HS form differs across collections.** `standard_port_data.HS_CODE` is the 8-digit string
  (`"69072100"`); `macmap_tariff.HsCode` is 6-digit (`"690721"`). The server strips to HS6 before
  the tariff lookup — keep this if you add collections.
- **Buyer junk.** `STD_BUYER_NAME` contains bill-of-lading tokens (`TO THE ORDER`, `NULL`) — filtered
  in `engine.isJunkBuyer` and the discovery `$match`.
- **`STD_BUYER_NAME` is not indexed; `HS_CODE` is.** Always enter through an HS slice.
- **Single-supplier is a slice artifact** (per-exporter uploads) — flagged in `confidence_basis`, not
  asserted as sole-sourcing.

## Not yet done (offered as next steps)

- **Reboot persistence** — no systemd unit yet; after a host reboot, relaunch with the detached
  command above (or ask to install a systemd service).
- **Freight/transit source** — `india_advantage` stays `UNKNOWN` until a rate source (e.g. Searates) is wired.
- **Indian supplier match** — bind `indiaProduct` for `supplier_match_results`.
