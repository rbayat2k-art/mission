import { ensureDatabase } from "../../../db/runtime";
import { requireRole } from "../../../lib/auth";
import { normalizeJalaliDeadline } from "../../../lib/mission-deadline";
import { createUserNotification } from "../../../lib/push-notifications";

export async function GET(request: Request) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor", "employee"]);
  if ("error" in auth) return auth.error;
  const db = await ensureDatabase();
  const select = `SELECT m.id, m.title, m.description, m.source, m.status, m.priority, m.assigned_to AS assignedTo, m.destination_name AS destinationName, m.result, m.report, m.expense_amount AS expenseAmount, m.score_pending AS scorePending, m.score_confirmed AS scoreConfirmed, m.score_penalty AS scorePenalty, m.score_note AS scoreNote, m.deadline, m.deadline_at AS deadlineAt, m.started_at AS startedAt, m.completed_at AS completedAt, m.created_at AS createdAt, u.full_name AS employeeName, (SELECT COUNT(*) FROM mission_attempts ma WHERE ma.mission_id = m.id) AS attemptCount FROM missions m JOIN users u ON u.id = m.assigned_to`;
  const result = auth.user.role === "employee"
    ? await db.prepare(`${select} WHERE m.assigned_to = ? ORDER BY m.created_at DESC`).bind(auth.user.id).all()
    : auth.user.role === "supervisor"
      ? await db.prepare(`${select} WHERE m.assigned_to IN (SELECT id FROM users WHERE supervisor_id = ?) OR m.created_by = ? ORDER BY m.created_at DESC`).bind(auth.user.id, auth.user.id).all()
      : await db.prepare(`${select} ORDER BY m.created_at DESC`).all();
  return Response.json({ missions: result.results });
}

export async function POST(request: Request) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor", "employee"]);
  if ("error" in auth) return auth.error;
  const body = await request.json().catch(() => ({})) as { title?: string; description?: string; priority?: string; deadline?: string | null; deadlineDate?: string | null; deadlineTime?: string | null; destinationName?: string | null; assignedTo?: string };
  const title = body.title?.trim() ?? "";
  if (!title) return Response.json({ error: "عنوان مأموریت الزامی است." }, { status: 400 });
  const db = await ensureDatabase();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const source = auth.user.role === "employee" ? "employee" : "manager";
  const assignedTo = auth.user.role === "employee" ? auth.user.id : body.assignedTo?.trim() ?? "";
  if (!assignedTo) return Response.json({ error: "انتخاب مسئول مأموریت الزامی است." }, { status: 400 });
  const assignee = await db.prepare("SELECT id, full_name AS fullName, role, supervisor_id AS supervisorId, status FROM users WHERE id = ?").bind(assignedTo).first<{ id: string; fullName: string; role: string; supervisorId: string | null; status: string }>();
  if (!assignee || assignee.status !== "active") return Response.json({ error: "کاربر انتخاب‌شده فعال یا قابل دسترس نیست." }, { status: 400 });
  if (auth.user.role === "supervisor" && (assignee.role !== "employee" || assignee.supervisorId !== auth.user.id)) {
    return Response.json({ error: "سرپرست فقط می‌تواند به کاربران زیرمجموعه خودش مأموریت بدهد." }, { status: 403 });
  }
  const normalizedDeadline = normalizeJalaliDeadline(body.deadlineDate, body.deadlineTime);
  if ("error" in normalizedDeadline) return Response.json({ error: normalizedDeadline.error }, { status: 400 });
  const deadline = normalizedDeadline.deadline ?? (body.deadline?.trim() || null);
  const deadlineAt = "deadlineAt" in normalizedDeadline ? normalizedDeadline.deadlineAt : null;
  const priority = ["low", "normal", "urgent"].includes(body.priority ?? "") ? body.priority! : "normal";
  await db.batch([
    db.prepare("INSERT INTO missions (id, title, description, source, status, priority, created_by, assigned_to, destination_name, deadline, deadline_at, created_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)").bind(id, title, body.description?.trim() ?? "", source, priority, auth.user.id, assignedTo, body.destinationName?.trim() || null, deadline, deadlineAt, now),
    db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'mission.created', 'mission', ?, ?, ?)").bind(crypto.randomUUID(), auth.user.id, id, JSON.stringify({ source, assignedTo }), now),
  ]);
  if (auth.user.id !== assignedTo) {
    await createUserNotification(assignedTo, {
      type: "mission_assigned",
      title: "مأموریت جدید",
      message: `مأموریت «${title}» به شما ارجاع شد.`,
      entityType: "mission",
      entityId: id,
      url: "/?panel=employee&screen=missions",
    });
  }
  return Response.json({ mission: { id, title, description: body.description?.trim() ?? "", source, status: "open", priority, assignedTo, employeeName: assignee.fullName, destinationName: body.destinationName?.trim() || null, deadline, deadlineAt, scorePending: 0, scoreConfirmed: 0, createdAt: now } }, { status: 201 });
}
