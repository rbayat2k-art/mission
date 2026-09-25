# Work-start acquisition incident — 2026-09-25

## Scope and confidence

Repair branch: `codex/fix-android-gps-start`, baseline
`2e6679aa3f7cddd627b01fd4a06abf23cd0f1878`.
No production connection, database migration, main merge, deployment, ADB,
tunnel, physical-device validation or APK publication is part of this repair.
The existing local service on 3215 and its database were not restarted/reset.
However, the initial normal build encountered a locked standalone directory;
that generated directory was found empty afterward. Its running process still
returns health HTTP200 from memory, which does NOT prove its deleted/generated
assets remain usable. No stronger deletion or restart was attempted. Source
and database are preserved; regenerating the old test environment is separate
from this incident repair. Do not use the old 3215 endpoint as retest evidence.

The **real phone's root cause is NOT CONFIRMED**. We have the symptom, not its
runtime origin, permission state, callback trace or network response. Do not
claim that the user necessarily ran the previously built USB candidate.

Confirmed code defects and reproducible failure paths:

- In the baseline `finish`, `settled=true` and timer removal happened before
  an unguarded `clearWatch`, and before resolving/rejecting the Promise. A
  throwing cleanup therefore left the Promise pending forever. Running the
  actual baseline function in an isolated VM with a synthetic throwing
  `clearWatch` produced `promise=pending, deadlineCleared=true`.
- Watch registration preceded timer/id initialization. Synchronous adapters
  could hit uninitialized variables. Late callbacks changed GPS/UI state even
  after settlement; an invalid date could throw out of the success callback.
- The same busy label covered both GPS and the subsequent unbounded POST (or
  active-session recovery GET and Outbox count read). A hung server response
  could therefore misleadingly continue to display GPS acquisition.
- The old cache shortcut preceded secure-context checks. A new start now asks
  for a fresh fix; freshness/accuracy policies are not relaxed.

These are code-level explanations, **not proof that any specific one happened
on the employee's phone**. No-callback alone was already intended to time out
after 25 seconds in the baseline; the repair hardens that deadline rather than
claiming it did not exist.

## Trace

`.work-toggle` → `toggleWork` (single-flight) → `captureFreshGps` →
`createGpsAcquisition` (origin/native preflight) → `watchPosition` → validated
success/error/deadline → `validateTrustedLocation` → fresh fix ≤100 m and ≤60 s
→ separately bounded `sendJsonOrQueue(POST /api/work-sessions)` → server's
existing trusted-location/idempotency checks → canonical session → native
tracking startup. Native startup alone still does not prove tracking success.

Android: MainActivity installs WebChromeClient → trusted-origin gate → existing
fine/coarse runtime permission flow → pending geolocation callback resolved on
permission result/destroy. Permission callback's third parameter is retention,
not a precise-location grant. A safe boolean-only native log now records when
the WebView prompt callback actually occurs. New optional bridge methods expose
Location service state and open its settings; older APKs degrade to browser
errors/deadline if these methods are absent.

## HTTP/HTTPS findings

- Previous USB test configuration: `http://127.0.0.1:3215`; target SDK35.
- Android documents secure-origin-only HTML5 geolocation for apps targeting
  Android N or later (**above API23**, not all apps targeting API23).
  A non-secure request may be denied without invoking the prompt callback.
- Loopback is potentially trustworthy in Chromium. HTTP by itself does **not**
  prove that `window.isSecureContext` is false for 127.0.0.1 or that this caused
  the phone incident. That requires observations from the actual WebView.
- This repair deliberately fails native HTTP preflight fast, even if loopback
  reports secureContext=true. Retesting native work start requires HTTPS. This
  is a conservative test policy, not a discovered platform fact.
- No trust-all SSL, targetSdk downgrade, secure-context spoofing, network-policy
  weakening or production HTTPS change was made.

Sources:
[Android WebChromeClient geolocation callback](https://developer.android.com/reference/android/webkit/WebChromeClient#onGeolocationPermissionsShowPrompt(java.lang.String,%20android.webkit.GeolocationPermissions.Callback)),
[MDN secure contexts and loopback](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts).

## Bounded behavior

- Application timer: 25 s, installed before watch registration. Browser timeout:
  20 s. Browser errors 1/2/3 now settle immediately with separate messages.
- Poor accuracy and stale fixes have explicit progress text and can improve
  until the same deadline. 101 m cannot start work; 100 m can.
- All settlements own cleanup; observer/clearWatch exceptions cannot prevent
  settlement. Returned watch id zero and synchronous callbacks are handled.
- After cancellation/timeout, callbacks cannot change state or issue a start.
  Focus/visibility resume checks elapsed wall time. OS suspension cannot run JS
  timers while suspended; deadline enforcement resumes when JS runs again.
- POST/recovery response processing has a separate 15 s deadline and label.
  Abort does not imply a server rollback: retry reuses the same client session
  id during this page lifetime; the existing server idempotency/active-session
  guards prevent a second session. Reload still restores authoritative state.
- Timed-out/aborted fetches do not become new offline mutations. Existing queues
  are retained; no cleanup deletes employee data. Genuine offline starts still
  use the existing queue policy.
- Logout cancels acquisition before awaiting network logout. Account-generation
  guards reject late work-start replies. Duplicate taps are blocked and retries
  are manual. Outbox-count refresh cannot keep the work button busy.

## Diagnostics and user messages

Generic diagnostics contain only source, nativeApp, secureContext, permission
booleans, location service state, callback kind, standard numeric error code,
accuracy, age, elapsed time and final reason. No coordinates, user/session ids,
cookies, provider error text or credentials are logged.

Terminal states: READY, PERMISSION_DENIED, PRECISE_REQUIRED, LOCATION_DISABLED,
INSECURE_ORIGIN, POSITION_UNAVAILABLE, TIMEOUT, STALE, LOW_ACCURACY,
UNKNOWN_ERROR; CANCELLED additionally represents account/unmount cancellation.
Persian messages tell the employee to enable permission/Precise/Location, use
HTTPS for the test, obtain a fresh accurate fix, or retry after a bounded error.
Current accuracy is shown, not just the best historical reading.

## Validation evidence

- TypeScript and ESLint: passed (no lint warnings after the final ref cleanup).
- Node unit suite with the existing JDK17: 308 passed, 0 failed, 0 skipped.
- npm audit: 0 vulnerabilities, online run succeeded.
- Android offline build using the existing scoped official toolchain:
  `lintDebug` and `assembleDebug` passed. Lint: 0 errors, 13 warnings.
  `testDebugUnitTest` ran but reported NO-SOURCE (not a JVM test pass).
  Executable Java lifecycle/trusted-location/WebView helper tests are covered
  by the Node suite using JDK17. No new tools were installed.
- First Gradle attempts used the wrong cache and could not resolve the plugin;
  selecting the pre-existing `gradle-home` cache resolved this without downloads.
- First web build was blocked by EBUSY on the active service's standalone
  directory. No deletion/restart was forced. Subsequent build and browser tests
  use a source-only snapshot with copied dependencies and a blocked DB address;
  browser APIs are synthetic and never target the real database.
- Web build in the separate snapshot: passed. Nested snapshot tracing emits a
  workspace-root warning; application source files were hash-compared to the
  repair worktree. Tests use its compiled Next server on 3210, not 3215.
- Targeted browser GPS/work-start suite: 30 passed (15 each on desktop Chrome
  and Pixel-emulated Chrome), 0 failed. Includes no callback, late callbacks,
  retry, native preflights, stale/100/101 m, server timeout/reused session id,
  active-session conflict recovery and logout cancellation.
- Full Playwright suite: 149 passed, 0 failed, 1 intentional skip (mobile-only
  overflow test in desktop profile). No real phone was used.
- A source-contract test initially rejected whitespace in the extracted logout
  handler. Its regex now permits whitespace; behavior is also covered by the
  existing logout and new cancellation browser tests.
- Running lint concurrently with Playwright encountered generated temporary
  trace JavaScript. Run the final lint after Playwright finishes; this is not
  application source and no lint rule is disabled for the repair.

## Changed files

- `lib/gps-acquisition.ts`: finite acquisition, safe diagnostics/preflight/cleanup.
- `lib/work-start-deadline.ts`: bounded response/cancellation helper.
- `app/page.tsx`: distinct GPS/submission UI, lifecycle guards, manual retry,
  same-id uncertain-response recovery and early logout cancellation.
- `app/globals.css`: compact readable status/settings controls.
- `lib/offline-client.ts`: optional abort signal, no queue-on-abort.
- `android/app/src/main/java/ir/taprasystem/employee/MainActivity.java`:
  Location state/settings bridge and safe permission-callback diagnostics.
- `tests/gps-acquisition.test.mjs`: executable acquisition/deadline regressions.
- `tests/e2e/role-workflows.spec.ts`: rendered work-start incident regressions.
- `tests/e2e/offline-transport.spec.ts`: abort cannot enqueue a start.
- `tests/rendered-html.test.mjs`: updated helper/logout source contracts.
- `docs/decisions/005-trusted-android-gps-start.md`: bounded acquisition addendum.
- This incident report: evidence, confidence and retest limitations.

## Retest boundary

No physical tests were run. Desktop Chrome and Pixel-emulated Chrome are not
Android WebView/real GPS proof. Local Android build targets `https://gps-test.invalid`
as a non-routable placeholder and is **not** a distributed ready-to-install APK.
Existing installed/downloaded APKs have not been updated; the old 3215 service
has not been switched to this repair and its generated assets need rebuilding.
Use a separately approved HTTPS test environment carrying this repair before
asking the employee to validate it. ADB is not a prerequisite for this code gate.
