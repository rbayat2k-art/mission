import { ensureDatabase } from "../../../db/runtime";
import { requireRole } from "../../../lib/auth";

type NotificationRow = { id:string; type:string; title:string; message:string; entityType:string|null; entityId:string|null; readAt:string|null; createdAt:string };

export async function GET(request: Request) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor", "employee"]);
  if ("error" in auth) return auth.error;
  const db = await ensureDatabase();
  const notifications = (await db.prepare("SELECT id, type, title, message, entity_type AS entityType, entity_id AS entityId, read_at AS readAt, created_at AS createdAt FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").bind(auth.user.id).all<NotificationRow>()).results;
  const unreadCount = notifications.filter(item => !item.readAt).length;
  let openRequestCount = 0;
  if (auth.user.role === "employee") {
    const row = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM missions WHERE assigned_to = ? AND status IN ('open','in_progress','revision','follow_up')) +
      (SELECT COUNT(*) FROM mission_follow_up_requests r JOIN missions m ON m.id=r.mission_id WHERE m.assigned_to=? AND r.status='awaiting_employee') AS count`).bind(auth.user.id,auth.user.id).first<{count:number}>();
    openRequestCount = Number(row?.count ?? 0);
  } else if (auth.user.role === "supervisor") {
    const row = await db.prepare("SELECT COUNT(*) AS count FROM mission_follow_up_requests WHERE assigned_to=? AND status IN ('awaiting_supervisor','escalated')").bind(auth.user.id).first<{count:number}>();
    openRequestCount = Number(row?.count ?? 0);
  } else {
    const row = await db.prepare("SELECT COUNT(*) AS count FROM mission_follow_up_requests WHERE status IN ('awaiting_supervisor','escalated')").first<{count:number}>();
    openRequestCount = Number(row?.count ?? 0);
  }
  return Response.json({ notifications, unreadCount, openRequestCount });
}

export async function PATCH(request: Request) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor", "employee"]);
  if ("error" in auth) return auth.error;
  const body = await request.json().catch(() => ({})) as { id?:string; markAll?:boolean };
  const db = await ensureDatabase();
  const now = new Date().toISOString();
  if (body.markAll) await db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").bind(now, auth.user.id).run();
  else if (body.id) await db.prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL").bind(now, body.id, auth.user.id).run();
  else return Response.json({ error: "اعلان معتبری انتخاب نشده است." }, { status: 400 });
  return Response.json({ ok: true, readAt: now });
}
