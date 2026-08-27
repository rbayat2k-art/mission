# ADR-002: Separate execution priority from mission urgency

## Status

Accepted

## Date

2026-08-27

## Context

Managers need to tell employees which active mission should be handled first. The existing mission `priority` field represents urgency (`urgent`, `normal`, or `low`) and is used by existing screens and reports. Reusing it as an exact order would change its meaning and would not provide the requested 1–9 visual ordering.

## Decision

Add a separate nullable `execution_rank` from 1 through 9, where 1 is the highest execution priority. Existing missions remain unranked. New manager-created missions default to rank 5; employee-created missions remain unranked. Duplicate ranks are allowed and ties use the existing stable mission ordering.

Only owner/admin and an authorized direct supervisor may change the rank. Changes use optimistic versioning, a database transaction, and an audit record. The rank is displayed as a green tag and can be used as a list sort. It does not affect score, deadlines, GPS, distance, task order, mission status, or notification routing.

## Alternatives considered

- Reuse `priority`: rejected because urgency and exact execution order are different business concepts.
- Enforce unique ranks and automatically shift other missions: rejected because the scope of uniqueness (employee, day, or status) is ambiguous and shifting several rows makes concurrent updates riskier.
- Store rank only in the browser: rejected because it would not be shared, auditable, or enforceable across roles.

## Consequences

- Historical rows are preserved through additive nullable columns.
- Terminal missions retain their final rank for history but the rank can no longer be changed.
- Managers may assign the same rank to several missions; the normal tie-break rules keep the list deterministic.
- A separate version column prevents two browser tabs from silently overwriting each other.
