import { ensureDatabase } from "../../../../db/runtime";
import { requireRole } from "../../../../lib/auth";
import { fileStorage } from "../../../../lib/file-storage";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(request, ["employee", "supervisor", "admin", "owner"]);
  if ("error" in auth) return auth.error;
  const { id } = await context.params;
  const db = await ensureDatabase();
  const attachment = await db.prepare("SELECT a.object_key AS objectKey, a.file_name AS fileName, a.content_type AS contentType, m.assigned_to AS assignedTo, u.supervisor_id AS assigneeSupervisorId FROM attachments a JOIN missions m ON m.id = a.mission_id JOIN users u ON u.id = m.assigned_to WHERE a.id = ?").bind(id).first<{ objectKey: string; fileName: string; contentType: string; assignedTo: string; assigneeSupervisorId: string | null }>();
  if (!attachment) return Response.json({ error: "فایل پیدا نشد." }, { status: 404 });
  if (auth.user.role === "employee" && attachment.assignedTo !== auth.user.id) return Response.json({ error: "forbidden" }, { status: 403 });
  if (auth.user.role === "supervisor" && attachment.assignedTo !== auth.user.id && attachment.assigneeSupervisorId !== auth.user.id) return Response.json({ error: "forbidden" }, { status: 403 });
  const object = await fileStorage.get(attachment.objectKey);
  if (!object) return Response.json({ error: "فایل در فضای ذخیره‌سازی پیدا نشد." }, { status: 404 });
  return new Response(object.body, { headers: {
    "Content-Type": attachment.contentType,
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
    "Cache-Control": "private, max-age=300",
    "X-Content-Type-Options": "nosniff",
  } });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(request, ["employee", "supervisor", "admin", "owner"]);
  if ("error" in auth) return auth.error;
  const { id } = await context.params;
  const db = await ensureDatabase();
  const attachment = await db.prepare("SELECT a.object_key AS objectKey, a.uploaded_by AS uploadedBy, m.assigned_to AS assignedTo, m.status, u.supervisor_id AS assigneeSupervisorId FROM attachments a JOIN missions m ON m.id = a.mission_id JOIN users u ON u.id = m.assigned_to WHERE a.id = ?").bind(id).first<{ objectKey: string; uploadedBy: string; assignedTo: string; status: string; assigneeSupervisorId: string | null }>();
  if (!attachment) return Response.json({ error: "فایل پیدا نشد." }, { status: 404 });
  if (auth.user.role === "employee" && (attachment.assignedTo !== auth.user.id || attachment.uploadedBy !== auth.user.id)) return Response.json({ error: "forbidden" }, { status: 403 });
  if (auth.user.role === "supervisor" && attachment.assignedTo !== auth.user.id && attachment.assigneeSupervisorId !== auth.user.id) return Response.json({ error: "forbidden" }, { status: 403 });
  if (!["open", "in_progress", "revision"].includes(attachment.status)) return Response.json({ error: "پس از پایان مأموریت امکان حذف مدرک وجود ندارد." }, { status: 409 });
  await fileStorage.delete(attachment.objectKey);
  await db.prepare("DELETE FROM attachments WHERE id = ?").bind(id).run();
  return Response.json({ deleted: true });
}
