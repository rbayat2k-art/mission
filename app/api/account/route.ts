import { createSession, isSecureRequest, requireRole, sessionCookie } from "../../../lib/auth";
import { ensureDatabase } from "../../../db/runtime";
import { hashPassword, verifyPassword } from "../../../lib/security";

export async function PATCH(request: Request) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor", "employee"]);
  if ("error" in auth) return auth.error;
  const body = await request.json().catch(() => ({})) as { fullName?:string; username?:string; currentPassword?:string; newPassword?:string };
  const fullName = body.fullName?.trim() ?? "";
  const username = body.username?.trim().toLowerCase() ?? "";
  if (fullName.length < 2 || fullName.length > 190) return Response.json({ error: "نام و نام خانوادگی معتبر وارد کنید." }, { status: 400 });
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) return Response.json({ error: "نام کاربری باید ۳ تا ۴۰ کاراکتر انگلیسی و شامل حرف، عدد، نقطه، خط تیره یا زیرخط باشد." }, { status: 400 });
  if (!body.currentPassword) return Response.json({ error: "برای ذخیره تغییرات، رمز فعلی را وارد کنید." }, { status: 400 });
  if (body.newPassword && (body.newPassword.length < 10 || !/[A-Za-z]/.test(body.newPassword) || !/[0-9]/.test(body.newPassword))) return Response.json({ error: "رمز جدید باید حداقل ۱۰ کاراکتر و شامل حرف و عدد باشد." }, { status: 400 });
  const db = await ensureDatabase();
  const current = await db.prepare("SELECT password_hash AS passwordHash, password_salt AS passwordSalt FROM users WHERE id = ?").bind(auth.user.id).first<{passwordHash:string;passwordSalt:string}>();
  if (!current || !await verifyPassword(body.currentPassword, current.passwordSalt, current.passwordHash)) return Response.json({ error: "رمز فعلی صحیح نیست." }, { status: 403 });
  const duplicate = await db.prepare("SELECT id FROM users WHERE username = ? AND id <> ?").bind(username, auth.user.id).first();
  if (duplicate) return Response.json({ error: "این نام کاربری قبلاً استفاده شده است." }, { status: 409 });
  const credential = body.newPassword ? await hashPassword(body.newPassword) : null;
  const now = new Date().toISOString();
  await db.batch([
    credential
      ? db.prepare("UPDATE users SET full_name = ?, username = ?, password_hash = ?, password_salt = ?, must_change_password = 0 WHERE id = ?").bind(fullName, username, credential.hash, credential.salt, auth.user.id)
      : db.prepare("UPDATE users SET full_name = ?, username = ? WHERE id = ?").bind(fullName, username, auth.user.id),
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(auth.user.id),
    db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'account.updated', 'user', ?, ?, ?)").bind(crypto.randomUUID(), auth.user.id, auth.user.id, JSON.stringify({ usernameChanged: username !== auth.user.username, passwordChanged: Boolean(credential) }), now),
  ]);
  const { token, expires } = await createSession(auth.user.id);
  const response = Response.json({ user: { ...auth.user, fullName, username, mustChangePassword:false } });
  response.headers.set("Set-Cookie", sessionCookie(token, expires, isSecureRequest(request)));
  return response;
}
