# Android GPS start repair — 2026-09-24

## Scope and release boundary

This repair is isolated to `codex/fix-android-gps-start`, based on `origin/main`
at `6504d7c32768c3061bf932f331a96de55b692255` and includes the previously
reviewed Android release-tooling commits. It does not change `main`, Production,
the production database, or an employee phone. It does not publish or replace an
APK. The separate Android candidate branch remains unchanged.

The last public APK release is 1.2.3. Source 1.2.4/code 23 is still a draft
candidate, and its signing identity cannot be represented as an in-place update
of the public 1.2.3 APK. This repair does not settle installation or signing
identity; release remains a separate gated task.

## Finding

The server already rejected work-start fixes older than two minutes or less
accurate than 100 m, but collapsed those cases into one generic message. The
employee-side `watchPosition` path checked numeric accuracy but not the fix
timestamp, so a cached old point with a good accuracy number could be presented
as GPS-active and submitted, only to be rejected by the server. In addition,
native permission state conflated approximate and precise grants, and the web UI
could mark tracking active before the Android service acknowledged a usable
precise GPS fix.

The code evidence supports this as the root cause with high confidence. A
physical reproduction on the employee's phone was not available, so the exact
device/provider state in the screenshot is not claimed as directly reproduced.

## Behavior after repair

- A location is trusted for starting work only when coordinates are finite and
  in range, accuracy is at most 100 m, its fix is no older than two minutes, it
  is not materially in the future, and the client clock is within two minutes
  of server time.
- The employee UI distinguishes unchecked, requesting, fresh, approximate,
  stale, denied, timeout and unavailable states. A stale/approximate point is
  never silently submitted as a fresh start.
- Stable `LOCATION_*` response codes and safe diagnostics report the failure
  category, age, accuracy and clock skew without returning coordinates.
- A repeated request with the same session id is resolved idempotently before
  freshness checks. A separate `ACTIVE_WORK_SESSION_EXISTS` conflict causes the
  client to fetch and adopt the authenticated account's active session instead
  of creating a second session.
- Android approximate and precise grants are distinguished correctly. Precise
  permission requests include both Android fine/coarse permissions where
  required, and the UI receives service lifecycle states. `active` is reported
  only after the native service gets a non-mock precise fix within 100 m.
- Notification loading is independent from restoration of an active work
  session; notification transport failure cannot hide the active session.
- The native battery startup gate remains the single employee-entry policy;
  the duplicate JavaScript battery gate was removed. Native service checks
  remain defensive. No tracking data or Outbox item is cleared by this change.

## Validation

Local validation completed on this branch:

- Node unit tests: passed.
- Android lifecycle/Java compatibility harness: passed with JDK 17.
- Python Android CI-policy tests: 51 passed.
- TypeScript, ESLint, production build and `npm audit --audit-level=moderate`:
  passed; audit reported zero vulnerabilities.
- Focused desktop-browser GPS/session-recovery tests: 4 passed.
- Full browser E2E: 125 passed, 1 existing conditional skip, 0 failed across
  desktop Chromium and Android-Chrome browser profiles. The final targeted
  rerun also passed all 10 GPS/session/notification cases across both profiles.
- No Android SDK or ADB is configured in this workspace. Emulator coverage is
  delegated to branch CI at API 23, 29, 31, 33, 34 and 35. API 23/29 test the
  explicit obsolete-WebView block; API 31+ test login rendering. Emulator
  startup tests do not prove long-running background GPS on a physical phone.

## Remaining release checks

- Wait for GitHub Actions on this repair branch, especially the Android emulator
  jobs, and record their actual outcomes rather than treating the matrix as a
  local result.
- Before distributing an APK, resolve the signed candidate identity/version
  separately and perform a controlled real-device test: precise permission,
  fresh GPS start, background/closed-app tracking, notification receipt, network
  interruption, and queue continuity after restart.
- Do not deduct points or take an attendance/disciplinary action solely from a
  GPS error. The new error is diagnostic and blocks a start until a trusted fix
  is available; it does not infer employee intent.
