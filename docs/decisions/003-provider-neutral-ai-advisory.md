# ADR-003: Provider-neutral AI advisory phase zero

## Status

Proposed for local validation only. No external provider, key, commit, push, merge, or deployment is part of this phase.

## Date

2026-09-03

## Context

TAPRA already calculates attendance, missions, movement, GPS coverage, reports, alerts, priorities, and score data. It also has the deterministic advisory engine `tapra-deterministic-v1`. AI must not duplicate these calculations or become an operational decision-maker.

The official OpenAI supported-country list did not include Iran when checked on 2026-09-03. The architecture must therefore work without OpenAI and must not suggest regional circumvention.

## Existing capability assessment

| Capability | Audience | Required data | Sensitivity | Approximate provider cost | Internet | Works without OpenAI | Hallucination risk | Priority | Acceptance criterion |
|---|---|---|---|---|---|---|---|---|---|
| Management daily/weekly/monthly summary | Manager, supervisor | Anonymous numeric metrics and evidence paths | Low | Low | Only for an external provider | Yes, deterministic fallback | Low after allowlisted rendering | P1 MVP | Every factual item has an allowed evidence path; no side effects |
| Employee performance summary and suggestions | Employee | Only that employee's anonymous numeric metrics | Low | Low | Optional | Yes, deterministic fallback | Low after allowlisted rendering | P1 MVP | Employee cannot request another account; advice remains non-disciplinary |
| Daily/weekly/monthly comparison explanation | Manager, employee | Existing numeric deltas | Low | Low | Optional | Yes; calculations already exist | Low | P2 | Narrative agrees with deterministic deltas |
| Advisory discrepancy explanation | Manager | Aggregate integrity and mission counts | Medium | Low-medium | Optional | Yes; rules already detect events | Medium | P2 | Says “needs review”, never fraud or guilt |
| Mission conversation summary | Manager, supervisor, employee | Free-form messages | High | Medium | Yes for external provider | Limited | Medium | P2, separate consent | Scoped source links and no cross-case leakage |
| Image/PDF extraction | Manager, employee | Uploaded documents | High | Medium-high | Usually | OCR can be self-hosted | High | P3 | Confidence per field and human confirmation |
| Draft mission and task list | Manager, supervisor | Manager free text | Medium | Low-medium | Optional | Template fallback | Medium | P2 | Draft only; never assigns or submits automatically |
| Writing assistance for employee reports | Employee | Free-form report | High | Low | Optional | Limited | Medium | P2, separate consent | Original preserved; employee explicitly accepts |
| Voice-to-report | Employee | Voice recording | High | Medium | Optional with local model | Yes with self-hosted speech model | Medium | P3 | Transcript preview and explicit acceptance |
| Persian questions about reports | Manager, supervisor | Curated aggregate report facts; never raw SQL or DB access | Medium | Medium | Optional | Limited rule-based queries | High | P3 | Answers only allowlisted questions with evidence paths and authorized scope |
| Suggested mission order | Manager, employee | Deadline and anonymous operational metrics | Medium | Medium | Optional | Existing deterministic rank works | High | P3 | Never changes execution rank automatically |
| Score, discipline, fraud, expense or work-time decision | Nobody as AI decision-maker | Highly sensitive employment data | Very high | Not relevant | Not relevant | Must remain deterministic/human | Unacceptable | Prohibited | No decision or mutation path exists |

## Decision

Phase zero adds an isolated, provider-neutral advisory boundary:

1. The existing `GET /api/insights/performance` and `tapra-deterministic-v1` remain unchanged.
2. A new on-demand `POST /api/insights/performance/ai` accepts only `period` and optional `userId`; it applies the existing RBAC before producing provider input.
3. The provider receives a newly projected DTO containing only allowlisted, non-negative numeric aggregates. It never receives the complete report object.
4. The default provider is `disabled`. The only implemented provider is a local Mock that is blocked in production.
5. A provider can return only allowlisted finding/action identifiers. It cannot author user-visible text, evidence paths, commands, or employment language. TAPRA renders Persian text and the exact evidence paths from server-owned templates, making operational or disciplinary output structurally impossible.
6. Timeout, network/provider errors, invalid output, request limits, budget limits, or an open circuit return the deterministic advisory with safe fallback metadata.
7. HTTP responses stay `private, no-store` and scoped cache keys include viewer, subject, and period. The process-local cache stores only validated anonymous output.
8. Audit data is limited to request correlation, result class, latency, attempts, cache status, and bounded estimated cost. It is not persisted in phase zero, and raw input/output is never logged.
9. Providers have no tool interface, database handle, notification capability, or mutation method.

## Allowed external payload for a future approved provider

- The 13 allowlisted aggregate numeric metrics in `AiPerformanceInput`.
- A schema version, prompt version, and non-personal request correlation value.

## Forbidden external payload

- Name, username, phone number, user or supervisor identity.
- Address, coordinates, raw GPS points, routes, mission destinations.
- Mission titles, free-form reports, conversations, notes, files, images, voice.
- Passwords, API keys, authorization headers, cookies, sessions, device identifiers.
- Scores, disciplinary history, expense approval decisions, or executable actions.

## Resilience and cost controls

- Feature flags default off and role rollout defaults to an empty allowlist.
- Mock is local-only and has zero API cost.
- Deadline is bounded to 10 seconds; attempts are bounded to two.
- Cache TTL is bounded to 15 minutes and namespaced per authorized viewer and subject.
- Per-scope request rate and daily request caps are enforced before a provider call.
- A future paid adapter receives a hard per-request micro-dollar ceiling. The runtime reserves the worst-case cost for all allowed attempts before calling it, reconciles reported usage, and conservatively charges the ceiling for ambiguous timeout/network failures.
- Circuit opens after five recent provider failures.
- A real provider remains blocked when the monetary budget is zero.

These guards are process-local in phase zero. A paid multi-instance rollout would require a separately approved shared quota store and additive migration.

## Alternatives considered

### Replace deterministic calculations with AI

Rejected. It would make GPS, work time, score, and mission state non-reproducible and unsafe.

### Send complete reports for better language quality

Rejected for MVP. It exposes personal, location, and free-form content and increases prompt-injection risk.

### Call a provider from the browser or Android application

Rejected. It would expose credentials and bypass server-side role controls.

### Depend directly on one external provider

Rejected. Regional availability, reliability, cost, and legal constraints require a provider-neutral boundary and a self-hostable option.

## Consequences

- Phase zero can be fully tested without cost, credentials, or internet.
- The UI remains unchanged until a provider, budget, and rollout are separately approved.
- Deterministic facts remain authoritative and always usable.
- A future real adapter must pass the same schema, privacy, failure, security, and role-isolation tests before any external call is enabled.
