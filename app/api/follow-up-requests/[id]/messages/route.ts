import { ensureDatabase } from "../../../../../db/runtime";
import { requireRole } from "../../../../../lib/auth";
import { canAccessFollowUp, isFollowUpOpen, type FollowUpAccessRow } from "../../../../../lib/follow-up";
import { createUserNotification } from "../../../../../lib/push-notifications";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor", "employee"]);
  if ("error" in auth) return auth.error;
  const { id } = await context.params;
  const body = await request.json().catch(() => null) as { text?:unknown; clientMessageId?:unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (text.length < 1 || text.length > 4000) return Response.json({ error:"متن پیام باید بین ۱ تا ۴۰۰۰ کاراکتر باشد." }, { status:400 });
  const requestedId = body?.clientMessageId;
  if (requestedId !== undefined && (typeof requestedId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedId))) {
    return Response.json({error:"شناسه ارسال پیام معتبر نیست."},{status:400});
  }
  const db = await ensureDatabase();
  const messageId = typeof requestedId === "string" ? requestedId.toLowerCase() : crypto.randomUUID();
  const outcome = await db.transaction(async transaction => {
  const item = await transaction.prepare(`SELECT r.id, r.mission_id AS missionId, r.status, r.supervisor_id AS supervisorId,
    r.assigned_to AS assignedTo, m.title AS missionTitle, m.status AS missionStatus,
    m.assigned_to AS employeeId, u.full_name AS employeeName
    FROM mission_follow_up_requests r JOIN missions m ON m.id = r.mission_id
    JOIN users u ON u.id = m.assigned_to WHERE r.id = ? FOR UPDATE`).bind(id).first<FollowUpAccessRow>();
  if (!item) return {error:Response.json({ error:"درخواست پیگیری پیدا نشد." }, { status:404 })};
  if (!canAccessFollowUp(auth.user,item)) return {error:Response.json({ error:"forbidden" }, { status:403 })};
  const existing = await transaction.prepare("SELECT id, request_id AS requestId, sender_id AS senderId, body, created_at AS createdAt FROM mission_follow_up_messages WHERE id = ?")
    .bind(messageId).first<{id:string;requestId:string;senderId:string;body:string;createdAt:string}>();
  if (existing) {
    if (existing.requestId !== id || existing.senderId !== auth.user.id || existing.body !== text) return {error:Response.json({error:"شناسه ارسال با پیام دیگری تداخل دارد."},{status:409})};
    return {item,createdAt:existing.createdAt,status:item.status,duplicate:true};
  }
  if (!isFollowUpOpen(item.status) || item.missionStatus === "cancelled") return {error:Response.json({ error:"این گفت‌وگو بسته شده است." }, { status:409 })};
  const now = new Date().toISOString();
  const employeeReply = auth.user.role === "employee" && item.status === "awaiting_employee";
  await transaction.batch([
    transaction.prepare("INSERT INTO mission_follow_up_messages (id, request_id, sender_id, message_type, body, created_at) VALUES (?, ?, ?, 'text', ?, ?)").bind(messageId,id,auth.user.id,text,now),
    employeeReply ? transaction.prepare("UPDATE mission_follow_up_requests SET status = 'awaiting_supervisor', assigned_to = supervisor_id, updated_at = ? WHERE id = ?").bind(now,id) : transaction.prepare("UPDATE mission_follow_up_requests SET updated_at = ? WHERE id = ?").bind(now,id),
    transaction.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'follow_up.message_sent', 'follow_up_request', ?, ?, ?)").bind(crypto.randomUUID(),auth.user.id,id,JSON.stringify({messageId}),now),
  ]);
  return {item,createdAt:now,status:employeeReply?"awaiting_supervisor":item.status,duplicate:false};
  });
  if ("error" in outcome) return outcome.error;
  const {item} = outcome;
  const recipientId = auth.user.role === "employee" ? (item.status === "escalated" ? item.assignedTo : item.supervisorId) : item.employeeId;
  if (!outcome.duplicate && recipientId !== auth.user.id) await createUserNotification(recipientId,{dedupeKey:`follow-up-message:${messageId}`,type:"follow_up_message",title:"پیام جدید درباره مأموریت",message:`در گفت‌وگوی «${item.missionTitle}» پیام جدیدی ثبت شد.`,entityType:"follow_up_request",entityId:id,url:recipientId===item.employeeId?"/?panel=employee&screen=missions":"/?panel=admin&screen=actions"});
  return Response.json({ message:{id:messageId,requestId:id,senderId:auth.user.id,senderName:auth.user.fullName,senderRole:auth.user.role,messageType:"text",body:text,createdAt:outcome.createdAt}, status:outcome.status, duplicate:outcome.duplicate },{status:outcome.duplicate?200:201,headers:{"Cache-Control":"private, no-store"}});
}
