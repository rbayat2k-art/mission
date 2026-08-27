import { ensureDatabase } from "../../../../../../db/runtime";
import { requireRole } from "../../../../../../lib/auth";
import { locationSqlValues, parseMissionLocation } from "../../../../../../lib/mission-location";
import { normalizeMissionTaskResult } from "../../../../../../lib/mission-tasks";

class TaskTransitionConflict extends Error {}

export async function PATCH(request: Request, context: { params: Promise<{ id: string; taskId: string }> }) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor", "employee"]);
  if ("error" in auth) return auth.error;
  const { id, taskId } = await context.params;
  const body = await request.json().catch(() => ({})) as { result?: unknown; report?: unknown; location?: unknown; expectedVersion?: unknown; clientEventId?: unknown };
  const normalized = normalizeMissionTaskResult(body.result, body.report);
  if ("error" in normalized) return Response.json({ error: normalized.error }, { status: 400 });
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return Response.json({ error:"نسخه وضعیت این کار معتبر نیست؛ صفحه را تازه کنید." }, { status:409 });
  }
  const clientEventId = typeof body.clientEventId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.clientEventId)
    ? body.clientEventId : null;
  if (!clientEventId) return Response.json({ error:"شناسه ثبت نتیجه معتبر نیست." }, { status:400 });
  const location = parseMissionLocation(body.location);
  if (!location) return Response.json({ error: "برای ثبت نتیجه کار، موقعیت GPS با دقت حداکثر ۱۰۰ متر لازم است." }, { status:400 });
  const db = await ensureDatabase();
  const now = new Date().toISOString();
  const taskStatus = normalized.result === "انجام شد" ? "completed" : "follow_up";
  try {
    const updatedTask = await db.transaction(async transaction => {
      const mission = await transaction.prepare(`SELECT id, assigned_to AS assignedTo, status, workflow_type AS workflowType
        FROM missions WHERE id=? FOR UPDATE`).bind(id).first<{ id:string; assignedTo:string; status:string; workflowType:string }>();
      if (!mission) return { error:Response.json({ error:"مأموریت پیدا نشد." }, { status:404 }) } as const;
      if (mission.assignedTo !== auth.user.id) return { error:Response.json({ error:"فقط مسئول مأموریت می‌تواند نتیجه کارهای آن را ثبت کند." }, { status:403 }) } as const;
      if (mission.workflowType !== "task_list") return { error:Response.json({ error:"این مأموریت چندتسکی نیست." }, { status:409 }) } as const;
      const task = await transaction.prepare(`SELECT id, task_no AS taskNo, title, description, status, result, report, version, completed_at AS completedAt, updated_at AS updatedAt
        FROM mission_tasks WHERE id=? AND mission_id=? FOR UPDATE`).bind(taskId,id).first<{
          id:string;taskNo:number;title:string;description:string;status:string;result:string|null;report:string|null;version:number;completedAt:string|null;updatedAt:string;
        }>();
      if (!task) return { error:Response.json({ error:"کار موردنظر در این مأموریت پیدا نشد." }, { status:404 }) } as const;
      if (task.status === "cancelled") return { error:Response.json({ error:"کار لغوشده قابل تغییر نیست." }, { status:409 }) } as const;
      const priorEvent = await transaction.prepare(`SELECT id, mission_id AS missionId, mission_task_id AS missionTaskId, actor_id AS actorId
        FROM mission_task_events WHERE client_event_id=? LIMIT 1`).bind(clientEventId).first<{id:string;missionId:string;missionTaskId:string;actorId:string|null}>();
      if (priorEvent) {
        if (priorEvent.missionId !== id || priorEvent.missionTaskId !== task.id || priorEvent.actorId !== auth.user.id) throw new TaskTransitionConflict();
        return { task, eventId:priorEvent.id, duplicate:true } as const;
      }
      if (!["open","in_progress","revision","follow_up"].includes(mission.status)) {
        return { error:Response.json({ error:"این مأموریت اکنون در وضعیت قابل ثبت تسک نیست." }, { status:409 }) } as const;
      }
      if (Date.now() - Date.parse(location.recordedAt) > 24 * 60 * 60_000) {
        return { error:Response.json({ error:"زمان ثبت نتیجه کار بیش از ۲۴ ساعت گذشته و قابل همگام‌سازی نیست." }, { status:400 }) } as const;
      }
      const destination = await transaction.prepare(`SELECT id, recorded_at AS recordedAt FROM mission_destinations
        WHERE mission_id=? AND user_id=? LIMIT 1 FOR UPDATE`).bind(id,auth.user.id).first<{id:string;recordedAt:string}>();
      if (!destination) return { error:Response.json({ error:"ابتدا مقصد این مأموریت را ثبت کنید." }, { status:409 }) } as const;
      if (Date.parse(location.recordedAt) < Date.parse(destination.recordedAt)) {
        return { error:Response.json({ error:"زمان نتیجه کار نمی‌تواند پیش از زمان ثبت مقصد باشد." }, { status:409 }) } as const;
      }
      const session = await transaction.prepare(`SELECT id FROM work_sessions WHERE user_id=? AND started_at<=?
        AND (ended_at IS NULL OR ended_at>=?) ORDER BY started_at DESC LIMIT 1 FOR UPDATE`)
        .bind(auth.user.id,location.recordedAt,location.recordedAt).first<{ id:string }>();
      if (!session) return { error:Response.json({ error:"نتیجه کار باید در بازه فعالیت روزانه ثبت شده باشد." }, { status:409 }) } as const;
      if (Number(task.version) !== expectedVersion) throw new TaskTransitionConflict();
      const [latitudeE6,longitudeE6,accuracyCm,recordedAt]=locationSqlValues(location);
      const eventId=crypto.randomUUID();
      const eventType=task.result ? "result_updated" : "result_set";
      const completedAt=taskStatus==="completed"?now:null;
      const result=await transaction.prepare(`UPDATE mission_tasks SET status=?, result=?, report=?, version=version+1, completed_at=?, updated_at=?
        WHERE id=? AND mission_id=? AND status=? AND version=?`).bind(taskStatus,normalized.result,normalized.report,completedAt,now,task.id,id,task.status,expectedVersion).run();
      if ((result.meta.changes??0)!==1) throw new TaskTransitionConflict();
      await transaction.batch([
        transaction.prepare(`INSERT INTO mission_task_events (id, mission_id, mission_task_id, actor_id, actor_role, client_event_id, event_type,
          from_status, to_status, result, report, latitude_e6, longitude_e6, accuracy_cm, device_recorded_at,
          server_recorded_at, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(eventId,id,task.id,auth.user.id,auth.user.role,clientEventId,eventType,task.status,taskStatus,normalized.result,normalized.report,
            latitudeE6,longitudeE6,accuracyCm,recordedAt,now,JSON.stringify({ previousResult:task.result, previousReport:task.report }),now),
        transaction.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'mission.task_result_set', 'mission_task', ?, ?, ?)")
          .bind(crypto.randomUUID(),auth.user.id,task.id,JSON.stringify({missionId:id,taskNo:task.taskNo,eventId,clientEventId,result:normalized.result,previousResult:task.result}),now),
      ]);
      return { task:{...task,status:taskStatus,result:normalized.result,report:normalized.report,version:expectedVersion+1,completedAt,updatedAt:now}, eventId } as const;
    });
    if ("error" in updatedTask) return updatedTask.error;
    return Response.json(updatedTask, { headers:{"Cache-Control":"no-store"} });
  } catch(error) {
    if(error instanceof TaskTransitionConflict) return Response.json({error:"وضعیت این کار هم‌زمان تغییر کرده است؛ صفحه را تازه کنید."},{status:409});
    throw error;
  }
}
