import { ensureDatabase } from "../../../db/runtime";
import { requireRole } from "../../../lib/auth";
import { normalizeJalaliDeadline } from "../../../lib/mission-deadline";
import { createUserNotification } from "../../../lib/push-notifications";
import { prepareMissionStatusEvent } from "../../../lib/mission-status-events";
import { normalizeMissionSteps, type MissionStepInput } from "../../../lib/mission-steps";
import { normalizeMissionTasks, type MissionTaskInput } from "../../../lib/mission-tasks";
import { normalizeExecutionRank } from "../../../lib/mission-execution-rank";

export async function GET(request: Request) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor", "employee"]);
  if ("error" in auth) return auth.error;
  const db = await ensureDatabase();
  const select = `SELECT m.id, m.title, m.description, m.source, m.status, m.priority, m.execution_rank AS executionRank, m.execution_rank_version AS executionRankVersion, m.assigned_to AS assignedTo, m.workflow_type AS workflowType, m.current_step_no AS currentStepNo, m.referrer_name AS referrerName, m.destination_name AS destinationName, m.result, m.report, m.expense_amount AS expenseAmount, m.score_pending AS scorePending, m.score_confirmed AS scoreConfirmed, m.score_penalty AS scorePenalty, m.score_note AS scoreNote, m.deadline, m.deadline_at AS deadlineAt, m.started_at AS startedAt, (SELECT MAX(md.created_at) FROM mission_destinations md WHERE md.mission_id=m.id) AS destinationRegisteredAt, m.completed_at AS completedAt, m.cancelled_at AS cancelledAt, m.cancelled_by AS cancelledBy, m.cancellation_reason AS cancellationReason, canceller.full_name AS cancelledByName, m.created_at AS createdAt, u.full_name AS employeeName,
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
    FROM missions m JOIN users u ON u.id = m.assigned_to LEFT JOIN users canceller ON canceller.id=m.cancelled_by`;
  const result = auth.user.role === "employee"
    ? await db.prepare(`${select} WHERE m.assigned_to = ? ORDER BY m.created_at DESC`).bind(auth.user.id).all()
    : auth.user.role === "supervisor"
      ? await db.prepare(`${select} WHERE m.assigned_to IN (SELECT id FROM users WHERE supervisor_id = ?) OR m.created_by = ? ORDER BY m.created_at DESC`).bind(auth.user.id, auth.user.id).all()
      : await db.prepare(`${select} ORDER BY m.created_at DESC`).all();
  const missionIds = new Set(result.results.map((mission) => String((mission as { id: string }).id)));
  const stepRows = missionIds.size ? (await db.prepare(`SELECT id, mission_id AS missionId, step_no AS stepNo, title, action_type AS actionType,
    description, requires_location AS requiresLocation, destination_name AS destinationName, evidence_requirement AS evidenceRequirement,
    deadline, deadline_at AS deadlineAt, status, result, report, expense_amount AS expenseAmount, started_at AS startedAt,
    arrived_at AS arrivedAt, completed_at AS completedAt, start_latitude_e6 AS startLatitudeE6,
    start_longitude_e6 AS startLongitudeE6, start_accuracy_cm AS startAccuracyCm,
    destination_latitude_e6 AS destinationLatitudeE6, destination_longitude_e6 AS destinationLongitudeE6,
    destination_accuracy_cm AS destinationAccuracyCm, destination_recorded_at AS destinationRecordedAt,
    end_latitude_e6 AS endLatitudeE6, end_longitude_e6 AS endLongitudeE6, end_accuracy_cm AS endAccuracyCm
    FROM mission_steps ORDER BY mission_id, step_no`).all()).results.filter((step) => missionIds.has(String((step as { missionId: string }).missionId))) : [];
  const stepMap = new Map<string, unknown[]>();
  for (const step of stepRows) {
    const missionId = String((step as { missionId: string }).missionId);
    const values = stepMap.get(missionId) ?? [];
    values.push(step);
    stepMap.set(missionId, values);
  }
  const visibleMissionIds = [...missionIds];
  const taskRows = visibleMissionIds.length ? (await db.prepare(`SELECT id, mission_id AS missionId, task_no AS taskNo, title,
    description, status, result, report, version, completed_at AS completedAt, updated_at AS updatedAt, created_at AS createdAt
    FROM mission_tasks WHERE mission_id IN (${visibleMissionIds.map(() => "?").join(",")}) ORDER BY mission_id, task_no`)
    .bind(...visibleMissionIds).all()).results : [];
  const taskMap = new Map<string, unknown[]>();
  for (const task of taskRows) {
    const missionId = String((task as { missionId: string }).missionId);
    const values = taskMap.get(missionId) ?? [];
    values.push(task);
    taskMap.set(missionId, values);
  }
  return Response.json({ missions: result.results.map((mission) => ({
    ...mission,
    steps: stepMap.get(String((mission as { id: string }).id)) ?? [],
    tasks: taskMap.get(String((mission as { id: string }).id)) ?? [],
  })) });
}

export async function POST(request: Request) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor", "employee"]);
  if ("error" in auth) return auth.error;
  const body = await request.json().catch(() => ({})) as { title?: string; description?: string; priority?: string; executionRank?: unknown; deadline?: string | null; deadlineDate?: string | null; deadlineTime?: string | null; destinationName?: string | null; assignedTo?: string; referrerName?: string | null; workflowType?: string; steps?: MissionStepInput[]; tasks?: MissionTaskInput[] };
  if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({error:"اطلاعات مأموریت معتبر نیست."},{status:400});
  for (const key of ["title","description","priority","deadline","deadlineDate","deadlineTime","destinationName","assignedTo","referrerName","workflowType"] as const) {
    if (body[key] != null && typeof body[key] !== "string") return Response.json({error:"نوع اطلاعات مأموریت معتبر نیست."},{status:400});
  }
  const title = body.title?.trim() ?? "";
  if (!title) return Response.json({ error: "عنوان مأموریت الزامی است." }, { status: 400 });
  if (title.length > 255 || (body.description?.length ?? 0) > 4000 || (body.destinationName?.length ?? 0) > 255) return Response.json({error:"عنوان یا توضیحات مأموریت بیش از حد طولانی است."},{status:400});
  const requestedReferrerName = body.referrerName?.trim() ?? "";
  if (requestedReferrerName.length > 255) return Response.json({ error: "نام ارجاع‌دهنده کار نباید بیشتر از ۲۵۵ نویسه باشد." }, { status: 400 });
  const db = await ensureDatabase();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const source = auth.user.role === "employee" ? "employee" : "manager";
  const normalizedExecutionRank = source === "employee" ? { executionRank:null } : normalizeExecutionRank(body.executionRank ?? 5);
  if ("error" in normalizedExecutionRank) return Response.json({ error:normalizedExecutionRank.error }, { status:400 });
  const executionRank = normalizedExecutionRank.executionRank;
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
  const workflowType = body.workflowType === "multi_stage" ? "multi_stage" : body.workflowType === "task_list" ? "task_list" : "single";
  const normalizedSteps = workflowType === "multi_stage" ? normalizeMissionSteps(body.steps) : { steps: [] };
  if ("error" in normalizedSteps) return Response.json({ error: normalizedSteps.error }, { status: 400 });
  const normalizedTasks = workflowType === "task_list" ? normalizeMissionTasks(body.tasks) : { tasks: [] };
  if ("error" in normalizedTasks) return Response.json({ error: normalizedTasks.error }, { status: 400 });
  const createdEvent = prepareMissionStatusEvent(db, { missionId:id, actorId:auth.user.id, actorRole:auth.user.role, eventType:"created", toStatus:"open", serverRecordedAt:now, metadata:{ source, assignedTo } });
  await db.batch([
    db.prepare("INSERT INTO missions (id, title, description, source, status, priority, execution_rank, execution_rank_version, created_by, assigned_to, referrer_name, destination_name, workflow_type, current_step_no, deadline, deadline_at, created_at) VALUES (?, ?, ?, ?, 'open', ?, ?, 0, ?, ?, ?, ?, ?, 1, ?, ?, ?)").bind(id, title, body.description?.trim() ?? "", source, priority, executionRank, auth.user.id, assignedTo, referrerName, workflowType !== "multi_stage" ? body.destinationName?.trim() || null : null, workflowType, deadline, deadlineAt, now),
    ...normalizedSteps.steps.map((step) => db.prepare(`INSERT INTO mission_steps (id, mission_id, step_no, title, action_type, description, requires_location, destination_name, evidence_requirement, deadline, deadline_at, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`).bind(step.id, id, step.stepNo, step.title, step.actionType, step.description, step.requiresLocation ? 1 : 0, step.destinationName, step.evidenceRequirement, step.deadline, step.deadlineAt, now, now)),
    ...normalizedTasks.tasks.map((task) => db.prepare(`INSERT INTO mission_tasks (id, mission_id, task_no, title, description, status, updated_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`).bind(task.id, id, task.taskNo, task.title, task.description, now, now)),
    createdEvent.statement,
    db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'mission.created', 'mission', ?, ?, ?)").bind(crypto.randomUUID(), auth.user.id, id, JSON.stringify({ source, assignedTo, referrerName, executionRank }), now),
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
  return Response.json({ mission: { id, title, description: body.description?.trim() ?? "", source, status: "open", priority, executionRank, executionRankVersion:0, assignedTo, employeeName: assignee.fullName, workflowType, currentStepNo: 1, steps: normalizedSteps.steps, tasks: normalizedTasks.tasks.map(task=>({...task,status:"open",result:null,report:null,version:0,completedAt:null,updatedAt:now,createdAt:now})), referrerName, destinationName: workflowType !== "multi_stage" ? body.destinationName?.trim() || null : null, deadline, deadlineAt, scorePending: 0, scoreConfirmed: 0, createdAt: now } }, { status: 201 });
}
