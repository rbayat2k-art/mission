import { ensureDatabase } from "../../../../../db/runtime";
import { requireRole } from "../../../../../lib/auth";
import { createUserNotification } from "../../../../../lib/push-notifications";
import { prepareMissionStatusEvent } from "../../../../../lib/mission-status-events";
import { pushScoreLedgerEntry, scoreDelta } from "../../../../../lib/score-ledger";

class TransitionConflict extends Error {}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor"]);
  if ("error" in auth) return auth.error;
  const { id } = await context.params;
  const body = await request.json().catch(() => ({})) as { decision?: "approved" | "rejected" | "revision"; reason?: string };
  if (!body.decision || !["approved", "rejected", "revision"].includes(body.decision)) return Response.json({ error: "تصمیم نامعتبر است." }, { status: 400 });
  if (body.decision !== "approved" && !body.reason?.trim()) return Response.json({ error: "علت رد یا اصلاح الزامی است." }, { status: 400 });
  const db = await ensureDatabase();
  const now = new Date().toISOString();
  let outcome;
  try {
    outcome = await db.transaction(async (transaction) => {
      const approval = await transaction.prepare(`SELECT a.id, a.mission_id AS missionId, a.status, m.status AS missionStatus,
        m.title AS missionTitle, m.assigned_to AS assignedTo, m.score_pending AS scorePending,
        m.score_confirmed AS scoreConfirmed, u.supervisor_id AS employeeSupervisorId,
        (SELECT ma.id FROM mission_attempts ma WHERE ma.mission_id=m.id ORDER BY ma.attempt_no DESC LIMIT 1) AS attemptId
        FROM approvals a JOIN missions m ON m.id = a.mission_id JOIN users u ON u.id = m.assigned_to WHERE a.id = ? FOR UPDATE`)
        .bind(id).first<{ id:string; missionId:string; status:string; missionStatus:string; missionTitle:string; assignedTo:string;
          scorePending:number; scoreConfirmed:number; employeeSupervisorId:string|null; attemptId:string|null }>();
      if (!approval) return { ok:false as const, status:404, error:"درخواست تأیید پیدا نشد." };
      if (auth.user.role === "supervisor" && approval.employeeSupervisorId !== auth.user.id) return { ok:false as const, status:403, error:"forbidden" };
      if (approval.status !== "pending") return { ok:false as const, status:409, error:"این درخواست قبلاً بررسی شده است." };
      const missionStatus = body.decision === "approved" && approval.missionStatus === "follow_up_pending" ? "follow_up" : body.decision;
      const scoreSql = body.decision === "approved" ? "score_confirmed = score_pending, score_pending = 0" : "score_pending = 0";
      const statusEvent = prepareMissionStatusEvent(transaction, { missionId:approval.missionId, actorId:auth.user.id, actorRole:auth.user.role,
        eventType:"approval_decision", fromStatus:approval.missionStatus, toStatus:missionStatus, serverRecordedAt:now,
        metadata:{ decision:body.decision, reason:body.reason?.trim() ?? null, approvalId:id } });
      const statements = [
        transaction.prepare("UPDATE approvals SET status = ?, supervisor_id = ?, reason = ?, decided_at = ? WHERE id = ? AND status = 'pending'").bind(body.decision, auth.user.id, body.reason?.trim() ?? null, now, id),
        transaction.prepare(`UPDATE missions SET status = ?, ${scoreSql} WHERE id = ? AND status = ?`).bind(missionStatus, approval.missionId, approval.missionStatus),
        transaction.prepare("UPDATE mission_attempts SET approval_status = ? WHERE mission_id = ? ORDER BY attempt_no DESC LIMIT 1").bind(body.decision, approval.missionId),
        transaction.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'approval.decided', 'approval', ?, ?, ?)").bind(crypto.randomUUID(), auth.user.id, id, JSON.stringify({ decision: body.decision, reason: body.reason ?? null }), now),
        statusEvent.statement,
      ];
      const nextPending = 0;
      const nextConfirmed = body.decision === "approved" ? Number(approval.scorePending ?? 0) : Number(approval.scoreConfirmed ?? 0);
      pushScoreLedgerEntry(statements, transaction, { userId:approval.assignedTo, missionId:approval.missionId, attemptId:approval.attemptId,
        actorId:auth.user.id, pointsDelta:scoreDelta(Number(approval.scorePending ?? 0), nextPending), bucket:"pending",
        reasonCode:`approval_${body.decision}`, source:"approval_decision", sourceEventId:id, occurredAt:now });
      pushScoreLedgerEntry(statements, transaction, { userId:approval.assignedTo, missionId:approval.missionId, attemptId:approval.attemptId,
        actorId:auth.user.id, pointsDelta:scoreDelta(Number(approval.scoreConfirmed ?? 0), nextConfirmed), bucket:"confirmed",
        reasonCode:`approval_${body.decision}`, source:"approval_decision", sourceEventId:id, occurredAt:now });
      const results = await transaction.batch(statements);
      if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) throw new TransitionConflict();
      return { ok:true as const, approval, missionStatus };
    });
  } catch (error) {
    if (error instanceof TransitionConflict) return Response.json({ error:"وضعیت درخواست هم‌زمان تغییر کرده است؛ صفحه را تازه کنید." }, { status:409 });
    throw error;
  }
  if (!outcome.ok) return Response.json({ error:outcome.error }, { status:outcome.status });
  const { approval, missionStatus } = outcome;
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
