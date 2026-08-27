# ADR: Deterministic advisory insights

## Status

Accepted for local validation. This feature is not deployed by this change.

## Decision

TAPRA exposes a small, deterministic advisory layer over the existing performance report. The engine identifier is `tapra-deterministic-v1`.

- The existing performance report remains the only source for calculations.
- The advisory engine accepts only a narrow set of numeric, structured report fields.
- Mission titles, employee reports, uploaded files, raw GPS points, and free-form text are not interpreted as instructions and are not sent anywhere.
- The engine has no provider, network request, key, database write, score mutation, mission mutation, or background action.
- Every fact, alert, and recommendation carries an `evidencePath` that points to the structured report field used.
- Wording is limited to advisory language such as “needs review”. It must not accuse a user, determine fraud, or make an employment decision.
- The response disclaimer states that insights do not change score, mission status, or verified work time.

## Access control

`GET /api/insights/performance` applies the same personnel boundary as performance reports:

- an employee can read only their own insight;
- a supervisor can read their own insight or that of a current direct employee;
- an owner or administrator can read their own insight or that of an active employee.

Responses are private and `no-store`.

## Future provider-based analysis

Adding an external model would be a separate architectural decision. It would require explicit approval, data-minimization rules, prompt-injection defenses, redaction, auditability, provider terms review, and a design that preserves the current no-side-effect rule.
