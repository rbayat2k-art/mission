import { ensureDatabase } from "../../../../../db/runtime";
import { requireRole } from "../../../../../lib/auth";
import { createUserNotification } from "../../../../../lib/push-notifications";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor"]);
  if ("error" in auth) return auth.error;
  const { id } = await context.params;
  const body = await request.json().catch(() => ({})) as { decision?: "approved" | "rejected" | "revision"; reason?: string };
  if (!body.decision || !["approved", "rejected", "revision"].includes(body.decision)) return Response.json({ error: "تصمیم نامعتبر است." }, { status: 400 });
  if (body.decision !== "approved" && !body.reason?.trim()) return Response.json({ error: "علت رد یا اصلاح الزامی است." }, { status: 400 });
  const db = await ensureDatabase();
  const approval = await db.prepare("SELECT a.id, a.mission_id AS missionId, a.status, m.status AS missionStatus, m.title AS missionTitle, m.assigned_to AS assignedTo, u.supervisor_id AS employeeSupervisorId FROM approvals a JOIN missions m ON m.id = a.mission_id JOIN users u ON u.id = m.assigned_to WHERE a.id = ?").bind(id).first<{ id: string; missionId: string; status: string; missionStatus: string; missionTitle:string; assignedTo:string; employeeSupervisorId: string | null }>();
  if (!approval) return Response.json({ error: "درخواست تأیید پیدا نشد." }, { status: 404 });
  if (auth.user.role === "supervisor" && approval.employeeSupervisorId !== auth.user.id) return Response.json({ error: "forbidden" }, { status: 403 });
  if (approval.status !== "pending") return Response.json({ error: "این درخواست قبلاً بررسی شده است." }, { status: 409 });
  const now = new Date().toISOString();
  const missionStatus = body.decision === "approved" && approval.missionStatus === "follow_up_pending" ? "follow_up" : body.decision;
  const scoreSql = body.decision === "approved" ? "score_confirmed = score_pending, score_pending = 0" : "score_pending = 0";
  await db.batch([
    db.prepare("UPDATE approvals SET status = ?, supervisor_id = ?, reason = ?, decided_at = ? WHERE id = ? AND status = 'pending'").bind(body.decision, auth.user.id, body.reason?.trim() ?? null, now, id),
    db.prepare(`UPDATE missions SET status = ?, ${scoreSql} WHERE id = ?`).bind(missionStatus, approval.missionId),
    db.prepare("UPDATE mission_attempts SET approval_status = ? WHERE mission_id = ? ORDER BY attempt_no DESC LIMIT 1").bind(body.decision, approval.missionId),
    db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'approval.decided', 'approval', ?, ?, ?)").bind(crypto.randomUUID(), auth.user.id, id, JSON.stringify({ decision: body.decision, reason: body.reason ?? null }), now),
  ]);
  await createUserNotification(approval.assignedTo, {
    type: `approval_${body.decision}`,
    title: body.decision === "approved" ? "مأموریت تأیید شد" : body.decision === "revision" ? "مأموریت برای اصلاح برگشت" : "مأموریت رد شد",
    message: `نتیجه بررسی مأموریت «${approval.missionTitle}» ثبت شد.${body.reason ? ` علت: ${body.reason.trim()}` : ""}`,
    entityType: "mission",
    entityId: approval.missionId,
    url: "/?panel=employee&screen=missions",
  });
  return Response.json({ approval: { id, missionId: approval.missionId, status: body.decision, missionStatus, decidedAt: now } });
}
