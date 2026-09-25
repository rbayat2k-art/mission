# ADR-005: Validate and acknowledge trusted GPS before starting work

## Status

Accepted for the repair branch; Production release remains pending verification.

## Date

2026-09-24

## Context

Employees reported that Android showed an accurate GPS reading but rejected
work start, and that activity/notifications could appear inconsistent after
closing and reopening the app. An accuracy value alone does not prove that a
fix is recent. Android approximate location can also be mistaken for a precise
grant if permission presence is represented as a single boolean. Finally,
setting the web session active before the native tracking service reports a
usable fix creates false confidence.

## Decision

- Treat a work-start fix as trusted only if it has valid numeric coordinates,
  accuracy no worse than 100 m, age no greater than two minutes, no material
  future timestamp, and client/server clock skew no greater than two minutes.
- Keep validation in a shared domain function, call it in the UI and enforce it
  again on the server. Return stable machine-readable failure codes and only
  non-sensitive diagnostics.
- Keep idempotent replay separate from validation of a new start: replaying an
  already accepted client session returns its canonical result; a new active
  session returns a distinct conflict.
- Distinguish Android precise permission from approximate permission. Request
  the paired fine/coarse permissions as Android requires. Publish native
  tracking lifecycle states to the web layer and call tracking active only
  after the service acknowledges a valid, non-mock fix.
- Restore work-session state independently from notification delivery and
  preserve account-scoped/offline data through restart and conflicts.
- Keep the existing native battery-entry gate. Remove only the duplicate web
  gate so Android settings changes are evaluated by one authoritative native
  policy.
- Expand disposable emulator CI to API 23, 29, 31, 33, 34 and 35. Older stock
  WebViews are expected to be explicitly rejected; API 31+ are expected to
  render login. This is compatibility/startup evidence, not proof of sustained
  background location on physical hardware.

## Alternatives considered

### Accept any coordinate that is numerically valid

Rejected: a stale fix can look precise and can be many minutes old.

### Silently accept stale points to avoid blocking employees

Rejected: it would record an untrusted start and conceal a device failure. The
employee instead receives a reason and can retry when a fresh fix arrives.

### Mark native tracking active as soon as Android starts the service

Rejected: service startup is not proof that precise permission, an enabled
provider or a usable GPS fix exists.

### Keep independent JavaScript and Android battery gates

Rejected: duplicated policy creates inconsistent return-from-settings behavior.
The Android entry gate remains authoritative, with defensive service checks.

## Consequences

- Stale, approximate, invalid, disabled-provider and clock-skew failures become
  distinguishable and are rejected before a new work session is persisted.
- Employees with system clock skew greater than two minutes must enable automatic
  date/time; legitimate but very imprecise fixes above 100 m need a better fix.
- The two-minute freshness and accuracy thresholds are explicit policy and may
  need adjustment only after representative device testing; do not loosen them
  from a single report.
- A real Android phone test remains necessary before distributing a release.
- No schema migration is required and existing sessions, GPS history, missions
  or reports are not modified by this change.

## Acquisition incident addendum — 2026-09-25

Keep the trusted-location and native tracking policy above. The web acquisition
uses its existing stricter 60-second capture freshness threshold. Require a
new watch and an exception-safe 25-second application deadline; treat the
subsequent work-start response as a separate bounded 15-second operation.
Preserve its client session id for uncertain-response retries and cancel on
account changes. Native test acquisition now requires HTTPS, rather than
depending on different WebView interpretations of HTTP loopback trustworthiness.
No platform security requirement is bypassed. See the
[incident evidence and retest limitations](../android-gps-acquisition-incident-2026-09-25.md).
