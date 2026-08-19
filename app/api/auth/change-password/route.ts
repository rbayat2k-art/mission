import { createSession, getSessionUser, isSecureRequest, sessionCookie } from "../../../../lib/auth";
import { ensureDatabase } from "../../../../db/runtime";
import { hashPassword } from "../../../../lib/security";

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { newPassword?: string };
  const password = body.newPassword ?? "";
  if (password.length < 10 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return Response.json({ error: "رمز جدید باید حداقل ۱۰ کاراکتر و شامل حرف و عدد باشد." }, { status: 400 });
  }
  const credential = await hashPassword(password);
  const db = await ensureDatabase();
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 0, status = 'active' WHERE id = ?").bind(credential.hash, credential.salt, user.id),
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'auth.password_changed', 'user', ?, '{}', ?)").bind(crypto.randomUUID(), user.id, user.id, now),
  ]);
  const { token, expires } = await createSession(user.id);
  const response = Response.json({ user: { ...user, mustChangePassword: false } });
  response.headers.set("Set-Cookie", sessionCookie(token, expires, isSecureRequest(request)));
  return response;
}
