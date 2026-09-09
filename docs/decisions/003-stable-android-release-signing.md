# ADR-003: Retain a stable local Android signing identity

## Status

Accepted for implementation; APK delivery remains conditional on verification.

## Date

2026-09-09

## Context

The previous Android release was signed with an ephemeral CI debug key. The
workflow retained the APK, not the private keystore. No compatible key was found
in the inspected project/build locations or repository secrets. A new key cannot
authenticate an update over that existing installation.

The user explicitly approved keeping one application, retaining its package ID,
and a one-time manual reinstall only after the old application's unsent data is
confirmed synchronized and its activity has ended. Approval is not permission to
uninstall or clear a phone automatically.

## Decision

- Keep `ir.taprasystem.employee`; release 1.2.4/code 23.
- Create the signing identity once, outside Git, with restricted Windows ACLs.
  Never generate a new identity automatically during a build.
- Generate an RSA-3072 PKCS12 key with a random password. Protect the password
  with Windows CurrentUser DPAPI; never print it, put it in a command argument,
  upload it to CI, or include it in an APK or distributable archive.
- Retain a verified local backup of the keystore, protected password and public
  identity record in a separate restricted directory. This is a **local backup**,
  not portable/off-device disaster recovery: DPAPI depends on the Windows user
  profile. A separate secure recovery export/off-device backup still requires
  owner coordination before resetting Windows or moving computers.
- Build a non-debuggable release with the exact HTTPS production backend.
  Align before signing; sign locally for API 23+ with v1/v2/v3; verify alignment,
  package/version/SDK/network policy and the pinned public certificate digest.
- CI may receive the signed APK, checksum and public certificate fingerprint,
  never the private key or password. Verification of the exact signed file is
  separate from debug/local-backend tests. No signed artifact is automatically
  published to employees.
- Keep website, production data, score/work policies and the old phone intact.

## Alternatives considered

- Repeated ephemeral debug signing: rejected because it repeats the upgrade
  failure and does not provide a stable employee release.
- A different package installed alongside the old one: not selected after the
  user requested a single application; would also risk concurrent tracking.
- Silent uninstall/clear or accepting signature mismatches: rejected because it
  destroys unsent local state or defeats Android's update identity model.
- Private signing material in GitHub build artifacts/secrets: not needed; local
  signing avoids transferring the permanent key to the build environment.

## Consequences

Future APK updates can use the retained signing identity; this first replacement
is not an in-place upgrade over the old key. Server-synchronized records survive
uninstallation, but local unsent records/settings do not.

The native GPS queue and browser Outbox are different stores. The existing old
Android bridge does not expose a reliable native queue-empty status. A zero web
queue, a recent server location or a fixed waiting time is not proof that every
native account queue is empty. Do not authorize a specific phone's uninstall
without trustworthy checks of both stores after tracking has stopped; preserve
the installed application when those checks cannot be completed.

References: [Android signing](https://developer.android.com/studio/publish/app-signing#considerations),
[apksigner](https://developer.android.com/tools/apksigner).
