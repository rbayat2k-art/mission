import { ensureDatabase } from "../../../../../db/runtime";
import { requireRole } from "../../../../../lib/auth";
import { ACTIONABLE_EXECUTION_RANK_STATUSES, normalizeExecutionRank } from "../../../../../lib/mission-execution-rank";

class ExecutionRankConflict extends Error {}

type MissionRankRow = {
  id:string;
  status:string;
  assignedTo:string;
  assigneeSupervisorId:string|null;
  executionRank:number|null;
  executionRankVersion:number;
};

export async function PATCH(request:Request,context:{params:Promise<{id:string}>}) {
  const auth=await requireRole(request,["owner","admin","supervisor"]);
  if("error" in auth)return auth.error;
  const {id}=await context.params;
  const body=await request.json().catch(()=>({})) as {executionRank?:unknown;expectedVersion?:unknown};
  const normalized=normalizeExecutionRank(body.executionRank);
  if("error" in normalized)return Response.json({error:normalized.error},{status:400});
  const expectedVersion=Number(body.expectedVersion);
  if(!Number.isInteger(expectedVersion)||expectedVersion<0){
    return Response.json({error:"نسخه رتبه اجرا معتبر نیست؛ صفحه را تازه کنید."},{status:409});
  }
  const db=await ensureDatabase();
  const now=new Date().toISOString();
  try{
    const outcome=await db.transaction(async transaction=>{
      const mission=await transaction.prepare(`SELECT m.id, m.status, m.assigned_to AS assignedTo,
        u.supervisor_id AS assigneeSupervisorId, m.execution_rank AS executionRank,
        m.execution_rank_version AS executionRankVersion
        FROM missions m JOIN users u ON u.id=m.assigned_to WHERE m.id=? FOR UPDATE`)
        .bind(id).first<MissionRankRow>();
      if(!mission)return {error:Response.json({error:"مأموریت پیدا نشد."},{status:404})} as const;
      if(auth.user.role==="supervisor"&&mission.assigneeSupervisorId!==auth.user.id){
        return {error:Response.json({error:"سرپرست فقط می‌تواند رتبه مأموریت کارکنان مستقیم خود را تغییر دهد."},{status:403})} as const;
      }
      if(!ACTIONABLE_EXECUTION_RANK_STATUSES.includes(mission.status as typeof ACTIONABLE_EXECUTION_RANK_STATUSES[number])){
        return {error:Response.json({error:"رتبه مأموریت تعیین‌تکلیف‌شده قابل تغییر نیست."},{status:409})} as const;
      }
      if(Number(mission.executionRankVersion)!==expectedVersion)throw new ExecutionRankConflict();
      if(mission.executionRank===normalized.executionRank){
        return {mission:{id,status:mission.status,executionRank:mission.executionRank,executionRankVersion:expectedVersion},unchanged:true} as const;
      }
      const update=await transaction.prepare(`UPDATE missions SET execution_rank=?, execution_rank_version=execution_rank_version+1
        WHERE id=? AND status=? AND execution_rank_version=?`)
        .bind(normalized.executionRank,id,mission.status,expectedVersion).run();
      if((update.meta.changes??0)!==1)throw new ExecutionRankConflict();
      await transaction.prepare(`INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at)
        VALUES (?, ?, 'mission.execution_rank_updated', 'mission', ?, ?, ?)`)
        .bind(crypto.randomUUID(),auth.user.id,id,JSON.stringify({previousExecutionRank:mission.executionRank,executionRank:normalized.executionRank,previousVersion:expectedVersion,executionRankVersion:expectedVersion+1}),now).run();
      return {mission:{id,status:mission.status,executionRank:normalized.executionRank,executionRankVersion:expectedVersion+1},unchanged:false} as const;
    });
    if("error" in outcome)return outcome.error;
    return Response.json(outcome,{headers:{"Cache-Control":"no-store"}});
  }catch(error){
    if(error instanceof ExecutionRankConflict){
      return Response.json({error:"رتبه این مأموریت هم‌زمان تغییر کرده است؛ صفحه را تازه کنید."},{status:409,headers:{"Cache-Control":"no-store"}});
    }
    throw error;
  }
}
