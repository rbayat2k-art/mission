import { ensureDatabase } from "../db/runtime";
import type { PreparedStatement } from "./server-database";
import { hashToken, randomToken } from "./security";

export type AppRole = "owner" | "admin" | "supervisor" | "employee";
export type SessionUser = { id: string; fullName: string; username: string; role: AppRole; mustChangePassword: boolean; notificationEnabled: boolean };

function cookieValue(request: Request, key: string) {
  const cookies = request.headers.get("cookie") ?? "";
  for (const pair of cookies.split(";")) {
    const [name, ...value] = pair.trim().split("=");
    if (name === key) return decodeURIComponent(value.join("="));
  }
  return null;
}

export async function createSession(userId: string) {
  const db = await ensureDatabase();
  const token = randomToken();
  const tokenHash = await hashToken(token);
  const now = new Date();
  const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  await db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), userId, tokenHash, expires.toISOString(), now.toISOString()).run();
  return { token, expires };
}

export async function rotateSession(userId: string, statements: PreparedStatement[] = []) {
  const db = await ensureDatabase();
  const token = randomToken();
  const tokenHash = await hashToken(token);
  const now = new Date();
  const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  await db.batch([
    ...statements,
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), userId, tokenHash, expires.toISOString(), now.toISOString()),
  ]);
  return { token, expires };
}

export function sessionCookie(token: string, expires: Date, secure: boolean) {
  return `rahkar_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Expires=${expires.toUTCString()}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean) {
  return `rahkar_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function isSecureRequest(request: Request) {
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase();
  if (forwardedProtocol) return forwardedProtocol === "https";
  return new URL(request.url).protocol === "https:";
}

export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  const token = cookieValue(request, "rahkar_session");
  if (!token) return null;
  const db = await ensureDatabase();
  const tokenHash = await hashToken(token);
  const row = await db.prepare(`SELECT u.id, u.full_name AS fullName, u.username, u.role, u.must_change_password AS mustChangePassword, u.notification_enabled AS notificationEnabled FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'`).bind(tokenHash, new Date().toISOString()).first<SessionUser>();
  return row ? { ...row, mustChangePassword: Boolean(row.mustChangePassword), notificationEnabled: Boolean(row.notificationEnabled) } : null;
}

export async function revokeSession(request: Request) {
  const token = cookieValue(request, "rahkar_session");
  if (!token) return;
  const db = await ensureDatabase();
  await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await hashToken(token)).run();
}

export async function requireRole(request: Request, roles: AppRole[]) {
  const user = await getSessionUser(request);
  if (!user) return { error: Response.json({ error: "unauthorized" }, { status: 401 }) } as const;
  if (!roles.includes(user.role)) return { error: Response.json({ error: "forbidden" }, { status: 403 }) } as const;
  return { user } as const;
}
