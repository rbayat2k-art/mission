import { ensureDatabase } from "../../../../../db/runtime";
import { requireRole } from "../../../../../lib/auth";
import { hashPassword } from "../../../../../lib/security";

type UserRow = {
  id: string;
  fullName: string;
  mobile: string;
  username: string;
  role: "owner" | "admin" | "supervisor" | "employee";
  status: "active" | "invited" | "disabled";
  supervisorId: string | null;
};

type RouteContext = { params: Promise<{ id: string }> };

async function getTarget(id: string) {
  const db = await ensureDatabase();
  return db.prepare(`SELECT id, full_name AS fullName, mobile, username, role, status, supervisor_id AS supervisorId
    FROM users WHERE id = ?`).bind(id).first<UserRow>();
}

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await requireRole(request, ["owner", "admin"]);
  if ("error" in auth) return auth.error;

  const { id } = await context.params;
  const target = await getTarget(id);
  if (!target) return Response.json({ error: "کاربر پیدا نشد." }, { status: 404 });
  if (target.role === "owner") return Response.json({ error: "حساب مالک سامانه از این بخش قابل تغییر نیست." }, { status: 403 });

  const body = await request.json().catch(() => ({})) as {
    fullName?: string;
    mobile?: string;
    username?: string;
    temporaryPassword?: string;
    role?: string;
    supervisorId?: string | null;
    status?: string;
  };
  const fullName = body.fullName?.trim() ?? target.fullName;
  const mobile = body.mobile?.trim() ?? target.mobile;
  const username = body.username?.trim().toLowerCase() ?? target.username;
  const role = body.role ?? target.role;
  const status = body.status ?? target.status;
  const password = body.temporaryPassword ?? "";

  if (!fullName || !mobile || !username) return Response.json({ error: "نام، موبایل و نام کاربری الزامی است." }, { status: 400 });
  if (!["admin", "supervisor", "employee"].includes(role)) return Response.json({ error: "نقش انتخاب‌شده معتبر نیست." }, { status: 400 });
  if (!["active", "disabled"].includes(status)) return Response.json({ error: "وضعیت حساب معتبر نیست." }, { status: 400 });
  if (password && password.length < 8) return Response.json({ error: "رمز جدید باید حداقل ۸ کاراکتر باشد." }, { status: 400 });
  if (auth.user.id === id && (status !== "active" || role !== target.role)) {
    return Response.json({ error: "برای جلوگیری از قطع دسترسی، نمی‌توانید نقش یا وضعیت حساب خودتان را تغییر دهید." }, { status: 403 });
  }

  const db = await ensureDatabase();
  const duplicate = await db.prepare("SELECT id FROM users WHERE id <> ? AND (username = ? OR mobile = ?)").bind(id, username, mobile).first();
  if (duplicate) return Response.json({ error: "نام کاربری یا شماره موبایل قبلاً ثبت شده است." }, { status: 409 });

  let supervisorId: string | null = null;
  if (role === "employee") {
    supervisorId = body.supervisorId?.trim() ?? target.supervisorId ?? "";
    if (!supervisorId) return Response.json({ error: "انتخاب سرپرست برای کارمند الزامی است." }, { status: 400 });
    if (supervisorId === id) return Response.json({ error: "کاربر نمی‌تواند سرپرست خودش باشد." }, { status: 400 });
    const supervisor = await db.prepare("SELECT id FROM users WHERE id = ? AND role = 'supervisor' AND status = 'active'").bind(supervisorId).first();
    if (!supervisor) return Response.json({ error: "سرپرست انتخاب‌شده معتبر یا فعال نیست." }, { status: 400 });
  }

  if (target.role === "supervisor" && (role !== "supervisor" || status !== "active")) {
    const directReport = await db.prepare("SELECT id FROM users WHERE supervisor_id = ? AND role = 'employee' LIMIT 1").bind(id).first();
    if (directReport) return Response.json({ error: "ابتدا کارکنان زیرمجموعه این سرپرست را به سرپرست دیگری منتقل کنید." }, { status: 409 });
  }

  const now = new Date().toISOString();
  const disabling = target.status !== "disabled" && status === "disabled";
  let passwordHash: string | null = null;
  let passwordSalt: string | null = null;
  if (password) {
    const credential = await hashPassword(password);
    passwordHash = credential.hash;
    passwordSalt = credential.salt;
  }

  const statements = [
    db.prepare(`UPDATE users SET full_name = ?, mobile = ?, username = ?, role = ?, supervisor_id = ?, status = ?,
      password_hash = COALESCE(?, password_hash), password_salt = COALESCE(?, password_salt),
      must_change_password = CASE WHEN ? = 1 THEN 1 ELSE must_change_password END WHERE id = ?`)
      .bind(fullName, mobile, username, role, supervisorId, status, passwordHash, passwordSalt, password ? 1 : 0, id),
    db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'user.updated', 'user', ?, ?, ?)")
      .bind(crypto.randomUUID(), auth.user.id, id, JSON.stringify({
        fullNameChanged: fullName !== target.fullName,
        mobileChanged: mobile !== target.mobile,
        usernameChanged: username !== target.username,
        roleFrom: target.role,
        roleTo: role,
        statusFrom: target.status,
        statusTo: status,
        supervisorId,
        passwordReset: Boolean(password),
        liveTrackingRevoked: disabling,
      }), now),
  ];
  if (password || status === "disabled") statements.push(db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id));
  if (disabling) {
    statements.push(db.prepare("UPDATE work_sessions SET status = 'ended', ended_at = ?, end_source = 'account_disabled' WHERE user_id = ? AND status = 'active'").bind(now, id));
    statements.push(db.prepare("DELETE FROM push_subscriptions WHERE user_id = ?").bind(id));
  }
  await db.batch(statements);

  return Response.json({ user: { id, fullName, mobile, username, role, supervisorId, status, mustChangePassword: password ? true : undefined } });
}

export async function DELETE(request: Request, context: RouteContext) {
  const auth = await requireRole(request, ["owner", "admin"]);
  if ("error" in auth) return auth.error;

  const { id } = await context.params;
  const target = await getTarget(id);
  if (!target) return Response.json({ error: "کاربر پیدا نشد." }, { status: 404 });
  if (auth.user.id === id) return Response.json({ error: "نمی‌توانید حسابی را که با آن وارد شده‌اید حذف کنید." }, { status: 403 });
  if (target.role === "owner") return Response.json({ error: "حساب مالک سامانه قابل حذف نیست." }, { status: 403 });

  const db = await ensureDatabase();
  const references = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM users WHERE supervisor_id = ?) +
    (SELECT COUNT(*) FROM work_sessions WHERE user_id = ?) +
    (SELECT COUNT(*) FROM missions WHERE created_by = ? OR assigned_to = ?) +
    (SELECT COUNT(*) FROM approvals WHERE supervisor_id = ?) +
    (SELECT COUNT(*) FROM audit_logs WHERE actor_id = ?) +
    (SELECT COUNT(*) FROM location_points WHERE user_id = ?) +
    (SELECT COUNT(*) FROM integrity_events WHERE user_id = ? OR reviewed_by = ?) +
    (SELECT COUNT(*) FROM attachments WHERE uploaded_by = ?) AS count`)
    .bind(id, id, id, id, id, id, id, id, id, id).first<{ count: number }>();
  if (Number(references?.count ?? 0) > 0) {
    return Response.json({ error: "این کاربر سابقه عملیاتی دارد و برای حفظ گزارش‌ها حذف نمی‌شود؛ حساب را غیرفعال کنید." }, { status: 409 });
  }

  const now = new Date().toISOString();
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
    db.prepare("DELETE FROM users WHERE id = ?").bind(id),
    db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'user.deleted', 'user', ?, ?, ?)")
      .bind(crypto.randomUUID(), auth.user.id, id, JSON.stringify({ username: target.username, role: target.role }), now),
  ]);
  return Response.json({ deleted: true });
}
