import { ensureDatabase } from "../../../db/runtime";
import { requireRole } from "../../../lib/auth";
import { normalizeFollowUpCategory } from "../../../lib/follow-up";
import { createUserNotification } from "../../../lib/push-notifications";

const selectRequests = `SELECT r.id, r.mission_id AS missionId, r.attempt_no AS attemptNo, r.category,
  r.request_text AS requestText, r.status, r.resolution_note AS resolutionNote, r.created_at AS createdAt,
  r.updated_at AS updatedAt, r.resolved_at AS resolvedAt, r.created_by AS createdBy,
  r.supervisor_id AS supervisorId, r.assigned_to AS assignedTo, m.title AS missionTitle,
  m.status AS missionStatus, m.assigned_to AS employeeId, u.full_name AS employeeName,
  s.full_name AS supervisorName, a.full_name AS assignedToName,
  (SELECT COUNT(*) FROM mission_follow_up_messages fm WHERE fm.request_id = r.id) AS messageCount
  FROM mission_follow_up_requests r
  JOIN missions m ON m.id = r.mission_id
  JOIN users u ON u.id = m.assigned_to
  JOIN users s ON s.id = r.supervisor_id
  JOIN users a ON a.id = r.assigned_to`;

export async function GET(request: Request) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor", "employee"]);
  if ("error" in auth) return auth.error;
  const db = await ensureDatabase();
  const missionId = new URL(request.url).searchParams.get("missionId");
  const missionClause = missionId ? " AND r.mission_id = ?" : "";
  const roleClause = auth.user.role === "employee" ? "m.assigned_to = ?" : auth.user.role === "supervisor" ? "(r.supervisor_id = ? OR r.assigned_to = ?)" : "1 = 1";
  const values = auth.user.role === "employee" ? [auth.user.id] : auth.user.role === "supervisor" ? [auth.user.id, auth.user.id] : [];
  if (missionId) values.push(missionId);
  const result = await db.prepare(`${selectRequests} WHERE ${roleClause}${missionClause} ORDER BY r.updated_at DESC`).bind(...values).all();
  return Response.json({ requests: result.results });
}

export async function POST(request: Request) {
  const auth = await requireRole(request, ["employee"]);
  if ("error" in auth) return auth.error;
  const body = await request.json().catch(() => ({})) as { missionId?: string; category?: string; requestText?: string };
  const missionId = body.missionId?.trim() ?? "";
  const requestText = body.requestText?.trim() ?? "";
  if (!missionId || requestText.length < 3) return Response.json({ error: "مأموریت و توضیح درخواست الزامی است." }, { status: 400 });
  const db = await ensureDatabase();
  const mission = await db.prepare(`SELECT m.id, m.title, m.status, m.assigned_to AS assignedTo,
    u.supervisor_id AS supervisorId, s.status AS supervisorStatus
    FROM missions m JOIN users u ON u.id = m.assigned_to
    LEFT JOIN users s ON s.id = u.supervisor_id WHERE m.id = ?`).bind(missionId).first<{
      id:string; title:string; status:string; assignedTo:string; supervisorId:string|null; supervisorStatus:string|null;
    }>();
  if (!mission || mission.assignedTo !== auth.user.id) return Response.json({ error: "مأموریت پیدا نشد." }, { status: 404 });
  if (!mission.supervisorId || mission.supervisorStatus !== "active") return Response.json({ error: "برای حساب شما سرپرست فعالی تعیین نشده است." }, { status: 409 });
  if (!["follow_up", "follow_up_pending", "revision"].includes(mission.status)) return Response.json({ error: "این مأموریت در وضعیت پیگیری مجدد نیست." }, { status: 409 });
  const active = await db.prepare("SELECT id FROM mission_follow_up_requests WHERE mission_id = ? AND status IN ('awaiting_supervisor','awaiting_employee','escalated','ready_for_employee') ORDER BY created_at DESC LIMIT 1").bind(missionId).first();
  if (active) return Response.json({ error: "برای این مأموریت یک درخواست پیگیری باز وجود دارد." }, { status: 409 });
  const id = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const now = new Date().toISOString();
  const category = normalizeFollowUpCategory(body.category);
  await db.batch([
    db.prepare("INSERT INTO mission_follow_up_requests (id, mission_id, created_by, supervisor_id, assigned_to, category, request_text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_supervisor', ?, ?)").bind(id, missionId, auth.user.id, mission.supervisorId, mission.supervisorId, category, requestText, now, now),
    db.prepare("INSERT INTO mission_follow_up_messages (id, request_id, sender_id, message_type, body, created_at) VALUES (?, ?, ?, 'text', ?, ?)").bind(messageId, id, auth.user.id, requestText, now),
    db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'follow_up.created', 'follow_up_request', ?, ?, ?)").bind(crypto.randomUUID(), auth.user.id, id, JSON.stringify({ missionId, category }), now),
  ]);
  await createUserNotification(mission.supervisorId, { type:"follow_up_created", title:"درخواست اقدام جدید", message:`برای مأموریت «${mission.title}» درخواست پیگیری ثبت شد.`, entityType:"follow_up_request", entityId:id, url:"/?panel=admin&screen=actions" });
  return Response.json({ request: { id, missionId, category, requestText, status:"awaiting_supervisor", assignedTo:mission.supervisorId, createdAt:now, updatedAt:now } }, { status:201 });
}
