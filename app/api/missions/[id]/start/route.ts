import { ensureDatabase } from "../../../../../db/runtime";
import { requireRole } from "../../../../../lib/auth";
import { locationSqlValues, parseMissionLocation } from "../../../../../lib/mission-location";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor", "employee"]);
  if ("error" in auth) return auth.error;
  const { id } = await context.params;
  const db = await ensureDatabase();
  const mission = await db.prepare("SELECT id, source, assigned_to AS assignedTo, status, started_at AS startedAt FROM missions WHERE id = ?").bind(id).first<{ id: string; source: string; assignedTo: string; status: string; startedAt: string | null }>();
  if (!mission) return Response.json({ error: "مأموریت پیدا نشد." }, { status: 404 });
  if (mission.assignedTo !== auth.user.id) return Response.json({ error: "فقط مسئول مأموریت می‌تواند آن را شروع کند." }, { status: 403 });
  const activeSession = await db.prepare("SELECT id FROM work_sessions WHERE user_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1").bind(auth.user.id).first();
  if (!activeSession) return Response.json({ error: "برای شروع کار روی مأموریت، ابتدا فعالیت روزانه را شروع کنید." }, { status: 409 });
  if (mission.status === "in_progress") return Response.json({ mission: { id, status: "in_progress", startedAt: mission.startedAt } });
  if (!["open", "follow_up", "revision"].includes(mission.status)) return Response.json({ error: mission.status === "follow_up_pending" ? "گزارش مراجعه قبلی ابتدا باید توسط سرپرست بررسی شود." : "این مأموریت دیگر قابل شروع نیست." }, { status: 409 });
  const body = await request.json().catch(() => ({})) as { location?: unknown };
  const startLocation = parseMissionLocation(body.location);
  if (!startLocation) return Response.json({ error: "برای شروع مأموریت، موقعیت GPS معتبر لازم است." }, { status: 400 });
  const [latitudeE6, longitudeE6, accuracyCm, locationRecordedAt] = locationSqlValues(startLocation);
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE missions SET status = 'in_progress', destination_name = NULL, expense_amount = 0,
      score_pending = 0, score_confirmed = 0, score_penalty = 0, score_note = NULL, completed_at = NULL,
      end_latitude_e6 = NULL, end_longitude_e6 = NULL, end_accuracy_cm = NULL, end_location_recorded_at = NULL,
      started_at = ?, start_latitude_e6 = ?, start_longitude_e6 = ?, start_accuracy_cm = ?, start_location_recorded_at = ?
      WHERE id = ? AND status IN ('open', 'follow_up', 'revision')`).bind(now, latitudeE6, longitudeE6, accuracyCm, locationRecordedAt, id),
    db.prepare("DELETE FROM mission_destinations WHERE mission_id = ?").bind(id),
    db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, 'mission', ?, ?, ?)").bind(
      crypto.randomUUID(), auth.user.id, mission.status === "follow_up" ? "mission.follow_up_started" : "mission.started", id,
      JSON.stringify({ previousStatus: mission.status, locationRecordedAt, accuracy: Math.round(startLocation.accuracy) }), now,
    ),
  ]);
  return Response.json({ mission: { id, status: "in_progress", startedAt: now, startLocation } });
}
