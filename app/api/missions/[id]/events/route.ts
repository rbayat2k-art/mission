import { ensureDatabase } from "../../../../../db/runtime";
import { requireRole } from "../../../../../lib/auth";
import { enrichMissionStatusEventLocation } from "../../../../../lib/mission-status-events";

type MissionAccess = { assignedTo: string; createdBy: string; supervisorId: string | null };
type EventRow = {
  id: string; attemptNo: number | null; actorId: string; actorName: string; actorRole: string; eventType: string;
  fromStatus: string | null; toStatus: string | null; result: string | null; serverRecordedAt: string; deviceRecordedAt: string | null;
  latitudeE6: number | null; longitudeE6: number | null; accuracyCm: number | null; locationLabel: string | null;
  street: string | null; neighborhood: string | null; district: string | null; city: string | null; province: string | null;
  geocodeProvider: string | null; geocodeStatus: string; metadata: Record<string, unknown> | string | null;
};

function canReadMission(role: string, userId: string, mission: MissionAccess) {
  if (role === "owner" || role === "admin") return true;
  if (role === "employee") return mission.assignedTo === userId;
  return mission.supervisorId === userId || mission.createdBy === userId || mission.assignedTo === userId;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor", "employee"]);
  if ("error" in auth) return auth.error;
  const { id } = await context.params;
  const db = await ensureDatabase();
  const mission = await db.prepare(`SELECT m.assigned_to AS assignedTo, m.created_by AS createdBy, u.supervisor_id AS supervisorId
    FROM missions m JOIN users u ON u.id=m.assigned_to WHERE m.id=?`).bind(id).first<MissionAccess>();
  if (!mission) return Response.json({ error: "مأموریت پیدا نشد." }, { status: 404 });
  if (!canReadMission(auth.user.role, auth.user.id, mission)) return Response.json({ error: "forbidden" }, { status: 403 });

  const pending = await db.prepare(`SELECT id, latitude_e6 AS latitudeE6, longitude_e6 AS longitudeE6, accuracy_cm AS accuracyCm,
    device_recorded_at AS deviceRecordedAt FROM mission_status_events WHERE mission_id=? AND geocode_status='pending'
    AND latitude_e6 IS NOT NULL AND longitude_e6 IS NOT NULL ORDER BY server_recorded_at DESC LIMIT 1`).bind(id).first<{
      id:string;latitudeE6:number;longitudeE6:number;accuracyCm:number|null;deviceRecordedAt:string|null;
    }>();
  if (pending) await enrichMissionStatusEventLocation(pending.id, {
    latitude:Number(pending.latitudeE6)/1_000_000, longitude:Number(pending.longitudeE6)/1_000_000,
    accuracy:Number(pending.accuracyCm ?? 0)/100, recordedAt:pending.deviceRecordedAt ?? new Date().toISOString(),
  });

  const rows = await db.prepare(`SELECT mse.id, mse.attempt_no AS attemptNo, mse.actor_id AS actorId, u.full_name AS actorName,
    mse.actor_role AS actorRole, mse.event_type AS eventType, mse.from_status AS fromStatus, mse.to_status AS toStatus, mse.result,
    mse.server_recorded_at AS serverRecordedAt, mse.device_recorded_at AS deviceRecordedAt, mse.latitude_e6 AS latitudeE6,
    mse.longitude_e6 AS longitudeE6, mse.accuracy_cm AS accuracyCm, mse.location_label AS locationLabel, mse.street,
    mse.neighborhood, mse.district, mse.city, mse.province, mse.geocode_provider AS geocodeProvider,
    mse.geocode_status AS geocodeStatus, mse.metadata
    FROM mission_status_events mse JOIN users u ON u.id=mse.actor_id WHERE mse.mission_id=?
    ORDER BY mse.server_recorded_at, mse.id`).bind(id).all<EventRow>();
  const events = rows.results.map((row) => ({
    ...row,
    latitude:row.latitudeE6 == null ? null : Number(row.latitudeE6)/1_000_000,
    longitude:row.longitudeE6 == null ? null : Number(row.longitudeE6)/1_000_000,
    accuracy:row.accuracyCm == null ? null : Number(row.accuracyCm)/100,
    metadata:typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
    latitudeE6:undefined, longitudeE6:undefined, accuracyCm:undefined,
  }));
  return Response.json({ events });
}
