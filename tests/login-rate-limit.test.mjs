import assert from "node:assert/strict";
import test from "node:test";

import { clearLoginFailures, loginRateLimit, loginRateLimitKeys, recordLoginFailure } from "../lib/login-rate-limit.ts";

class TestDatabase {
  rows = new Map();

  prepare(sql) {
    let values = [];
    const statement = {
      bind: (...next) => { values = next; return statement; },
      first: async () => null,
      all: async () => ({
        results:[...this.rows.values()].filter((row) => values.includes(row.keyHash)),
      }),
      run: async () => {
        if (sql.startsWith("DELETE")) {
          this.rows.delete(values[0]);
          return {};
        }
        if (!sql.startsWith("INSERT")) throw new Error(`Unexpected test SQL: ${sql}`);
        const [keyHash, keyType, now, resetAt, updatedAt] = values;
        const maximum = Number(values[6]);
        const blockedUntil = Number(values[7]);
        const current = this.rows.get(keyHash);
        if (!current || current.resetAt <= now) {
          this.rows.set(keyHash, { keyHash, keyType, failures:1, resetAt, blockedUntil:0, updatedAt });
        } else {
          current.blockedUntil = current.failures + 1 >= maximum ? Math.max(current.blockedUntil, blockedUntil) : current.blockedUntil;
          current.failures += 1;
          current.updatedAt = updatedAt;
        }
        return {};
      },
    };
    return statement;
  }
}

function requestFrom(ip, extra = {}) {
  return new Request("http://127.0.0.1/api/auth/login", {
    headers:{ "x-tapra-client-ip":ip, ...extra },
  });
}

test("account throttling follows the account across changing IP addresses", async () => {
  const database = new TestDatabase();
  const username = "account-throttle-probe";
  const now = Date.UTC(2026, 7, 27, 8, 0, 0);
  for (let attempt = 0; attempt < 7; attempt += 1) {
    await recordLoginFailure(database, requestFrom(`198.51.100.${10 + attempt}`), username, now + attempt);
  }
  assert.equal((await loginRateLimit(database, requestFrom("203.0.113.89"), username, now + 8)).allowed, true);
  await recordLoginFailure(database, requestFrom("198.51.100.99"), username, now + 9);
  const blocked = await loginRateLimit(database, requestFrom("203.0.113.90"), username, now + 10);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 15 * 60);

  await clearLoginFailures(database, requestFrom("203.0.113.90"), username);
  assert.equal((await loginRateLimit(database, requestFrom("203.0.113.90"), username, now + 11)).allowed, true);
});

test("trusted client IP throttling combines failures across accounts", async () => {
  const database = new TestDatabase();
  const request = requestFrom("198.51.100.11");
  const now = Date.UTC(2026, 7, 27, 9, 0, 0);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await recordLoginFailure(database, request, `ip-throttle-${attempt}`, now + attempt);
  }
  assert.equal((await loginRateLimit(database, request, "new-account", now + 31)).allowed, false);
});

test("raw proxy headers cannot choose the IP throttle bucket", () => {
  const spoofed = new Request("http://127.0.0.1/api/auth/login", {
    headers:{ "x-forwarded-for":"198.51.100.200", "x-real-ip":"198.51.100.201", "cf-connecting-ip":"198.51.100.202" },
  });
  const plain = new Request("http://127.0.0.1/api/auth/login");
  assert.equal(loginRateLimitKeys(spoofed, "same-user").ipKey, null);
  assert.deepEqual(loginRateLimitKeys(spoofed, "same-user"), loginRateLimitKeys(plain, "same-user"));
});

test("rate-limit state survives a new limiter call because it is stored in the database", async () => {
  const persistentDatabase = new TestDatabase();
  const request = requestFrom("203.0.113.50");
  const now = Date.UTC(2026, 7, 27, 10, 0, 0);
  for (let attempt = 0; attempt < 8; attempt += 1) await recordLoginFailure(persistentDatabase, request, "restart-user", now + attempt);
  // There is no process-local bucket to preserve; a fresh invocation reads the same persisted rows.
  assert.equal((await loginRateLimit(persistentDatabase, request, "restart-user", now + 20)).allowed, false);
});

test("database failures propagate so callers can fail closed with 503", async () => {
  const failingDatabase = { prepare() { throw new Error("database unavailable"); } };
  await assert.rejects(() => loginRateLimit(failingDatabase, requestFrom("203.0.113.10"), "user"), /database unavailable/);
  await assert.rejects(() => recordLoginFailure(failingDatabase, requestFrom("203.0.113.10"), "user"), /database unavailable/);
});
