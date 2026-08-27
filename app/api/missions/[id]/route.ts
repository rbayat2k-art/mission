import { ensureDatabase } from "../../../../db/runtime";
import { requireRole } from "../../../../lib/auth";
import { normalizeJalaliDeadline } from "../../../../lib/mission-deadline";
import { normalizeMissionSteps, type MissionStepInput } from "../../../../lib/mission-steps";
import { normalizeMissionTasks, type MissionTaskInput } from "../../../../lib/mission-tasks";
import { normalizeExecutionRank } from "../../../../lib/mission-execution-rank";

type MissionRow = {
  id: string; title: string; description: string; source: string; status: string; priority: string;
  executionRank:number|null;executionRankVersion:number;
  createdBy: string; assignedTo: string; assigneeSupervisorId: string | null; destinationName: string | null;
  deadline: string | null; createdAt: string;
  workflowType:string;
};

class MissionEditConflict extends Error {}

function canChangeMission(role: string, userId: string, mission: MissionRow) {
  if (role === "owner" || role === "admin") return true;
  if (role === "supervisor") return mission.createdBy === userId && mission.assigneeSupervisorId === userId;
  return mission.source === "employee" && mission.createdBy === userId && mission.assignedTo === userId;
}

async function getMission(id: string) {
  const db = await ensureDatabase();
  const mission = await db.prepare(`SELECT m.id, m.title, m.description, m.source, m.status, m.priority,
    m.execution_rank AS executionRank, m.execution_rank_version AS executionRankVersion,
    m.created_by AS createdBy, m.assigned_to AS assignedTo, u.supervisor_id AS assigneeSupervisorId,
    m.workflow_type AS workflowType, m.destination_name AS destinationName, m.deadline, m.created_at AS createdAt
    FROM missions m JOIN users u ON u.id = m.assigned_to WHERE m.id = ?`).bind(id).first<MissionRow>();
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

  const body = await request.json().catch(() => ({})) as { title?: string; description?: string; priority?: string; executionRank?:unknown; deadlineDate?: string | null; deadlineTime?: string | null; destinationName?: string | null; assignedTo?: string;workflowType?:string;steps?:MissionStepInput[];tasks?:MissionTaskInput[] };
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
  const normalizedExecutionRank = auth.user.role === "employee" || body.executionRank === undefined
    ? { executionRank:mission.executionRank }
    : normalizeExecutionRank(body.executionRank);
  if ("error" in normalizedExecutionRank) return Response.json({error:normalizedExecutionRank.error},{status:400});
  const executionRank=normalizedExecutionRank.executionRank;
  const rankChanged=executionRank!==mission.executionRank;
  const workflowType = body.workflowType === "multi_stage" ? "multi_stage" : body.workflowType === "task_list" ? "task_list" : "single";
  const normalizedSteps = workflowType === "multi_stage" ? normalizeMissionSteps(body.steps) : { steps:[] };
  if ("error" in normalizedSteps) return Response.json({ error:normalizedSteps.error }, { status:400 });
  const normalizedTasks = workflowType === "task_list" ? normalizeMissionTasks(body.tasks) : { tasks:[] };
  if ("error" in normalizedTasks) return Response.json({ error:normalizedTasks.error }, { status:400 });
  const now = new Date().toISOString();
  const statements = [
    db.prepare(`UPDATE missions SET title=?, description=?, priority=?, execution_rank=?,
      execution_rank_version=execution_rank_version+?, assigned_to=?, workflow_type=?, current_step_no=1,
      destination_name=?, deadline=?, deadline_at=? WHERE id=? AND status='open' AND execution_rank_version=?`)
      .bind(title,body.description?.trim()??"",priority,executionRank,rankChanged?1:0,assignedTo,workflowType,
        workflowType!=="multi_stage"?body.destinationName?.trim()||null:null,deadline,deadlineAt,id,mission.executionRankVersion),
    db.prepare("DELETE FROM mission_steps WHERE mission_id=?").bind(id),
    db.prepare("DELETE FROM mission_tasks WHERE mission_id=?").bind(id),
    ...normalizedSteps.steps.map(step=>db.prepare(`INSERT INTO mission_steps (id, mission_id, step_no, title, action_type, description, requires_location, destination_name, evidence_requirement, deadline, deadline_at, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`).bind(step.id,id,step.stepNo,step.title,step.actionType,step.description,step.requiresLocation?1:0,step.destinationName,step.evidenceRequirement,step.deadline,step.deadlineAt,now,now)),
    ...normalizedTasks.tasks.map(task=>db.prepare(`INSERT INTO mission_tasks (id, mission_id, task_no, title, description, status, updated_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`).bind(task.id,id,task.taskNo,task.title,task.description,now,now)),
    db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'mission.updated', 'mission', ?, ?, ?)").bind(crypto.randomUUID(), auth.user.id, id, JSON.stringify({ assignedTo, priority, previousExecutionRank:mission.executionRank, executionRank }), now),
  ];
  try {
    await db.transaction(async transaction=>{
      const locked=await transaction.prepare("SELECT status, execution_rank_version AS executionRankVersion FROM missions WHERE id=? FOR UPDATE").bind(id).first<{status:string;executionRankVersion:number}>();
      if(!locked||locked.status!=="open"||Number(locked.executionRankVersion)!==Number(mission.executionRankVersion))throw new MissionEditConflict();
      const results=await transaction.batch(statements);
      if((results[0]?.meta.changes??0)!==1)throw new MissionEditConflict();
    });
  } catch(error) {
    if(error instanceof MissionEditConflict)return Response.json({error:"مأموریت هم‌زمان شروع یا تغییر کرده است؛ صفحه را تازه کنید."},{status:409});
    throw error;
  }
  return Response.json({ mission: { ...mission, title, description: body.description?.trim() ?? "", priority, executionRank,
    executionRankVersion:mission.executionRankVersion+(rankChanged?1:0), assignedTo, employeeName: assignee.fullName,
    workflowType,currentStepNo:1,steps:normalizedSteps.steps,tasks:normalizedTasks.tasks.map(task=>({...task,status:"open",result:null,report:null,version:0,completedAt:null,updatedAt:now,createdAt:now})),destinationName: workflowType !== "multi_stage" ? body.destinationName?.trim() || null : null, deadline } });
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
