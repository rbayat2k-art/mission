import { createHash } from "node:crypto";
import { isIP } from "node:net";

type RateLimitRow = { keyHash:string; blockedUntil:number|string };
type Statement = {
  bind: (...values:unknown[]) => Statement;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{results:T[]}>;
  run: () => Promise<unknown>;
};
export type LoginRateLimitDatabase = { prepare:(sql:string)=>Statement };

const WINDOW_MS = 15 * 60_000;
const BLOCK_MS = 15 * 60_000;
const MAX_ACCOUNT_ATTEMPTS = 8;
const MAX_IP_ATTEMPTS = 30;

function hashKey(value:string) {
  return createHash("sha256").update(value).digest("hex");
}

function trustedClientIp(request:Request) {
  const value = request.headers.get("x-tapra-client-ip")?.trim() ?? "";
  return isIP(value) ? value : null;
}

export function loginRateLimitKeys(request:Request, username:string) {
  const account = username.trim().toLowerCase().slice(0, 160);
  const ip = trustedClientIp(request);
  return {
    accountKey:hashKey(`account:${account}`),
    ipKey:ip ? hashKey(`ip:${ip}`) : null,
  };
}

export async function loginRateLimit(database:LoginRateLimitDatabase, request:Request, username:string, now = Date.now()) {
  const { accountKey, ipKey } = loginRateLimitKeys(request, username);
  const keyHashes = ipKey ? [accountKey, ipKey] : [accountKey];
  const placeholders = keyHashes.map(() => "?").join(", ");
  const rows = await database.prepare(`SELECT key_hash AS keyHash, blocked_until AS blockedUntil FROM login_rate_limits WHERE key_hash IN (${placeholders})`)
    .bind(...keyHashes).all<RateLimitRow>();
  const blockedUntil = rows.results.reduce((latest, row) => Math.max(latest, Number(row.blockedUntil) || 0), 0);
  return {
    allowed:blockedUntil <= now,
    retryAfterSeconds:Math.max(1, Math.ceil((blockedUntil - now) / 1_000)),
  };
}

async function increment(database:LoginRateLimitDatabase, keyHash:string, keyType:"account"|"ip", maximum:number, now:number) {
  const resetAt = now + WINDOW_MS;
  const blockedUntil = now + BLOCK_MS;
  const updatedAt = new Date(now).toISOString();
  await database.prepare(`INSERT INTO login_rate_limits (key_hash, key_type, failures, window_started_at, reset_at, blocked_until, updated_at)
    VALUES (?, ?, 1, ?, ?, 0, ?)
    ON DUPLICATE KEY UPDATE
      blocked_until = CASE WHEN reset_at <= ? THEN 0 WHEN failures + 1 >= ? THEN GREATEST(blocked_until, ?) ELSE blocked_until END,
      failures = CASE WHEN reset_at <= ? THEN 1 ELSE failures + 1 END,
      window_started_at = CASE WHEN reset_at <= ? THEN ? ELSE window_started_at END,
      reset_at = CASE WHEN reset_at <= ? THEN ? ELSE reset_at END,
      updated_at = ?`).bind(
        keyHash, keyType, now, resetAt, updatedAt,
        now, maximum, blockedUntil,
        now,
        now, now,
        now, resetAt,
        updatedAt,
      ).run();
}

export async function recordLoginFailure(database:LoginRateLimitDatabase, request:Request, username:string, now = Date.now()) {
  const { accountKey, ipKey } = loginRateLimitKeys(request, username);
  await increment(database, accountKey, "account", MAX_ACCOUNT_ATTEMPTS, now);
  if (ipKey) await increment(database, ipKey, "ip", MAX_IP_ATTEMPTS, now);
}

export async function clearLoginFailures(database:LoginRateLimitDatabase, request:Request, username:string) {
  const { accountKey } = loginRateLimitKeys(request, username);
  await database.prepare("DELETE FROM login_rate_limits WHERE key_hash = ?").bind(accountKey).run();
}
