import { createSession, isSecureRequest, sessionCookie } from "../../../../lib/auth";
import { ensureDatabase } from "../../../../db/runtime";
import { verifyPassword } from "../../../../lib/security";

type LoginRow = { id: string; fullName: string; username: string; passwordHash: string; passwordSalt: string; role: "owner" | "admin" | "supervisor" | "employee"; mustChangePassword: number; notificationEnabled:number };

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { username?: string; password?: string };
  const username = body.username?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";
  if (!username || !password) return Response.json({ error: "نام کاربری و رمز عبور الزامی است." }, { status: 400 });

  let db: Awaited<ReturnType<typeof ensureDatabase>>;
  try {
    db = await ensureDatabase();
  } catch {
    return Response.json(
      { error: "پایگاه داده در دسترس نیست؛ تنظیمات Backend را بررسی کنید." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  const user = await db.prepare(`SELECT id, full_name AS fullName, username, password_hash AS passwordHash, password_salt AS passwordSalt, role, must_change_password AS mustChangePassword, notification_enabled AS notificationEnabled FROM users WHERE username = ? AND status = 'active'`).bind(username).first<LoginRow>();
  if (!user || !(await verifyPassword(password, user.passwordSalt, user.passwordHash))) {
    return Response.json({ error: "نام کاربری یا رمز عبور درست نیست." }, { status: 401 });
  }

  const { token, expires } = await createSession(user.id);
  await db.batch([
    db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(new Date().toISOString(), user.id),
    db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'auth.login', 'user', ?, '{}', ?)").bind(crypto.randomUUID(), user.id, user.id, new Date().toISOString()),
  ]);
  const response = Response.json({ user: { id: user.id, fullName: user.fullName, username: user.username, role: user.role, mustChangePassword: Boolean(user.mustChangePassword), notificationEnabled:Boolean(user.notificationEnabled) } });
  response.headers.set("Set-Cookie", sessionCookie(token, expires, isSecureRequest(request)));
  return response;
}
