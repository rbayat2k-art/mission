# Android 1.2.4 release readiness — 2026-09-09

## Scope and status

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
