# AutoSNAP data sources of truth

## Database (Supabase)

- **Production schema SoT:** `supabase/migrations/` applied with `npm run db:migrate`.
- **Nest mirror (PGlite/tests only):** `migrations/`. Do **not** set `AUTOSNAP_RUN_MIGRATIONS=true` against shared Supabase.
- **Runtime access:** Nest `DatabaseService` via `DATABASE_URL` (`search_path=autosnap,public`).
- **Master data:** `autosnap_records` EAV. Canonical relation: `endpoint` → `service` → `template`.
- **Account roles:** `admin` and `petugas`. Legacy `tester` is migrated to `petugas`; privileges and sessions stay. `autosnap_captchas` and `autosnap_evidence_screenshots` are unused and archived in `autosnap_archive` before drop.
- **Service behavior:** `service.data.capabilities` (see `backend/src/service-capabilities.ts`).

## Bundled JSON

| File | Role |
|------|------|
| `app/scenario-catalog.json` | Scenario IDs (informational SNAP templates). Pass/fail is **HTTP-only**. |
| `app/snap-spec-catalog.json` | Spec enrichment for documentation import / seed. |

## Status vocabulary (`autosnap_runs.status`)

HTTP Validation Only — SNAP `responseCode` is informational:

| Status | Meaning |
|--------|---------|
| `PASSED` | HTTP matches expected **and** all required ASPI PDFs stored |
| `COMPLETED` | HTTP matches; ASPI PDFs incomplete |
| `FAILED` | HTTP does not match expected |
| `AUTOMATION_ERROR` | No HTTP response from target API |
| `VALIDATION_ERROR` | Required config invalid before send |
| `CANCELLED` | User cancelled |
| `RUNNING` | In flight |

Evidence: official ASPI PDFs only (`autosnap_evidence_pdfs`). AutoSNAP-generated report PDFs removed.

Reprocessing: `retryAspiEvidence` downloads missing official PDFs only. It does not call the target API. A live evidence lease returns `PROCESSING` instead of `AUTOMATION_ERROR`. PDFs already stored are reconciled to `PASSED` when HTTP matched, left `COMPLETED` while any required PDF is missing, and left `FAILED` when HTTP did not match. Each attempt is appended to `request_json.reprocessAudit`. `resumeTesting` remains pre-HTTP, with explicit confirmation before a mutating retry. Same `run_id`; no duplicate history.

## ASPI live gaps (not covered by automated suite)

These need a real ASPI Developer Portal session and are intentionally left as integration gaps:

- Activity ID correlation against live portal UI / activity table changes
- Headless login session expiry mid-`resumeTesting`
- Full end-to-end official PDF download timing under production portal load
