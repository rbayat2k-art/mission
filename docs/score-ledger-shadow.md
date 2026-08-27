# ADR: Score ledger in shadow mode

## Status

Accepted for local validation; not yet released.

## Decision

`score_ledger_entries` is an append-only audit mirror of score mutations that already exist. The current mission and work-session score columns remain the only product source of truth. Employee UI, management reports, Excel exports, attendance, GPS handling, and scoring rules do not read from the ledger.

Each non-zero entry contains a signed delta, one bucket (`confirmed`, `pending`, or `penalty`), existing entity references, actor, reason/source, occurrence time, metadata, and a deterministic unique idempotency key. Application and backfill paths use insert-only statements. A pending approval transfer is represented as a negative pending delta and the corresponding confirmed delta; rejected, cancelled, reopened, or reset values are mirrored as offsetting entries rather than editing history.

Penalty entries use a negative `points_delta`. This convention is only for reconciliation; it does not introduce any new deduction rule. GPS and tracking alerts never create ledger entries.

## Backfill and reconciliation

The opening backfill is a maintenance operation run by `deploy.sh` while the application process is suspended. It refuses to run unless an explicit non-future `SCORE_LEDGER_BACKFILL_CUTOFF` and `SCORE_LEDGER_BACKFILL_MAINTENANCE=confirmed` are supplied, takes a named database lock, captures per-table high-water marks, and scans bounded pages through those marks. A durable `opening-v1` completion marker makes later deployments reconciliation-only, so post-cutover rows cannot receive a second opening balance. Deterministic keys use duplicate-key-only handling: an idempotency collision is harmless, while foreign-key, truncation, and other database errors still roll back. The script finishes with reconciliation and fails closed on any mismatch. It has no effect on current scores. The reconciliation API is read-only, `owner`/`admin` only, no-store, and compares ledger totals against the current columns.

## Guardrails

- No application `UPDATE` or `DELETE` is permitted on `score_ledger_entries`.
- No automatic or retroactive product behavior is derived from ledger data.
- No employee UI or performance report may read from the ledger during shadow mode.
- Any future cutover requires a separate decision, reconciliation evidence, and explicit approval.
