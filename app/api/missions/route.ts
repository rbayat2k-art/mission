import { ensureDatabase } from "../../../db/runtime";
import { requireRole } from "../../../lib/auth";
import { normalizeJalaliDeadline } from "../../../lib/mission-deadline";
import { createUserNotification } from "../../../lib/push-notifications";
import { prepareMissionStatusEvent } from "../../../lib/mission-status-events";

export async function GET(request: Request) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor", "employee"]);
  if ("error" in auth) return auth.error;
  const db = await ensureDatabase();
  const select = `SELECT m.id, m.title, m.description, m.source, m.status, m.priority, m.assigned_to AS assignedTo, m.referrer_name AS referrerName, m.destination_name AS destinationName, m.result, m.report, m.expense_amount AS expenseAmount, m.score_pending AS scorePending, m.score_confirmed AS scoreConfirmed, m.score_penalty AS scorePenalty, m.score_note AS scoreNote, m.deadline, m.deadline_at AS deadlineAt, m.started_at AS startedAt, m.completed_at AS completedAt, m.created_at AS createdAt, u.full_name AS employeeName,
    (SELECT COUNT(*) FROM mission_attempts ma WHERE ma.mission_id = m.id) AS attemptCount,
    (SELECT fr.status FROM mission_follow_up_requests fr WHERE fr.mission_id=m.id ORDER BY fr.created_at DESC LIMIT 1) AS followUpRequestStatus,
    (SELECT COUNT(*) FROM audit_logs al WHERE al.entity_type='mission' AND al.entity_id=m.id AND al.action='mission.start_cancelled') AS startCancellationCount,
    (SELECT JSON_UNQUOTE(JSON_EXTRACT(al.details, '$.reason')) FROM audit_logs al WHERE al.entity_type='mission' AND al.entity_id=m.id AND al.action='mission.start_cancelled' ORDER BY al.created_at DESC LIMIT 1) AS lastStartCancellationReason,
    (SELECT al.created_at FROM audit_logs al WHERE al.entity_type='mission' AND al.entity_id=m.id AND al.action='mission.start_cancelled' ORDER BY al.created_at DESC LIMIT 1) AS lastStartCancelledAt,
    (SELECT mse.event_type FROM mission_status_events mse WHERE mse.mission_id=m.id ORDER BY mse.server_recorded_at DESC, mse.id DESC LIMIT 1) AS latestStatusEventType,
    (SELECT mse.result FROM mission_status_events mse WHERE mse.mission_id=m.id ORDER BY mse.server_recorded_at DESC, mse.id DESC LIMIT 1) AS latestStatusResult,
    (SELECT mse.server_recorded_at FROM mission_status_events mse WHERE mse.mission_id=m.id ORDER BY mse.server_recorded_at DESC, mse.id DESC LIMIT 1) AS latestStatusChangedAt,
    (SELECT mse.location_label FROM mission_status_events mse WHERE mse.mission_id=m.id ORDER BY mse.server_recorded_at DESC, mse.id DESC LIMIT 1) AS latestStatusLocationLabel,
    (SELECT mse.accuracy_cm FROM mission_status_events mse WHERE mse.mission_id=m.id ORDER BY mse.server_recorded_at DESC, mse.id DESC LIMIT 1) AS latestStatusAccuracyCm
    FROM missions m JOIN users u ON u.id = m.assigned_to`;
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
  const body = await request.json().catch(() => ({})) as { title?: string; description?: string; priority?: string; deadline?: string | null; deadlineDate?: string | null; deadlineTime?: string | null; destinationName?: string | null; assignedTo?: string; referrerName?: string | null };
  const title = body.title?.trim() ?? "";
  if (!title) return Response.json({ error: "عنوان مأموریت الزامی است." }, { status: 400 });
  const requestedReferrerName = body.referrerName?.trim() ?? "";
  if (requestedReferrerName.length > 255) return Response.json({ error: "نام ارجاع‌دهنده کار نباید بیشتر از ۲۵۵ نویسه باشد." }, { status: 400 });
  const db = await ensureDatabase();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const source = auth.user.role === "employee" ? "employee" : "manager";
  const referrerName = source === "employee" ? requestedReferrerName || null : null;
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
  const createdEvent = prepareMissionStatusEvent(db, { missionId:id, actorId:auth.user.id, actorRole:auth.user.role, eventType:"created", toStatus:"open", serverRecordedAt:now, metadata:{ source, assignedTo } });
  await db.batch([
    db.prepare("INSERT INTO missions (id, title, description, source, status, priority, created_by, assigned_to, referrer_name, destination_name, deadline, deadline_at, created_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, title, body.description?.trim() ?? "", source, priority, auth.user.id, assignedTo, referrerName, body.destinationName?.trim() || null, deadline, deadlineAt, now),
    createdEvent.statement,
    db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'mission.created', 'mission', ?, ?, ?)").bind(crypto.randomUUID(), auth.user.id, id, JSON.stringify({ source, assignedTo, referrerName }), now),
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
  return Response.json({ mission: { id, title, description: body.description?.trim() ?? "", source, status: "open", priority, assignedTo, employeeName: assignee.fullName, referrerName, destinationName: body.destinationName?.trim() || null, deadline, deadlineAt, scorePending: 0, scoreConfirmed: 0, createdAt: now } }, { status: 201 });
}
