import { ensureDatabase } from "../../../../../db/runtime";
import { requireRole } from "../../../../../lib/auth";
import { MAX_CONCURRENT_MISSIONS, missionStartCancellationState } from "../../../../../lib/mission-start-policy";
import { locationSqlValues, parseMissionLocation } from "../../../../../lib/mission-location";
import { enrichMissionStatusEventLocation, prepareMissionStatusEvent } from "../../../../../lib/mission-status-events";

type MissionRow = {
  id: string;
  source: string;
  assignedTo: string;
  status: string;
  startedAt: string | null;
  destinationName: string | null;
  workflowType: string;
  currentStepNo: number;
};

type StartOutcome =
  | { kind: "started"; startedAt: string; activeCount: number; eventId: string }
  | { kind: "existing"; startedAt: string | null }
  | { kind: "error"; status: number; error: string };

function errorOutcome(status: number, error: string): StartOutcome {
  return { kind: "error", status, error };
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor", "employee"]);
  if ("error" in auth) return auth.error;
  const { id } = await context.params;
  const db = await ensureDatabase();
  const existingMission = await db.prepare("SELECT id, source, assigned_to AS assignedTo, status, started_at AS startedAt, destination_name AS destinationName, workflow_type AS workflowType, current_step_no AS currentStepNo FROM missions WHERE id = ?")
    .bind(id).first<MissionRow>();
  if (!existingMission) return Response.json({ error: "مأموریت پیدا نشد." }, { status: 404 });
  if (existingMission.assignedTo !== auth.user.id) return Response.json({ error: "فقط مسئول مأموریت می‌تواند آن را شروع کند." }, { status: 403 });
  if (existingMission.status === "in_progress") return Response.json({ mission: { id, status: "in_progress", startedAt: existingMission.startedAt } });

  const body = await request.json().catch(() => ({})) as { location?: unknown };
  const existingStep = existingMission.workflowType === "multi_stage"
    ? await db.prepare("SELECT id, step_no AS stepNo, title, requires_location AS requiresLocation, status FROM mission_steps WHERE mission_id=? AND step_no=?").bind(id, existingMission.currentStepNo).first<{ id:string; stepNo:number; title:string; requiresLocation:number; status:string }>()
    : null;
  if (existingMission.workflowType === "multi_stage" && !existingStep) return Response.json({ error: "مرحله فعال مأموریت پیدا نشد." }, { status: 409 });
  const startLocation = parseMissionLocation(body.location);
  if ((!existingStep || Boolean(existingStep.requiresLocation)) && !startLocation) return Response.json({ error: "برای شروع این مرحله، موقعیت GPS معتبر لازم است." }, { status: 400 });
  const [latitudeE6, longitudeE6, accuracyCm, locationRecordedAt] = startLocation ? locationSqlValues(startLocation) : [null, null, null, null];

  const outcome = await db.transaction<StartOutcome>(async (transaction) => {
    await transaction.prepare("SELECT id FROM users WHERE id = ? FOR UPDATE").bind(auth.user.id).first();
    const mission = await transaction.prepare("SELECT id, source, assigned_to AS assignedTo, status, started_at AS startedAt, destination_name AS destinationName, workflow_type AS workflowType, current_step_no AS currentStepNo FROM missions WHERE id = ? FOR UPDATE")
      .bind(id).first<MissionRow>();
    if (!mission) return errorOutcome(404, "مأموریت پیدا نشد.");
    if (mission.assignedTo !== auth.user.id) return errorOutcome(403, "فقط مسئول مأموریت می‌تواند آن را شروع کند.");
    if (mission.status === "in_progress") return { kind: "existing", startedAt: mission.startedAt };

    const activeSession = await transaction.prepare("SELECT id FROM work_sessions WHERE user_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1")
      .bind(auth.user.id).first<{ id:string }>();
    if (!activeSession) return errorOutcome(409, "برای شروع کار روی مأموریت، ابتدا فعالیت روزانه را شروع کنید.");
    if (!["open", "follow_up", "revision", "stage_waiting"].includes(mission.status)) {
      return errorOutcome(409, mission.status === "follow_up_pending"
        ? "گزارش مراجعه قبلی ابتدا باید توسط سرپرست بررسی شود."
        : "این مأموریت دیگر قابل شروع نیست.");
    }

    const followUpRequest = mission.status === "follow_up"
      ? await transaction.prepare("SELECT id, status FROM mission_follow_up_requests WHERE mission_id = ? ORDER BY created_at DESC LIMIT 1")
        .bind(id).first<{ id: string; status: string }>()
      : null;
    if (followUpRequest && ["awaiting_supervisor", "awaiting_employee", "escalated"].includes(followUpRequest.status)) {
      return errorOutcome(409, "این مأموریت هنوز در انتظار اقدام یا پاسخ است و برای شروع مجدد آماده نشده است.");
    }

    const active = await transaction.prepare("SELECT COUNT(*) AS count FROM missions WHERE assigned_to = ? AND status = 'in_progress'")
      .bind(auth.user.id).first<{ count: number }>();
    const activeCount = Number(active?.count ?? 0);
    if (activeCount >= MAX_CONCURRENT_MISSIONS) {
      return errorOutcome(409, `شما ${MAX_CONCURRENT_MISSIONS.toLocaleString("fa-IR")} مأموریت در حال انجام دارید؛ ابتدا یکی را تعیین‌تکلیف کنید.`);
    }

    const now = new Date().toISOString();
    if (mission.workflowType === "multi_stage") {
      const step = await transaction.prepare("SELECT id, step_no AS stepNo, title, requires_location AS requiresLocation, status FROM mission_steps WHERE mission_id=? AND step_no=? FOR UPDATE")
        .bind(id, mission.currentStepNo).first<{ id:string; stepNo:number; title:string; requiresLocation:number; status:string }>();
      if (!step) return errorOutcome(409, "مرحله فعال مأموریت پیدا نشد.");
      if (!["open", "waiting", "follow_up"].includes(step.status)) return errorOutcome(409, "این مرحله اکنون قابل شروع نیست.");
      await transaction.prepare(`UPDATE missions SET status='in_progress', started_at=COALESCE(started_at, ?),
        start_latitude_e6=COALESCE(start_latitude_e6, ?), start_longitude_e6=COALESCE(start_longitude_e6, ?),
        start_accuracy_cm=COALESCE(start_accuracy_cm, ?), start_location_recorded_at=COALESCE(start_location_recorded_at, ?), completed_at=NULL WHERE id=?`)
        .bind(now, latitudeE6, longitudeE6, accuracyCm, locationRecordedAt, id).run();
      await transaction.prepare(`UPDATE mission_steps SET status='in_progress', started_at=COALESCE(started_at, ?),
        start_latitude_e6=COALESCE(start_latitude_e6, ?), start_longitude_e6=COALESCE(start_longitude_e6, ?),
        start_accuracy_cm=COALESCE(start_accuracy_cm, ?), start_location_recorded_at=COALESCE(start_location_recorded_at, ?), updated_at=? WHERE id=?`)
        .bind(now, latitudeE6, longitudeE6, accuracyCm, locationRecordedAt, now, step.id).run();
      await transaction.prepare(`INSERT INTO mission_step_segments (id, mission_id, mission_step_id, user_id, work_session_id, started_at,
        start_latitude_e6, start_longitude_e6, start_accuracy_cm, start_location_recorded_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), id, step.id, auth.user.id, activeSession.id, now, latitudeE6, longitudeE6, accuracyCm, locationRecordedAt, now).run();
      await transaction.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'mission.step_started', 'mission', ?, ?, ?)")
        .bind(crypto.randomUUID(), auth.user.id, id, JSON.stringify({ stepNo:step.stepNo, stepTitle:step.title, locationRecordedAt }), now).run();
      const statusEvent = prepareMissionStatusEvent(transaction, { missionId:id, actorId:auth.user.id, actorRole:auth.user.role,
        eventType:"started", fromStatus:mission.status, toStatus:"in_progress", serverRecordedAt:now, location:startLocation,
        metadata:{ stepNo:step.stepNo, stepId:step.id, stepTitle:step.title } });
      await statusEvent.statement.run();
      return { kind:"started", startedAt:now, activeCount:activeCount + 1, eventId:statusEvent.id };
    }
    await transaction.prepare(`UPDATE missions SET status = 'in_progress', destination_name = NULL, expense_amount = 0,
      score_pending = 0, score_confirmed = 0, score_penalty = 0, score_note = NULL, completed_at = NULL,
      end_latitude_e6 = NULL, end_longitude_e6 = NULL, end_accuracy_cm = NULL, end_location_recorded_at = NULL,
      started_at = ?, start_latitude_e6 = ?, start_longitude_e6 = ?, start_accuracy_cm = ?, start_location_recorded_at = ?
      WHERE id = ? AND status IN ('open', 'follow_up', 'revision')`)
      .bind(now, latitudeE6, longitudeE6, accuracyCm, locationRecordedAt, id).run();
    await transaction.prepare("DELETE FROM mission_destinations WHERE mission_id = ?").bind(id).run();
    await transaction.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, 'mission', ?, ?, ?)")
      .bind(crypto.randomUUID(), auth.user.id, mission.status === "follow_up" ? "mission.follow_up_started" : "mission.started", id,
        JSON.stringify({ previousStatus: mission.status, previousDestinationName: mission.destinationName, locationRecordedAt, accuracy: Math.round(startLocation!.accuracy) }), now).run();
    const statusEvent = prepareMissionStatusEvent(transaction, { missionId:id, actorId:auth.user.id, actorRole:auth.user.role,
      eventType:"started", fromStatus:mission.status, toStatus:"in_progress", serverRecordedAt:now, location:startLocation! });
    await statusEvent.statement.run();
    if (followUpRequest?.status === "ready_for_employee") {
      await transaction.prepare("UPDATE mission_follow_up_requests SET status='resolved', resolution_note='پیگیری مجدد توسط کارمند آغاز شد', resolved_at=?, updated_at=? WHERE id=?")
        .bind(now, now, followUpRequest.id).run();
    }
    return { kind: "started", startedAt: now, activeCount: activeCount + 1, eventId:statusEvent.id };
  });

  if (outcome.kind === "error") return Response.json({ error: outcome.error }, { status: outcome.status });
  if (outcome.kind === "existing") return Response.json({ mission: { id, status: "in_progress", startedAt: outcome.startedAt } });
  if (startLocation) void enrichMissionStatusEventLocation(outcome.eventId, startLocation);
  return Response.json({
    mission: { id, status: "in_progress", startedAt: outcome.startedAt, startLocation },
    activeMissionCount: outcome.activeCount,
    activeMissionLimit: MAX_CONCURRENT_MISSIONS,
  });
}

type CancelOutcome =
  | { kind: "cancelled"; restoredStatus: "open" | "follow_up" | "revision" | "stage_waiting"; cancelledAt: string; eventId: string | null }
  | { kind: "error"; status: number; error: string };

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor", "employee"]);
  if ("error" in auth) return auth.error;
  const { id } = await context.params;
  const body = await request.json().catch(() => ({})) as { reason?: string; location?: unknown };
  const reason = body.reason?.trim() ?? "";
  const cancellationLocation = parseMissionLocation(body.location);
  if (reason.length < 3 || reason.length > 500) {
    return Response.json({ error: "علت انصراف را بین ۳ تا ۵۰۰ نویسه ثبت کنید." }, { status: 400 });
  }

  const db = await ensureDatabase();
  const outcome = await db.transaction<CancelOutcome>(async (transaction) => {
    await transaction.prepare("SELECT id FROM users WHERE id = ? FOR UPDATE").bind(auth.user.id).first();
    const mission = await transaction.prepare("SELECT id, assigned_to AS assignedTo, status, started_at AS startedAt, workflow_type AS workflowType, current_step_no AS currentStepNo FROM missions WHERE id = ? FOR UPDATE")
      .bind(id).first<{ id: string; assignedTo: string; status: string; startedAt: string | null; workflowType:string; currentStepNo:number }>();
    if (!mission) return { kind: "error", status: 404, error: "مأموریت پیدا نشد." };
    if (mission.assignedTo !== auth.user.id) return { kind: "error", status: 403, error: "فقط مسئول مأموریت می‌تواند از شروع آن انصراف دهد." };
    if (mission.status !== "in_progress" || !mission.startedAt) {
      return { kind: "error", status: 409, error: "این مأموریت در وضعیت در حال انجام نیست." };
    }

    if (mission.workflowType === "multi_stage") {
      const step = await transaction.prepare("SELECT id, step_no AS stepNo, status FROM mission_steps WHERE mission_id=? AND step_no=? FOR UPDATE")
        .bind(id, mission.currentStepNo).first<{ id:string; stepNo:number; status:string }>();
      const segment = step ? await transaction.prepare("SELECT id, started_at AS startedAt FROM mission_step_segments WHERE mission_step_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1 FOR UPDATE")
        .bind(step.id).first<{ id:string; startedAt:string }>() : null;
      if (!step || !segment || step.status !== "in_progress") return { kind:"error", status:409, error:"این مرحله اکنون قابل انصراف نیست." };
      const stepCancellation = missionStartCancellationState(segment.startedAt);
      if (!stepCancellation.allowed) return { kind:"error", status:409, error:"مهلت ۵ دقیقه‌ای انصراف از شروع این مرحله تمام شده است." };
      const cancelledAt = new Date().toISOString();
      const restoredStatus = step.stepNo === 1 ? "open" : "stage_waiting";
      await transaction.prepare("DELETE FROM mission_step_segments WHERE id=?").bind(segment.id).run();
      await transaction.prepare("UPDATE mission_steps SET status=?, updated_at=? WHERE id=?").bind(step.stepNo === 1 ? "open" : "waiting", cancelledAt, step.id).run();
      await transaction.prepare("UPDATE missions SET status=? WHERE id=?").bind(restoredStatus, id).run();
      await transaction.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'mission.start_cancelled', 'mission', ?, ?, ?)")
        .bind(crypto.randomUUID(), auth.user.id, id, JSON.stringify({ reason, stepNo:step.stepNo, segmentStartedAt:segment.startedAt, elapsedSeconds:Math.round(stepCancellation.elapsedMs/1000) }), cancelledAt).run();
      const statusEvent = prepareMissionStatusEvent(transaction, { missionId:id, actorId:auth.user.id, actorRole:auth.user.role,
        eventType:"start_cancelled", fromStatus:"in_progress", toStatus:restoredStatus, serverRecordedAt:cancelledAt,
        location:cancellationLocation, metadata:{ reason, stepNo:step.stepNo, stepId:step.id } });
      await statusEvent.statement.run();
      return { kind:"cancelled", restoredStatus, cancelledAt, eventId:statusEvent.id };
    }

    const cancellation = missionStartCancellationState(mission.startedAt);
    if (!cancellation.allowed) {
      return { kind: "error", status: 409, error: "مهلت ۵ دقیقه‌ای انصراف از شروع این مأموریت تمام شده است." };
    }
    const destination = await transaction.prepare("SELECT id FROM mission_destinations WHERE mission_id = ? LIMIT 1").bind(id).first();
    if (destination) return { kind: "error", status: 409, error: "پس از ثبت مقصد، انصراف از شروع مأموریت امکان‌پذیر نیست." };

    const startAudit = await transaction.prepare(`SELECT action, details FROM audit_logs
      WHERE entity_type = 'mission' AND entity_id = ? AND action IN ('mission.started', 'mission.follow_up_started')
      ORDER BY created_at DESC LIMIT 1`).bind(id).first<{ action: string; details: string }>();
    let previousStatus = startAudit?.action === "mission.follow_up_started" ? "follow_up" : "open";
    let previousDestinationName: string | null = null;
    try {
      const details = JSON.parse(startAudit?.details ?? "{}") as { previousStatus?: string; previousDestinationName?: unknown };
      if (["open", "follow_up", "revision"].includes(details.previousStatus ?? "")) previousStatus = details.previousStatus!;
      if (typeof details.previousDestinationName === "string") previousDestinationName = details.previousDestinationName;
    } catch { /* Audit data is best-effort; open is the safe fallback. */ }
    const restoredStatus = previousStatus as "open" | "follow_up" | "revision";
    const cancelledAt = new Date().toISOString();
    await transaction.prepare(`UPDATE missions SET status = ?, destination_name = ?, started_at = NULL, start_latitude_e6 = NULL,
      start_longitude_e6 = NULL, start_accuracy_cm = NULL, start_location_recorded_at = NULL WHERE id = ?`)
      .bind(restoredStatus, previousDestinationName, id).run();
    await transaction.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'mission.start_cancelled', 'mission', ?, ?, ?)")
      .bind(crypto.randomUUID(), auth.user.id, id, JSON.stringify({ reason, startedAt: mission.startedAt, elapsedSeconds: Math.round(cancellation.elapsedMs / 1000), restoredStatus }), cancelledAt).run();
    const statusEvent = prepareMissionStatusEvent(transaction, { missionId:id, actorId:auth.user.id, actorRole:auth.user.role,
      eventType:"start_cancelled", fromStatus:"in_progress", toStatus:restoredStatus, serverRecordedAt:cancelledAt,
      location:cancellationLocation, metadata:{ reason } });
    await statusEvent.statement.run();
    return { kind: "cancelled", restoredStatus, cancelledAt, eventId:statusEvent.id };
  });

  if (outcome.kind === "error") return Response.json({ error: outcome.error }, { status: outcome.status });
  if (outcome.eventId && cancellationLocation) void enrichMissionStatusEventLocation(outcome.eventId, cancellationLocation);
  return Response.json({ mission: { id, status: outcome.restoredStatus, startedAt: null }, cancelledAt: outcome.cancelledAt });
}
