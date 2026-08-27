# TAPRA 2.10.0 release notes

## Mission workflow additions

### One destination with multiple tasks

- Management can create a `task_list` mission with one shared destination and 2–10 independent tasks.
- The employee starts the mission and registers the destination once, then records the result of every task separately.
- Final mission completion is rejected while any task is unresolved.
- Completed tasks stay completed on a follow-up visit; only follow-up tasks reopen.
- Every task result change stores server time, actor, GPS evidence, an idempotent client event ID, and an append-only event.
- The mission remains a single mission for scoring, route distance, concurrent-work capacity, and reports.
- Existing `single` and `multi_stage` missions are not rewritten or backfilled.

### Execution priority 1–9

- Management can assign an execution priority from 1 through 9; 1 is the highest.
- This is separate from the existing urgency field (`urgent`, `normal`, `low`).
- Employees see a green priority tag in home, mission lists, and mission details.
- Management can sort by the priority and change it from the mission table.
- Authorized direct supervisors can change only the priorities of their current direct reports.
- Each change is transactional, version-checked, and written to the audit log.
- Priority has no effect on score, GPS, distance, status, deadline, or task ordering.

## Offline conflict policy

- A queued task update is removed only after an explicit successful or idempotent server acknowledgement.
- HTTP 409 means another device or tab changed the same task first.
- On conflict, the queued item is preserved, synchronization stops, and the employee receives a clear warning.
- The employee may refresh and review the authoritative server state, or explicitly confirm removal of only the conflicting local change; automatic deletion is forbidden.
- After an explicit removal, server data is refreshed and synchronization continues from the next queued item.
- Later queued mission completion must not pass a conflicting task update.

## Data migration

The migration is additive and repeatable:

- nullable `missions.execution_rank`;
- `missions.execution_rank_version` with a zero default;
- mission execution-rank index;
- new `mission_tasks` and `mission_task_events` tables.

No historical mission, GPS, attachment, score, user, or report row is deleted or rewritten.

## Release verification

Required before production:

- lint, TypeScript, unit tests, production build;
- browser E2E and accessibility checks;
- dependency security audit;
- fresh and representative-upgrade database migration tests;
- role and cross-user isolation checks;
- production backup, migration, health checks, service status, and recent logs.
