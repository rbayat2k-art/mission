# Authenticated local test results — 2026-08-27

Scope: `codex/local-quality-audit` only. Production, `main`, and production data were not changed.

## Environment

- Local MariaDB 12.3 test instance bound to `127.0.0.1:3307`.
- Empty `tapra_test` database populated only through the additive project migration and local UI/API actions.
- Local application at `http://127.0.0.1:3210`.

## Verified flows

- Health endpoint returned 200 with the isolated database.
- Administrator login succeeded.
- Supervisor and employee accounts were created through the management UI.
- Employee first login forced a password change; the new password was accepted and the active session was preserved.
- Administrator created and assigned a mission; the assigned employee received exactly one matching notification and mission.
- A mission and notification assigned to a second employee did not leak to the first employee.
- Employee access to the administrator user endpoint was rejected with 403.
- A mismatched notification identity header was rejected with 409.
- Three concurrent mission starts were accepted, a fourth was rejected with 409, cancellation inside five minutes released a slot, and the fourth mission could then start.
- GPS accuracy of 150 metres was rejected when starting a work session.
- Account throttling activated after eight failed attempts and returned 429 on the next attempt.

## External blockers

- `npm audit` could not complete because the npm advisory endpoint repeatedly reset the connection.
- Upgrading `mysql2` could not complete because the npm registry repeatedly reset the `sql-escaper` download. The project remains on `mysql2` 3.15.3 and must not be deployed from this branch until the dependency upgrade and audit succeed.
