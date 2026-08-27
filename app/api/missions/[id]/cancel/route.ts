import { ensureDatabase } from "../../../../../db/runtime";
import { requireRole } from "../../../../../lib/auth";
import { createUserNotification } from "../../../../../lib/push-notifications";
import { prepareMissionStatusEvent } from "../../../../../lib/mission-status-events";
import { pushScoreLedgerEntry, scoreDelta } from "../../../../../lib/score-ledger";

class TransitionConflict extends Error {}

const cancellableStatuses = [
  "open",
  "in_progress",
  "stage_waiting",
  "follow_up",
  "follow_up_pending",
  "revision",
  "pending",
  "pending_approval",
];

type MissionRow = {
  id: string;
  title: string;
  status: string;
  assignedTo: string;
  createdBy: string;
  employeeName: string;
  assigneeSupervisorId: string | null;
  scorePending: number;
  attemptId: string | null;
};

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor"]);
  if ("error" in auth) return auth.error;

  const body = await request.json().catch(() => ({})) as { reason?: string };
  const reason = body.reason?.trim() ?? "";
  if (reason.length < 3) return Response.json({ error: "ثبت دلیل لغو مأموریت الزامی است." }, { status: 400 });
  if (reason.length > 1000) return Response.json({ error: "دلیل لغو نباید بیشتر از ۱۰۰۰ نویسه باشد." }, { status: 400 });

  const { id } = await context.params;
  const db = await ensureDatabase();
  const mission = await db.prepare(`SELECT m.id, m.title, m.status, m.assigned_to AS assignedTo, m.created_by AS createdBy,
    employee.full_name AS employeeName, employee.supervisor_id AS assigneeSupervisorId, m.score_pending AS scorePending,
    (SELECT ma.id FROM mission_attempts ma WHERE ma.mission_id=m.id ORDER BY ma.attempt_no DESC LIMIT 1) AS attemptId
    FROM missions m JOIN users employee ON employee.id=m.assigned_to WHERE m.id=?`).bind(id).first<MissionRow>();
  if (!mission) return Response.json({ error: "مأموریت پیدا نشد." }, { status: 404 });
  if (auth.user.role === "supervisor" && mission.assigneeSupervisorId !== auth.user.id && mission.createdBy !== auth.user.id) {
    return Response.json({ error: "سرپرست فقط می‌تواند مأموریت کارکنان زیرمجموعه خود را لغو کند." }, { status: 403 });
  }
  if (mission.status === "cancelled") return Response.json({ error: "این مأموریت قبلاً لغو شده است." }, { status: 409 });
  if (!cancellableStatuses.includes(mission.status)) {
    return Response.json({ error: "مأموریت تعیین‌تکلیف‌شده قابل لغو نیست؛ سابقه نهایی آن باید بدون تغییر باقی بماند." }, { status: 409 });
  }

  const now = new Date().toISOString();
  const statusEvent = prepareMissionStatusEvent(db, {
    missionId: mission.id,
    actorId: auth.user.id,
    actorRole: auth.user.role,
    eventType: "manager_cancelled",
    fromStatus: mission.status,
    toStatus: "cancelled",
    result: "لغو توسط مدیریت",
    serverRecordedAt: now,
    metadata: { reason, title: mission.title, employeeName: mission.employeeName },
  });

  const statements = [
    db.prepare(`UPDATE missions SET status='cancelled', cancelled_at=?, cancelled_by=?, cancellation_reason=?,
      score_pending=0 WHERE id=? AND status IN (${cancellableStatuses.map(() => "?").join(",")})`)
      .bind(now, auth.user.id, reason, mission.id, ...cancellableStatuses),
    db.prepare("UPDATE mission_steps SET status='cancelled', updated_at=? WHERE mission_id=? AND status NOT IN ('completed','approved','cancelled')")
      .bind(now, mission.id),
    db.prepare("UPDATE mission_step_segments SET ended_at=COALESCE(ended_at, ?), end_reason=COALESCE(end_reason, 'manager_cancelled') WHERE mission_id=? AND ended_at IS NULL")
      .bind(now, mission.id),
    db.prepare(`UPDATE mission_follow_up_requests SET status='cancelled', resolution_note=?, updated_at=?, resolved_at=?
      WHERE mission_id=? AND status IN ('awaiting_supervisor','awaiting_employee','escalated','ready_for_employee')`)
      .bind(reason, now, now, mission.id),
    db.prepare("UPDATE approvals SET status='cancelled', supervisor_id=?, reason=?, decided_at=? WHERE mission_id=? AND status='pending'")
      .bind(auth.user.id, reason, now, mission.id),
    statusEvent.statement,
    db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'mission.manager_cancelled', 'mission', ?, ?, ?)")
      .bind(crypto.randomUUID(), auth.user.id, mission.id, JSON.stringify({ reason, fromStatus: mission.status, assignedTo: mission.assignedTo }), now),
  ];
  pushScoreLedgerEntry(statements,db,{userId:mission.assignedTo,missionId:mission.id,attemptId:mission.attemptId,actorId:auth.user.id,
    pointsDelta:scoreDelta(Number(mission.scorePending??0),0),bucket:"pending",reasonCode:"manager_cancelled",
    source:"mission_cancel",sourceEventId:statusEvent.id,occurredAt:now,metadata:{reason}});
  try {
    await db.transaction(async transaction=>{
      const locked=await transaction.prepare("SELECT status, score_pending AS scorePending FROM missions WHERE id=? FOR UPDATE")
        .bind(mission.id).first<{status:string;scorePending:number}>();
      if(!locked||locked.status!==mission.status||Number(locked.scorePending)!==Number(mission.scorePending))throw new TransitionConflict();
      const results=await transaction.batch(statements);
      if((results[0]?.meta.changes??0)!==1)throw new TransitionConflict();
    });
  } catch(error) {
    if(error instanceof TransitionConflict)return Response.json({error:"وضعیت مأموریت هم‌زمان تغییر کرده است؛ صفحه را تازه کنید."},{status:409});
    throw error;
  }

  await createUserNotification(mission.assignedTo, {
    type: "mission_cancelled",
    title: "مأموریت لغو شد",
    message: `مأموریت «${mission.title}» توسط مدیریت لغو شد و دیگر نیاز به پیگیری ندارد. دلیل: ${reason}`,
    entityType: "mission",
    entityId: mission.id,
    url: "/?panel=employee&screen=missions",
  });

  return Response.json({ mission: { id: mission.id, status: "cancelled", cancelledAt: now, cancelledBy: auth.user.id, cancellationReason: reason } });
}
