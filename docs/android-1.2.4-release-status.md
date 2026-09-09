# Android 1.2.4 release readiness — 2026-09-09

## Current scope

The approved follow-up retains one package and creates a permanent local signing
identity. Candidate commits are on `codex/android-1-2-4-release` only; main,
production, the website/database and employee phones remain untouched. Historical
investigation findings below are retained with their follow-up explicitly recorded.
This document is **not** an APK release announcement.

## Initial investigation scope (historical)

User requested delivery of the Android native fixes already in web release commit
`4fc1bb07b2723bf8f2c478b9c501eec849818520`. Follow-up work is local on
`codex/android-1-2-4-release`. No main, GitHub, production, database, phone storage,
signing key, or installed application was changed. This document is **not** an APK
release announcement.

## Android 15 capture failure

Run `34347522066` installed and launched the APK on API 35 and passed its battery
gate. The final `uiautomator dump` reported the XML output path, then exited 137
before the workflow pulled and inspected the hierarchy. The retained logs do not
establish why the tool was killed, or establish an app crash.

Both UI-capture steps now call `scripts/android/capture_ui.py`:

- Generate a unique remote path for each attempt; never reuse previous XML.
- Require the dump completion marker to match that exact path.
- Pull to a fresh local temporary directory and parse the complete XML.
- Require a hierarchy root and actual nodes owned by `ir.taprasystem.employee`.
- Reject unexpected exit statuses, timeout, missing output, pull errors, invalid
  XML and foreign-package-only output.
- Status 137 is recoverable **only** with all the independent evidence above,
  and emits a warning explicitly stating that the dump command did not succeed.
  This is validated evidence recovery, not a claim of a successful command.

Battery-gate, startup-error, activity and crash assertions remain. A positive
employee-login heading assertion and repeated post-capture crash/activity checks
were added. A valid XML file alone is not sufficient to pass the app test.

## Local checks

- Python capture-policy suite: 13 methods, including multiple invalid-output and
  status subcases; all passed with real temporary XML and mocked ADB.
- Complete Node unit suite: 150 passed, zero failed/skipped. Includes native
  lifecycle compilation/execution with the available JDK 8.
- TypeScript and Lint passed.
- The changed emulator workflow has **not** run on API 23/29/35. No APK build,
  upgrade test, physical phone test, new E2E run or new online audit is claimed.
- Local dependencies still include Next 16.3.1 although the committed lockfile
  requires 16.3.4. These local checks do not replace the prior exact-lock CI gates.
- JDK 17, Gradle and Android SDK are not ready locally. The old task-local
  `jdk17.zip` could not be opened as a ZIP; it was not executed or deleted.

## Signing is still a separate release blocker

The last published release is `android-test-v1.2.3-22`. Its APK is the same file
already in Downloads (SHA-256
`9c2dc48d3f9e404cc9adec488272be937a4d71b1c292921ca078933cce6eb6bf`).
The old workflow used `assembleDebug` on a hosted Ubuntu runner. It uploaded the
APK and checksum, not the generated debug keystore. Repository Actions secrets
are empty. Read-only searches of the relevant Android/project/build locations
did not locate a signing keystore. This is not proof that no separate backup
exists outside those locations.

An APK/public certificate is not its private signing key. Without a compatible
key, a newly signed APK cannot safely be presented as an in-place update of the
existing application. See [Android app-signing guidance](https://developer.android.com/studio/publish/app-signing#considerations).

The source version remains 1.2.4/code 23. The suffix `22` of the old GitHub release
was a workflow run number; it must not be used as proof of the installed APK's
manifest versionCode. Its actual manifest and signing certificate must be
checked before an upgrade test. No version number was lowered in this work.

## Next step requiring user input or approval

1. Preferred: use a separately held compatible keystore, supplied through a secure
   local path, never by pasting key material/passwords in chat or Git. Then verify
   the certificate and in-place upgrade with preserved offline data.
2. If unavailable: obtain explicit approval for a separately installed app with
   a new stable signing identity and a controlled transition. Existing offline
   queues must finish syncing and the old app's activity/tracking must be stopped
   by the employee before moving to the new app. The old app is not automatically
   uninstalled or cleared. Two apps tracking concurrently is not an acceptable
   migration plan. Details and tests must precede distribution.

No new key was generated, APK published, package identity changed, offline queue
cleared or existing app uninstalled during that initial investigation.

## Approved same-package replacement and stable key — follow-up

The user subsequently approved one application, with a one-time manual reinstall
after verified synchronization and end of activity. The separately installed
package option above was **not selected**. No user phone is authorized to be
uninstalled automatically.

- Same package and version are retained. The old signing identity is not being
  bypassed or falsely described as compatible.
- The permanent key was generated locally outside the repository. Restricted
  primary and backup directories have inheritance disabled and permit only the
  current Windows account and SYSTEM. The backup bytes were verified equal.
- Public certificate SHA-256:
  `aed8f5d6dce88b7ecbd0226b009fa4e3b5d39d2bd18c3df0730e22fbd8586385`.
- Password is random and DPAPI CurrentUser protected; no plaintext password/key
  is printed, committed, transmitted to CI or packaged for employees. This is a
  local backup, **not** proof of off-device or new-Windows-profile recovery.
- JDK17, Gradle8.11.1 and SDK35/buildtools35 were obtained from official sources
  into isolated ignored work storage; archive hashes were checked. The standard
  SDK license was accepted only for that scoped installation. No global DNS,
  proxy, registry or hypervisor changes were made.
- Local standard Google download/Maven URLs returned 404 while Google's official
  CDN served the same packages. An invocation-only Gradle init script uses that
  official Google source, without changing project repositories or TLS validation.
- Added release-only backend validation, explicit signing scripts, secret-format
  Git ignores, signed-APK smoke gates and an unsigned CI build fallback. The
  workflow is read-only and never receives private signing material or publishes.
- Preflight TypeScript/Lint/unit tests passed; local npm audit again failed with
  ECONNRESET. Exact-lock web gates, native build and final signed emulator tests
  must be recorded separately when they actually complete.

Important: the native GPS queue is separate from the web Outbox and the old bridge
does not expose a reliable native queue-empty counter. A zero web counter or a
recent point is not evidence sufficient to authorize uninstalling a real phone.
See the installation guide and ADR-003 for the required controlled handover.

## Build and signing evidence — approved follow-up

- Candidate `66a9b24fc458605f98f5c0d0d2c5a673e0a95cff` contains the release tooling;
  `643b8dcc30f997efbc78d60cb02b9067d3c3b90f` corrects verification transport and
  resolves the packaged network-policy filename from the resource table.
- Local Gradle release build succeeded: lint has 0 errors and 10 warnings.
  Gradle `testReleaseUnitTest` reports **NO-SOURCE**, not executed JVM unit tests.
  The separate Node suite executes the native tracking-scope harness with JDK17.
- Final candidate APK: package `ir.taprasystem.employee`, version 1.2.4/code 23,
  minimum API23, target API35, non-debuggable, backups disabled, HTTPS-only
  production backend, system certificate trust only. Its network resource is
  packaged as `res/8G.xml`; the original source filename is not a valid APK path.
- APK SHA-256: `2e202cf71bbf18ac1caefa465441175c734d6cea441aa485999f3dc70ca4e60b`
  (41,831 bytes). Alignment and v1/v2/v3 signatures verified for API23+.
- Signing with the restricted backup produced the **identical APK checksum**.
  This verifies recovery on this Windows profile, not on another/reset profile.
- Actual old 1.2.3 APK manifest versionCode is **7**. The prior release-tag suffix
  22 was not its manifest versionCode. New code23 is greater; signing identities
  are different, so a direct update over the old installation is not supported.
- Exact-lock web verification run `34362436785` passed Linux and Windows, each
  with 157 unit tests, 67 browser tests plus one intentional project-specific
  skip, TypeScript, Lint, Build and online audit (0 vulnerabilities). MariaDB10.11
  and MySQL8.4 fresh/legacy migration fixtures passed. No production DB was used.
- Follow-up local preflight: TypeScript, Lint, all157 Node unit tests, all24 Python
  capture/transport tests and workflow syntax validation passed. Local online
  audit's ECONNRESET remains an environment limitation; successful exact-lock CI
  audit is reported separately, not as a local success.

## Remaining verification (not passed yet)

- Automatic Android run `34362436763`: unsigned/debug builds passed, all three
  emulators installed/launched and passed battery gating, but the positive login
  heading assertion failed. Initial logs did not retain XML/screenshots, so the
  cause cannot be established from that run alone. No assertion was removed.
- Signed-APK run `34363151279`: failed **before installation** because the
  read-only Actions token could not retrieve a draft-release asset (HTTP403).
  Private signing material and broader token permissions were not introduced.
- Follow-up transport accepts only the specifically checksum-pinned small public
  APK in workflow event input, or a fixed-repository numeric asset ID, exclusively.
  Encoded/decoded sizes, strict base64 and required APK entries are validated.
  Payload bytes are never interpolated into shell or logged. A public draft is
  not published merely to make a test pass.
- Runs `34364851783` (debug/unsigned), `34364880992` (exact signed APK) and
  `34364851792` (web) are the follow-up checks; results must be recorded when
  complete. XML/screenshots from unauthenticated disposable emulators are retained
  to distinguish app failures from UI-capture failures.
- A physical phone test and verification of its native and web offline queues
  have not occurred. No employee installation/uninstall is authorized by CI alone.

## Actual emulator findings from the retained evidence

Follow-up web run `34364851792` passed all four verification jobs. Android runs
`34364851783` and `34364880992` did not pass their original login assertions:

| Stock emulator | Actual WebView | Observed result |
| --- | --- | --- |
| API23 / Android6 | 44.0.2403.119 | Local backend: unsupported JavaScript syntax. Production URL: system trust anchor missing; HTTPS correctly refused. |
| API29 / Android10 | 74.0.3729.185 | Unsupported `?` syntax in the real web bundle; stuck at web navigation restore. |
| API35 / Android15 | 124.0.6367.219 | Screenshot visibly shows the full employee login form. XML exposes only an empty WebView. |

These are **not one common failure**. The API35 screen is rendered; its hierarchy
capture is incomplete. API23/29 stock engines genuinely cannot run the current
web application. App-owned crashes were not established. On API35 the retained
`Bad file descriptor` crash belongs to the separate UiAutomation tool process,
not the TAPRA process. No failed login check is reclassified as compatible merely
because installation succeeded.

The follow-up native guard rejects a known-too-old/unknown WebView before loading
the website and explains the update requirement. The existing browser target is
Chrome80+: this lower-bound guard is **not** proof that every engine above that
version works. SSL verification remains mandatory; updating WebView alone is not
guaranteed to repair obsolete operating-system trust stores.

Subsequent API23/29 stock tests are explicitly **unsupported-engine guard tests**,
not successful login tests. Positive login remains required on API35 using fresh
visible-screen evidence when the hierarchy omits web content. Obsolete-engine
loading screens and SSL failures must never be accepted as successful login.

## Guard-enabled final candidate (awaiting final CI)

- New signed APK SHA-256:
  `2f4b707a78b7157f6577b77541ad6c2f923bfa67a060ab4d5ad866acc54b04ac`
  (45,927 bytes). It supersedes the earlier diagnostic candidate; its signature
  uses the same retained permanent certificate. Unsigned input checksum:
  `53b4521767202e4cbfcf020d2b1d145d9ca049b1cddf07536dbd0fdb8af4e7a7`.
- Native guard is battery-first and checks the actual WebView engine. It preserves
  web/native queues, cookies and active form data. Returning from a battery gate
  rechecks/rearms the page; stale navigation callbacks are ignored by generation.
  No certificate bypass or external APK source was added.
- Local release rebuild: 0 lint errors, 12 warnings; Gradle JVM tests NO-SOURCE.
  The separate compiled Java compatibility harness executes 51 assertions.
- Local preflight: all163 Node tests, all34 Python tests, TypeScript, ESLint and
  actionlint passed. New public APK transport remains checksum-pinned, bounded
  to48,000 decoded bytes /64,000 encoded characters and never contains key material.
- API35 screen verification requires four exact Persian OCR lines from a fresh,
  structurally valid screenshot with foreground/package checks. It rejects blank,
  partial, loading, error and obsolete-engine screens; no fuzzy matching. Existing
  crash, signature, package, permissions and same-key replacement checks remain.
  OCR runs locally on the disposable CI runner, not against an AI service.
- Physical login, photo access, long-running GPS/battery behavior and an old-phone
  queue-safe migration still require a controlled device check. A slight API35
  status-bar overlap with the website header was observed in diagnostic images;
  no broad layout redesign or website/production change is part of this release.
