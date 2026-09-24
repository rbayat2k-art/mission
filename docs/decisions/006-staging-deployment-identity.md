# 006: Expose validated deployment identity in health responses

## Status
Accepted

## Date
2026-09-24

## Context

Physical Android testing needs proof that the app is connected to the intended isolated test backend, not production or another branch. The health response already exposes the app version, but did not identify the exact source commit or environment. Deployment configuration can contain credentials, so publishing arbitrary environment values is unsafe.

## Decision

The health endpoint exposes only three validated identity fields alongside its existing status: `version`, `commit`, and `environment`. The source is the runtime variables `APP_VERSION`, `APP_COMMIT_SHA`, and `APP_ENVIRONMENT`; the version and SHA are strictly validated, and the environment must be one of `development`, `test`, `staging`, or `production`. Invalid or missing values use safe non-secret fallbacks. No other environment variable, configuration, or credential is serialized. The endpoint remains `no-store` and reports identity on both healthy and unhealthy database checks.

For temporary physical-device testing, the app and backend must both use the same verified commit SHA, an explicitly isolated test database, a synthetic account, and a test-only HTTPS tunnel. This identity feature does not provision a database, create credentials, change GPS behavior, merge branches, or deploy production.

## Alternatives Considered

### Publish all runtime configuration

Rejected because application environments include database credentials and other secrets.

### Put the source commit in a client-visible build constant only

Rejected because it identifies the APK but cannot prove which backend is serving the request.

### Keep health responses version-only

Rejected because version numbers can be reused across builds and cannot verify branch/commit identity.

## Consequences

- The test endpoint can be checked without an authenticated request and without revealing credentials.
- Deployments that do not configure a valid commit or environment show `unknown` for those fields.
- Test scripts must set these three identity values explicitly; the production deployment process is otherwise unchanged.
