import { ensureDatabase } from "../../../../../db/runtime";
import { requireRole } from "../../../../../lib/auth";
import { locationSqlValues, parseMissionLocation } from "../../../../../lib/mission-location";
import { normalizeFollowUpCategory } from "../../../../../lib/follow-up";
import { createUserNotification } from "../../../../../lib/push-notifications";
import { enrichMissionStatusEventLocation, prepareMissionStatusEvent } from "../../../../../lib/mission-status-events";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor", "employee"]);
  if ("error" in auth) return auth.error;
  const { id } = await context.params;
  const db = await ensureDatabase();
  const mission = await db.prepare(`SELECT m.id, m.source, m.assigned_to AS assignedTo, m.status, m.started_at AS startedAt,
    m.score_penalty AS scorePenalty, m.start_latitude_e6 AS startLatitudeE6, m.start_longitude_e6 AS startLongitudeE6,
    m.start_accuracy_cm AS startAccuracyCm, m.start_location_recorded_at AS startLocationRecordedAt,
    u.supervisor_id AS supervisorId, s.status AS supervisorStatus, m.title
    FROM missions m JOIN users u ON u.id = m.assigned_to LEFT JOIN users s ON s.id = u.supervisor_id WHERE m.id = ?`).bind(id).first<{
      id: string; source: string; assignedTo: string; status: string; startedAt: string | null; scorePenalty: number;
      startLatitudeE6: number | null; startLongitudeE6: number | null; startAccuracyCm: number | null; startLocationRecordedAt: string | null;
      supervisorId: string | null; supervisorStatus: string | null; title: string;
    }>();
  if (!mission) return Response.json({ error: "مأموریت پیدا نشد." }, { status: 404 });
  if (mission.assignedTo !== auth.user.id) return Response.json({ error: "فقط مسئول مأموریت می‌تواند نتیجه آن را ثبت کند." }, { status: 403 });
  const activeSession = auth.user.role === "employee"
    ? await db.prepare("SELECT id FROM work_sessions WHERE user_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1").bind(auth.user.id).first<{ id: string }>()
    : null;
  if (auth.user.role === "employee" && !activeSession) return Response.json({ error: "فعالیت روزانه پایان یافته است؛ برای ادامه مأموریت ابتدا فعالیت جدیدی شروع کنید." }, { status: 409 });
  if (!["open", "in_progress", "revision", "follow_up"].includes(mission.status)) return Response.json({ error: "این مأموریت قابل پایان نیست." }, { status: 409 });
  const registeredDestination = await db.prepare(`SELECT destination_name AS destinationName, latitude_e6 AS latitudeE6,
    longitude_e6 AS longitudeE6, accuracy_cm AS accuracyCm, recorded_at AS recordedAt
    FROM mission_destinations WHERE mission_id = ? AND user_id = ?`).bind(id, auth.user.id).first<{
      destinationName: string; latitudeE6: number; longitudeE6: number; accuracyCm: number; recordedAt: string;
    }>();
  if (!registeredDestination) return Response.json({ error: "ابتدا مقصد این مأموریت را با GPS ثبت کنید." }, { status: 409 });
  const body = await request.json().catch(() => ({})) as { destinationName?: string; result?: string; report?: string; expenseAmount?: number; endLocation?: unknown; requestSupervisorAction?: boolean; followUpCategory?: string };
  if (!body.result?.trim() || !body.report?.trim()) return Response.json({ error: "نتیجه و توضیح گزارش الزامی است." }, { status: 400 });
  const endLocation = parseMissionLocation(body.endLocation);
  if (!endLocation) return Response.json({ error: "برای پایان مأموریت، موقعیت GPS معتبر لازم است." }, { status: 400 });
  const [endLatitudeE6, endLongitudeE6, endAccuracyCm, endLocationRecordedAt] = locationSqlValues(endLocation);
  const allowedResults = ["انجام شد", "نیاز به پیگیری", "مسئول نبود", "تعطیل بود", "موکول شد", "سایر"];
  const workResult = body.result.trim();
  if (!allowedResults.includes(workResult)) return Response.json({ error: "نتیجه انتخاب‌شده معتبر نیست." }, { status: 400 });
  const now = new Date().toISOString();
  const rawExpenseAmount = Number(body.expenseAmount ?? 0);
  const expenseAmount = Number.isFinite(rawExpenseAmount) ? Math.max(0, Math.round(rawExpenseAmount)) : 0;
  const needsFollowUp = workResult !== "انجام شد";
  const requestSupervisorAction = needsFollowUp && body.requestSupervisorAction === true;
  const needsFinalApproval = mission.source === "employee" && !needsFollowUp;
  if (requestSupervisorAction && (!mission.supervisorId || mission.supervisorStatus !== "active")) return Response.json({ error: "برای ارجاع پیگیری، باید یک سرپرست فعال برای کارمند تعیین شده باشد." }, { status: 409 });
  const status = needsFollowUp ? "follow_up" : needsFinalApproval ? "pending" : "approved";
  const baseScore = 12;
  const completedWithoutStart = !mission.startedAt;
  const scorePenalty = completedWithoutStart ? 3 : 0;
  const awardedScore = Math.max(0, baseScore - scorePenalty);
  const scoreNote = completedWithoutStart ? "۳ امتیاز کسر شد؛ شروع کار روی مأموریت ثبت نشده بود." : null;
  const pendingScore = needsFinalApproval ? awardedScore : 0;
  const confirmedScore = needsFinalApproval ? 0 : awardedScore;
  const attempt = await db.prepare("SELECT COALESCE(MAX(attempt_no), 0) + 1 AS attemptNo FROM mission_attempts WHERE mission_id = ?")
    .bind(id).first<{ attemptNo: number }>();
  const attemptNo = Number(attempt?.attemptNo ?? 1);
  const followUpRequestId = requestSupervisorAction ? crypto.randomUUID() : null;
  const followUpMessageId = requestSupervisorAction ? crypto.randomUUID() : null;
  const statusEvent = prepareMissionStatusEvent(db, { missionId:id, attemptNo, actorId:auth.user.id, actorRole:auth.user.role,
    eventType:"status_set", fromStatus:mission.status, toStatus:status, result:workResult, serverRecordedAt:now,
    location:endLocation, metadata:{ report:body.report.trim(), requestSupervisorAction, destinationName:registeredDestination.destinationName } });
  const statements = [
    db.prepare("UPDATE missions SET status = ?, destination_name = ?, result = ?, report = ?, expense_amount = ?, score_pending = ?, score_confirmed = ?, score_penalty = ?, score_note = ?, completed_at = ?, end_latitude_e6 = ?, end_longitude_e6 = ?, end_accuracy_cm = ?, end_location_recorded_at = ? WHERE id = ?").bind(status, registeredDestination.destinationName, workResult, body.report.trim(), expenseAmount, pendingScore, confirmedScore, scorePenalty, scoreNote, now, endLatitudeE6, endLongitudeE6, endAccuracyCm, endLocationRecordedAt, id),
    db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'mission.completed', 'mission', ?, ?, ?)").bind(crypto.randomUUID(), auth.user.id, id, JSON.stringify({ status, baseScore, awardedScore, scorePenalty, scoreNote, completedWithoutStart, result: workResult, expenseAmount, requestSupervisorAction, endLocationRecordedAt, endAccuracy: Math.round(endLocation.accuracy) }), now),
    db.prepare(`INSERT INTO mission_attempts (
      id, mission_id, attempt_no, result, report, destination_name, expense_amount, score_awarded, score_penalty,
      started_at, completed_at, start_latitude_e6, start_longitude_e6, start_accuracy_cm, start_location_recorded_at,
      destination_latitude_e6, destination_longitude_e6, destination_accuracy_cm, destination_recorded_at,
      end_latitude_e6, end_longitude_e6, end_accuracy_cm, end_location_recorded_at, approval_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      crypto.randomUUID(), id, attemptNo, workResult, body.report.trim(), registeredDestination.destinationName, expenseAmount,
      awardedScore, scorePenalty, mission.startedAt, now, mission.startLatitudeE6, mission.startLongitudeE6,
      mission.startAccuracyCm, mission.startLocationRecordedAt, registeredDestination.latitudeE6,
      registeredDestination.longitudeE6, registeredDestination.accuracyCm, registeredDestination.recordedAt,
      endLatitudeE6, endLongitudeE6, endAccuracyCm, endLocationRecordedAt, needsFinalApproval ? "pending" : "not_required", now,
    ),
    statusEvent.statement,
  ];
  if (completedWithoutStart && Number(mission.scorePenalty ?? 0) === 0) {
    statements.push(db.prepare("INSERT INTO integrity_events (id, user_id, work_session_id, type, severity, status, details, occurred_at, created_at) VALUES (?, ?, ?, 'mission_completed_without_start', 'medium', 'open', ?, ?, ?)").bind(
      crypto.randomUUID(), auth.user.id, activeSession?.id ?? null, JSON.stringify({ missionId: id, baseScore, awardedScore, scorePenalty, reason: scoreNote }), now, now,
    ));
  }
  if (needsFinalApproval) statements.push(db.prepare("INSERT INTO approvals (id, mission_id, status, created_at) VALUES (?, ?, 'pending', ?) ON DUPLICATE KEY UPDATE status = 'pending', reason = NULL, decided_at = NULL").bind(crypto.randomUUID(), id, now));
  if (followUpRequestId && followUpMessageId && mission.supervisorId) {
    const category = normalizeFollowUpCategory(body.followUpCategory);
    statements.push(
      db.prepare("INSERT INTO mission_follow_up_requests (id, mission_id, attempt_no, created_by, supervisor_id, assigned_to, category, request_text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_supervisor', ?, ?)").bind(followUpRequestId, id, attemptNo, auth.user.id, mission.supervisorId, mission.supervisorId, category, body.report.trim(), now, now),
      db.prepare("INSERT INTO mission_follow_up_messages (id, request_id, sender_id, message_type, body, created_at) VALUES (?, ?, ?, 'text', ?, ?)").bind(followUpMessageId, followUpRequestId, auth.user.id, body.report.trim(), now),
      db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'follow_up.created', 'follow_up_request', ?, ?, ?)").bind(crypto.randomUUID(), auth.user.id, followUpRequestId, JSON.stringify({ missionId:id, attemptNo, category }), now),
    );
  }
  await db.batch(statements);
  void enrichMissionStatusEventLocation(statusEvent.id, endLocation);
  if (followUpRequestId && mission.supervisorId) await createUserNotification(mission.supervisorId, { type:"follow_up_created", title:"درخواست اقدام جدید", message:`برای مأموریت «${mission.title}» درخواست پیگیری ثبت شد.`, entityType:"follow_up_request", entityId:followUpRequestId, url:"/?panel=admin&screen=actions" });
  return Response.json({ mission: { id, status, attemptNo, needsFollowUp, requestSupervisorAction, followUpRequestId, scorePending: pendingScore, scoreConfirmed: confirmedScore, scorePenalty, scoreNote, completedWithoutStart, endLocation } });
}
