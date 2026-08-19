import { ensureDatabase } from "../../../../db/runtime";
import { requireRole } from "../../../../lib/auth";
import { hashPassword } from "../../../../lib/security";

export async function GET(request: Request) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor"]);
  if ("error" in auth) return auth.error;
  const db = await ensureDatabase();
  const baseQuery = `SELECT u.id, u.full_name AS fullName, u.mobile, u.username, u.role, u.status, u.supervisor_id AS supervisorId, u.must_change_password AS mustChangePassword, u.last_login_at AS lastLoginAt, s.full_name AS supervisorName FROM users u LEFT JOIN users s ON s.id = u.supervisor_id`;
  const result = auth.user.role === "supervisor"
    ? await db.prepare(`${baseQuery} WHERE u.supervisor_id = ? AND u.role = 'employee' ORDER BY u.created_at DESC`).bind(auth.user.id).all()
    : await db.prepare(`${baseQuery} ORDER BY u.created_at DESC`).all();
  return Response.json({ users: result.results });
}

export async function POST(request: Request) {
  const auth = await requireRole(request, ["owner", "admin"]);
  if ("error" in auth) return auth.error;
  const body = await request.json().catch(() => ({})) as { fullName?: string; mobile?: string; username?: string; temporaryPassword?: string; role?: string; supervisorId?: string | null };
  const fullName = body.fullName?.trim() ?? "";
  const mobile = body.mobile?.trim() ?? "";
  const username = body.username?.trim().toLowerCase() ?? "";
  const password = body.temporaryPassword ?? "";
  const role = body.role ?? "employee";
  if (!["admin", "supervisor", "employee"].includes(role)) return Response.json({ error: "نقش انتخاب‌شده معتبر نیست." }, { status: 400 });
  if (!fullName || !mobile || !username || password.length < 8) return Response.json({ error: "اطلاعات حساب کامل نیست یا رمز کمتر از ۸ کاراکتر است." }, { status: 400 });

  const db = await ensureDatabase();
  let supervisorId: string | null = null;
  if (role === "employee") {
    supervisorId = body.supervisorId?.trim() ?? "";
    if (!supervisorId) return Response.json({ error: "انتخاب سرپرست برای کارمند الزامی است." }, { status: 400 });
    const supervisor = await db.prepare("SELECT id FROM users WHERE id = ? AND role = 'supervisor' AND status = 'active'").bind(supervisorId).first();
    if (!supervisor) return Response.json({ error: "سرپرست انتخاب‌شده معتبر یا فعال نیست." }, { status: 400 });
  }
  const duplicate = await db.prepare("SELECT id FROM users WHERE username = ? OR mobile = ?").bind(username, mobile).first();
  if (duplicate) return Response.json({ error: "نام کاربری یا شماره موبایل قبلاً ثبت شده است." }, { status: 409 });
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const credential = await hashPassword(password);
  await db.batch([
    db.prepare("INSERT INTO users (id, full_name, mobile, username, password_hash, password_salt, role, supervisor_id, status, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?)").bind(id, fullName, mobile, username, credential.hash, credential.salt, role, supervisorId, createdAt),
    db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'user.created', 'user', ?, ?, ?)").bind(crypto.randomUUID(), auth.user.id, id, JSON.stringify({ role, username, supervisorId }), createdAt),
  ]);
  return Response.json({ user: { id, fullName, mobile, username, role, supervisorId, status: "active", mustChangePassword: true } }, { status: 201 });
}
