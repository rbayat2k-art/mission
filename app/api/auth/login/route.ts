import { ensureDatabase } from "../../../../db/runtime";
import { createSession, isSecureRequest, sessionCookie } from "../../../../lib/auth";
import { clearLoginFailures, loginRateLimit, recordLoginFailure } from "../../../../lib/login-rate-limit";
import { hashPassword, verifyPassword } from "../../../../lib/security";

type LoginRow = { id:string; fullName:string; username:string; passwordHash:string; passwordSalt:string; role:"owner"|"admin"|"supervisor"|"employee"; mustChangePassword:number; notificationEnabled:number };

function unavailable() {
  return Response.json(
    { error:"سرویس کنترل امنیت ورود یا پایگاه داده در دسترس نیست؛ کمی بعد دوباره تلاش کنید." },
    { status:503, headers:{ "Cache-Control":"no-store" } },
  );
}

export async function POST(request:Request) {
  const input: unknown = await request.json().catch(() => null);
  const body = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown> : {};
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password) return Response.json({ error:"نام کاربری و رمز عبور الزامی است." }, { status:400 });

  let db:Awaited<ReturnType<typeof ensureDatabase>>;
  try {
    db = await ensureDatabase();
  } catch {
    return unavailable();
  }

  let rateLimit:Awaited<ReturnType<typeof loginRateLimit>>;
  try {
    rateLimit = await loginRateLimit(db, request, username);
  } catch {
    return unavailable();
  }
  if (!rateLimit.allowed) return Response.json(
    { error:"تلاش‌های ورود بیش از حد مجاز است؛ چند دقیقه دیگر دوباره امتحان کنید." },
    { status:429, headers:{ "Retry-After":String(rateLimit.retryAfterSeconds), "Cache-Control":"no-store" } },
  );

  const user = await db.prepare(`SELECT id, full_name AS fullName, username, password_hash AS passwordHash, password_salt AS passwordSalt, role, must_change_password AS mustChangePassword, notification_enabled AS notificationEnabled FROM users WHERE username = ? AND status = 'active'`)
    .bind(username).first<LoginRow>();
  const passwordMatches = user
    ? await verifyPassword(password, user.passwordSalt, user.passwordHash)
    : (await hashPassword(password, "AAAAAAAAAAAAAAAAAAAAAA=="), false);
  if (!user || !passwordMatches) {
    try {
      await recordLoginFailure(db, request, username);
    } catch {
      return unavailable();
    }
    return Response.json({ error:"نام کاربری یا رمز عبور درست نیست." }, { status:401, headers:{ "Cache-Control":"no-store" } });
  }
  try {
    await clearLoginFailures(db, request, username);
  } catch {
    return unavailable();
  }

  const { token, expires } = await createSession(user.id);
  await db.batch([
    db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(new Date().toISOString(), user.id),
    db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'auth.login', 'user', ?, '{}', ?)").bind(crypto.randomUUID(), user.id, user.id, new Date().toISOString()),
  ]);
  const response = Response.json({ user:{ id:user.id, fullName:user.fullName, username:user.username, role:user.role, mustChangePassword:Boolean(user.mustChangePassword), notificationEnabled:Boolean(user.notificationEnabled) } });
  response.headers.set("Set-Cookie", sessionCookie(token, expires, isSecureRequest(request)));
  response.headers.set("Cache-Control", "no-store");
  return response;
}
