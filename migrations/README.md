# lastPremiumPayingDate repair

Run once against `cgpe-connect` / `clients` on 17 Jul 2026. Recorded here so the change can be
explained, checked, or undone later.

## What was wrong

`lastPremiumPayingDate` was unusable on most of the collection:

| | rows |
|---|---|
| real ISO date | 2,806 |
| times instead of dates (`00:10:00`, `00:01:39`) | 2,111 |
| empty | 4,095 |
| **total** | **9,012** |

Anything reading that field was silently working off a quarter of the data.

## The fix

`lastPremiumPayingDate = commencementDate + (ppt - 1) years`, written **only** to rows whose stored
value was unusable. The 2,806 real dates were left exactly as they were.

Rows we filled carry two extra fields:

- `premiumDateSource: 'derived'` — the date is an estimate, not a fact
- `premiumDateRaw` — whatever was there before (`"00:10:00"`, `""`)

## How accurate is the formula

Scored against the 2,791 rows that had both a real date and a usable `ppt`:

| | rows | |
|---|---|---|
| exact match | 2,372 | 85.0% |
| out by months | 118 | 4.2% |
| exactly +1 year late | 279 | 10.0% |
| out by more than a year | 22 | 0.8% |

Two things worth knowing before trusting a derived date:

**The `- 1` is not universal.** On 279 rows the real date is `commencementDate + ppt`, with no minus
one. A derived date can therefore be a year early. Fine for deciding who to ring; not fine to quote
to a client as fact — which is why anything showing a derived date should label it.

**The 22 bad rows are a data-entry problem, not a formula problem.** They look like the policy term
was typed into `ppt`:

```
ASALALIYA PAL MANISHBHAI  comm 2023-04-25  ppt 16  real date 2043-04-25   (20 years, not 16)
```

## Result

```
total rows            9012
real dates untouched  2806
derived by us         6200
raw value preserved   6200
still unusable           6   (no ppt at all)
violations               0
```

Verified against a full pre-write backup: no real date was overwritten, and nothing changed that we
did not mark as ours.

## Scripts

Run in order. Each builds a temporary n8n workflow, uses it, and deletes it.

| | |
|---|---|
| `premdate_backup_dryrun.js` | Backs up all 9,012 rows and reports what a write *would* change. Writes nothing. |
| `premdate_migrate.js` | Does the write. Refuses to run if the backup file is missing. |
| `premdate_verify.js` | Compares the live collection against the backup and fails loudly on any violation. |
| `premdate_restore.js` | Undoes it. |

`backup_lastPremiumPayingDate.json` holds the pre-write value of the field for every row. It lives
here rather than in a temp directory because it is the only way back.

Re-running the migration is safe: rows already marked `premiumDateSource: 'derived'` are skipped.

## Who reads this field

`cgpe_contact_list.json` prefers the real date and falls back to deriving one itself, tagging those
rows `(estimated)`. The admin panel reads `lastPremiumPayingDate` directly, so it picks up the
6,200 filled rows with no code change — those rows will now show a date where they used to show a
blank or a stray time.
