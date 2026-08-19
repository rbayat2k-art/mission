import { ensureDatabase } from "../../../db/runtime";
import { requireRole } from "../../../lib/auth";
import { fileStorage } from "../../../lib/file-storage";

const allowedTypes = new Set(["image/jpeg", "image/png", "application/pdf"]);

export async function POST(request: Request) {
  const auth = await requireRole(request, ["employee", "supervisor", "admin", "owner"]);
  if ("error" in auth) return auth.error;
  const form = await request.formData().catch(() => null);
  const missionId = form?.get("missionId");
  const file = form?.get("file");
  if (typeof missionId !== "string" || !(file instanceof File)) return Response.json({ error: "فایل و مأموریت الزامی هستند." }, { status: 400 });
  if (!allowedTypes.has(file.type) || file.size <= 0 || file.size > 10 * 1024 * 1024) return Response.json({ error: "فقط JPG، PNG یا PDF تا ۱۰ مگابایت مجاز است." }, { status: 400 });

  const db = await ensureDatabase();
  const mission = await db.prepare("SELECT m.assigned_to AS assignedTo, m.status, u.supervisor_id AS assigneeSupervisorId FROM missions m JOIN users u ON u.id = m.assigned_to WHERE m.id = ?").bind(missionId).first<{ assignedTo: string; status: string; assigneeSupervisorId: string | null }>();
  if (!mission) return Response.json({ error: "مأموریت پیدا نشد." }, { status: 404 });
  if (auth.user.role === "employee" && mission.assignedTo !== auth.user.id) return Response.json({ error: "forbidden" }, { status: 403 });
  if (auth.user.role === "supervisor" && mission.assignedTo !== auth.user.id && mission.assigneeSupervisorId !== auth.user.id) return Response.json({ error: "forbidden" }, { status: 403 });
  if (!["open", "in_progress", "revision"].includes(mission.status)) return Response.json({ error: "برای این مأموریت امکان افزودن مدرک وجود ندارد." }, { status: 409 });

  const id = crypto.randomUUID();
  const objectKey = `missions/${missionId}/${id}`;
  const now = new Date().toISOString();
  await fileStorage.put(objectKey, await file.arrayBuffer());
  try {
    await db.prepare("INSERT INTO attachments (id, mission_id, uploaded_by, object_key, file_name, content_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, missionId, auth.user.id, objectKey, file.name.slice(0, 180), file.type, file.size, now).run();
  } catch (error) {
    await fileStorage.delete(objectKey);
    throw error;
  }
  return Response.json({ attachment: { id, missionId, fileName: file.name, contentType: file.type, sizeBytes: file.size, createdAt: now } }, { status: 201 });
}

export async function GET(request: Request) {
  const auth = await requireRole(request, ["employee", "supervisor", "admin", "owner"]);
  if ("error" in auth) return auth.error;
  const missionId = new URL(request.url).searchParams.get("missionId");
  if (!missionId) return Response.json({ error: "شناسه مأموریت الزامی است." }, { status: 400 });
  const db = await ensureDatabase();
  const mission = await db.prepare("SELECT m.assigned_to AS assignedTo, u.supervisor_id AS assigneeSupervisorId FROM missions m JOIN users u ON u.id = m.assigned_to WHERE m.id = ?").bind(missionId).first<{ assignedTo: string; assigneeSupervisorId: string | null }>();
  if (!mission) return Response.json({ error: "مأموریت پیدا نشد." }, { status: 404 });
  if (auth.user.role === "employee" && mission.assignedTo !== auth.user.id) return Response.json({ error: "forbidden" }, { status: 403 });
  if (auth.user.role === "supervisor" && mission.assignedTo !== auth.user.id && mission.assigneeSupervisorId !== auth.user.id) return Response.json({ error: "forbidden" }, { status: 403 });
  const result = await db.prepare("SELECT id, mission_id AS missionId, file_name AS fileName, content_type AS contentType, size_bytes AS sizeBytes, created_at AS createdAt FROM attachments WHERE mission_id = ? ORDER BY created_at DESC").bind(missionId).all();
  return Response.json({ attachments: result.results });
}
