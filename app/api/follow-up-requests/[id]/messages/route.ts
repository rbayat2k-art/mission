import { ensureDatabase } from "../../../../../db/runtime";
import { requireRole } from "../../../../../lib/auth";
import { canAccessFollowUp, isFollowUpOpen, type FollowUpAccessRow } from "../../../../../lib/follow-up";
import { createUserNotification } from "../../../../../lib/push-notifications";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor", "employee"]);
  if ("error" in auth) return auth.error;
  const { id } = await context.params;
  const body = await request.json().catch(() => ({})) as { text?:string };
  const text = body.text?.trim() ?? "";
  if (text.length < 1 || text.length > 4000) return Response.json({ error:"متن پیام باید بین ۱ تا ۴۰۰۰ کاراکتر باشد." }, { status:400 });
  const db = await ensureDatabase();
  const item = await db.prepare(`SELECT r.id, r.mission_id AS missionId, r.status, r.supervisor_id AS supervisorId,
    r.assigned_to AS assignedTo, m.title AS missionTitle, m.status AS missionStatus,
    m.assigned_to AS employeeId, u.full_name AS employeeName
    FROM mission_follow_up_requests r JOIN missions m ON m.id = r.mission_id
    JOIN users u ON u.id = m.assigned_to WHERE r.id = ?`).bind(id).first<FollowUpAccessRow>();
  if (!item) return Response.json({ error:"درخواست پیگیری پیدا نشد." }, { status:404 });
  if (!canAccessFollowUp(auth.user,item)) return Response.json({ error:"forbidden" }, { status:403 });
  if (!isFollowUpOpen(item.status)) return Response.json({ error:"این گفت‌وگو بسته شده است." }, { status:409 });
  const now = new Date().toISOString();
  const messageId = crypto.randomUUID();
  const employeeReply = auth.user.role === "employee" && item.status === "awaiting_employee";
  await db.batch([
    db.prepare("INSERT INTO mission_follow_up_messages (id, request_id, sender_id, message_type, body, created_at) VALUES (?, ?, ?, 'text', ?, ?)").bind(messageId,id,auth.user.id,text,now),
    employeeReply ? db.prepare("UPDATE mission_follow_up_requests SET status = 'awaiting_supervisor', assigned_to = supervisor_id, updated_at = ? WHERE id = ?").bind(now,id) : db.prepare("UPDATE mission_follow_up_requests SET updated_at = ? WHERE id = ?").bind(now,id),
    db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'follow_up.message_sent', 'follow_up_request', ?, ?, ?)").bind(crypto.randomUUID(),auth.user.id,id,JSON.stringify({messageId}),now),
  ]);
  const recipientId = auth.user.role === "employee" ? item.supervisorId : item.employeeId;
  if (recipientId !== auth.user.id) await createUserNotification(recipientId,{type:"follow_up_message",title:"پیام جدید درباره مأموریت",message:`در گفت‌وگوی «${item.missionTitle}» پیام جدیدی ثبت شد.`,entityType:"follow_up_request",entityId:id,url:"/?screen=notifications"});
  return Response.json({ message:{id,requestId:id,senderId:auth.user.id,senderName:auth.user.fullName,senderRole:auth.user.role,messageType:"text",body:text,createdAt:now}, status:employeeReply?"awaiting_supervisor":item.status },{status:201});
}
