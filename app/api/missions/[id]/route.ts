import { ensureDatabase } from "../../../../db/runtime";
import { requireRole } from "../../../../lib/auth";
import { normalizeJalaliDeadline } from "../../../../lib/mission-deadline";

type MissionRow = {
  id: string; title: string; description: string; source: string; status: string; priority: string;
  createdBy: string; assignedTo: string; assigneeSupervisorId: string | null; destinationName: string | null;
  deadline: string | null; createdAt: string;
};

function canChangeMission(role: string, userId: string, mission: MissionRow) {
  if (role === "owner" || role === "admin") return true;
  if (role === "supervisor") return mission.createdBy === userId && mission.assigneeSupervisorId === userId;
  return mission.source === "employee" && mission.createdBy === userId && mission.assignedTo === userId;
}

async function getMission(id: string) {
  const db = await ensureDatabase();
  const mission = await db.prepare(`SELECT m.id, m.title, m.description, m.source, m.status, m.priority, m.created_by AS createdBy, m.assigned_to AS assignedTo, u.supervisor_id AS assigneeSupervisorId, m.destination_name AS destinationName, m.deadline, m.created_at AS createdAt FROM missions m JOIN users u ON u.id = m.assigned_to WHERE m.id = ?`).bind(id).first<MissionRow>();
  return { db, mission };
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor", "employee"]);
  if ("error" in auth) return auth.error;
  const { id } = await context.params;
  const { db, mission } = await getMission(id);
  if (!mission) return Response.json({ error: "مأموریت پیدا نشد." }, { status: 404 });
  if (!canChangeMission(auth.user.role, auth.user.id, mission)) return Response.json({ error: "اجازه ویرایش این مأموریت را ندارید." }, { status: 403 });
  if (mission.status !== "open") return Response.json({ error: "پس از شروع مأموریت، ویرایش آن امکان‌پذیر نیست." }, { status: 409 });

  const body = await request.json().catch(() => ({})) as { title?: string; description?: string; priority?: string; deadlineDate?: string | null; deadlineTime?: string | null; destinationName?: string | null; assignedTo?: string };
  const title = body.title?.trim() ?? "";
  if (!title) return Response.json({ error: "عنوان مأموریت الزامی است." }, { status: 400 });
  const assignedTo = body.assignedTo?.trim() ?? mission.assignedTo;
  const assignee = await db.prepare("SELECT id, full_name AS fullName, role, supervisor_id AS supervisorId, status FROM users WHERE id = ?").bind(assignedTo).first<{ id: string; fullName: string; role: string; supervisorId: string | null; status: string }>();
  if (!assignee || assignee.status !== "active") return Response.json({ error: "کاربر انتخاب‌شده فعال یا قابل دسترس نیست." }, { status: 400 });
  if (auth.user.role === "supervisor" && (assignee.role !== "employee" || assignee.supervisorId !== auth.user.id)) return Response.json({ error: "سرپرست فقط می‌تواند به کاربران زیرمجموعه خودش مأموریت بدهد." }, { status: 403 });
  if (auth.user.role === "employee" && assignedTo !== auth.user.id) return Response.json({ error: "کارمند نمی‌تواند مأموریت را به شخص دیگری منتقل کند." }, { status: 403 });

  const normalizedDeadline = normalizeJalaliDeadline(body.deadlineDate, body.deadlineTime);
  if ("error" in normalizedDeadline) return Response.json({ error: normalizedDeadline.error }, { status: 400 });
  const deadline = normalizedDeadline.deadline;
  const deadlineAt = "deadlineAt" in normalizedDeadline ? normalizedDeadline.deadlineAt : null;
  const priority = ["low", "normal", "urgent"].includes(body.priority ?? "") ? body.priority! : "normal";
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE missions SET title = ?, description = ?, priority = ?, assigned_to = ?, destination_name = ?, deadline = ?, deadline_at = ? WHERE id = ? AND status = 'open'").bind(title, body.description?.trim() ?? "", priority, assignedTo, body.destinationName?.trim() || null, deadline, deadlineAt, id),
    db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'mission.updated', 'mission', ?, ?, ?)").bind(crypto.randomUUID(), auth.user.id, id, JSON.stringify({ assignedTo, priority }), now),
  ]);
  return Response.json({ mission: { ...mission, title, description: body.description?.trim() ?? "", priority, assignedTo, employeeName: assignee.fullName, destinationName: body.destinationName?.trim() || null, deadline } });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor", "employee"]);
  if ("error" in auth) return auth.error;
  const { id } = await context.params;
  const { db, mission } = await getMission(id);
  if (!mission) return Response.json({ error: "مأموریت پیدا نشد." }, { status: 404 });
  if (!canChangeMission(auth.user.role, auth.user.id, mission)) return Response.json({ error: "اجازه حذف این مأموریت را ندارید." }, { status: 403 });
  if (mission.status !== "open") return Response.json({ error: "پس از شروع مأموریت، حذف آن امکان‌پذیر نیست." }, { status: 409 });

  const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'mission.deleted', 'mission', ?, ?, ?)").bind(crypto.randomUUID(), auth.user.id, id, JSON.stringify({ title: mission.title, assignedTo: mission.assignedTo }), now),
    db.prepare("DELETE FROM missions WHERE id = ? AND status = 'open'").bind(id),
  ]);
  return Response.json({ deleted: true, id });
}
