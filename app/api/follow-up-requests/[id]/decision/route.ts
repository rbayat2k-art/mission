import { ensureDatabase } from "../../../../../db/runtime";
import { requireRole } from "../../../../../lib/auth";
import { canAccessFollowUp, isFollowUpOpen, type FollowUpAccessRow } from "../../../../../lib/follow-up";
import { createUserNotification } from "../../../../../lib/push-notifications";

const decisions = ["request_info", "return_to_employee", "resolve", "reject", "escalate"] as const;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(request,["owner","admin","supervisor"]);
  if ("error" in auth) return auth.error;
  const {id}=await context.params;
  const body=await request.json().catch(()=>({})) as {action?:typeof decisions[number];note?:string};
  if (!body.action || !(decisions as readonly string[]).includes(body.action)) return Response.json({error:"تصمیم انتخاب‌شده معتبر نیست."},{status:400});
  const note=body.note?.trim()??"";
  if (note.length<3) return Response.json({error:"برای ثبت تصمیم، توضیح کوتاه لازم است."},{status:400});
  const db=await ensureDatabase();
  const item=await db.prepare(`SELECT r.id, r.mission_id AS missionId, r.status, r.supervisor_id AS supervisorId,
    r.assigned_to AS assignedTo, m.title AS missionTitle, m.status AS missionStatus,
    m.assigned_to AS employeeId, u.full_name AS employeeName
    FROM mission_follow_up_requests r JOIN missions m ON m.id=r.mission_id
    JOIN users u ON u.id=m.assigned_to WHERE r.id=?`).bind(id).first<FollowUpAccessRow>();
  if(!item)return Response.json({error:"درخواست پیگیری پیدا نشد."},{status:404});
  if(!canAccessFollowUp(auth.user,item))return Response.json({error:"forbidden"},{status:403});
  if(!isFollowUpOpen(item.status))return Response.json({error:"این درخواست قبلاً بسته شده است."},{status:409});
  let status="awaiting_supervisor";let assignedTo=item.supervisorId;let resolvedAt:string|null=null;
  if(body.action==="request_info"){status="awaiting_employee";assignedTo=item.employeeId}
  if(body.action==="return_to_employee"){status="ready_for_employee";assignedTo=item.employeeId}
  if(body.action==="resolve"){status="resolved";assignedTo=auth.user.id;resolvedAt=new Date().toISOString()}
  if(body.action==="reject"){status="rejected";assignedTo=auth.user.id;resolvedAt=new Date().toISOString()}
  if(body.action==="escalate"){
    const admin=await db.prepare("SELECT id FROM users WHERE role IN ('owner','admin') AND status='active' ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, created_at LIMIT 1").first<{id:string}>();
    if(!admin)return Response.json({error:"مدیر فعالی برای ارجاع پیدا نشد."},{status:409});
    status="escalated";assignedTo=admin.id;
  }
  const now=new Date().toISOString();
  const statements=[
    db.prepare("UPDATE mission_follow_up_requests SET status=?, assigned_to=?, resolution_note=?, updated_at=?, resolved_at=? WHERE id=?").bind(status,assignedTo,["resolved","rejected"].includes(status)?note:null,now,resolvedAt,id),
    db.prepare("INSERT INTO mission_follow_up_messages (id, request_id, sender_id, message_type, body, created_at) VALUES (?, ?, ?, 'decision', ?, ?)").bind(crypto.randomUUID(),id,auth.user.id,note,now),
    db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'follow_up.decision', 'follow_up_request', ?, ?, ?)").bind(crypto.randomUUID(),auth.user.id,id,JSON.stringify({action:body.action,status,assignedTo,note}),now),
  ];
  if(body.action==="return_to_employee"&&item.missionStatus==="follow_up_pending"){
    statements.push(
      db.prepare("UPDATE approvals SET status='approved', supervisor_id=?, reason=?, decided_at=? WHERE mission_id=? AND status='pending'").bind(auth.user.id,"تأیید گزارش و بازگشت به روال پیگیری مجدد",now,item.missionId),
      db.prepare("UPDATE missions SET status='follow_up', score_confirmed=score_pending, score_pending=0 WHERE id=?").bind(item.missionId),
      db.prepare("UPDATE mission_attempts SET approval_status='approved' WHERE mission_id=? ORDER BY attempt_no DESC LIMIT 1").bind(item.missionId),
    );
  }
  if(body.action==="resolve"){
    statements.push(
      db.prepare("UPDATE missions SET status='approved', score_confirmed=score_confirmed+score_pending, score_pending=0 WHERE id=?").bind(item.missionId),
      db.prepare("UPDATE approvals SET status='approved', supervisor_id=?, reason=?, decided_at=? WHERE mission_id=? AND status='pending'").bind(auth.user.id,note,now,item.missionId),
      db.prepare("UPDATE mission_attempts SET approval_status='approved' WHERE mission_id=? ORDER BY attempt_no DESC LIMIT 1").bind(item.missionId),
    );
  }
  await db.batch(statements);
  const recipientId=body.action==="escalate"?assignedTo:item.employeeId;
  await createUserNotification(recipientId,{type:`follow_up_${body.action}`,title:body.action==="request_info"?"اطلاعات بیشتری لازم است":body.action==="return_to_employee"?"مأموریت برای پیگیری برگشت":body.action==="resolve"?"درخواست پیگیری بسته شد":body.action==="reject"?"درخواست پیگیری رد شد":"درخواست به مدیر ارجاع شد",message:`برای مأموریت «${item.missionTitle}»: ${note}`,entityType:"follow_up_request",entityId:id,url:recipientId===item.employeeId?"/?panel=employee&screen=missions":"/?panel=admin&screen=actions"});
  return Response.json({request:{id,status,assignedTo,resolvedAt,updatedAt:now}});
}
