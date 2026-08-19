import { ensureDatabase } from "../../../db/runtime";
import { requireRole } from "../../../lib/auth";

type DestinationBody = {
  missionId?: string;
  destinationName?: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  recordedAt?: string;
};

type DestinationRow = {
  id: string;
  missionId: string;
  missionTitle: string;
  userId: string;
  fullName: string;
  destinationName: string;
  latitudeE6: number;
  longitudeE6: number;
  accuracyCm: number;
  recordedAt: string;
};

const TEHRAN_OFFSET_MINUTES = 210;

function tehranDateKey(value: Date | string) {
  const date = typeof value === "string" ? new Date(value) : value;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function periodBounds(period: "daily" | "weekly" | "monthly", requestedDate?: string | null) {
  const endDateKey = requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : tehranDateKey(new Date());
  const [year, month, day] = endDateKey.split("-").map(Number);
  const endLocalUtc = Date.UTC(year, month - 1, day + 1);
  const days = period === "weekly" ? 7 : period === "monthly" ? 30 : 1;
  return {
    start: new Date(endLocalUtc - days * 86_400_000 - TEHRAN_OFFSET_MINUTES * 60_000).toISOString(),
    end: new Date(endLocalUtc - TEHRAN_OFFSET_MINUTES * 60_000).toISOString(),
    endDateKey,
  };
}

function validBody(body: DestinationBody) {
  return typeof body.missionId === "string" && body.missionId.length >= 8 &&
    typeof body.destinationName === "string" && body.destinationName.trim().length >= 2 && body.destinationName.trim().length <= 255 &&
    Number.isFinite(body.latitude) && body.latitude! >= -90 && body.latitude! <= 90 &&
    Number.isFinite(body.longitude) && body.longitude! >= -180 && body.longitude! <= 180 &&
    Number.isFinite(body.accuracy) && body.accuracy! >= 0 && body.accuracy! <= 10_000 &&
    !Number.isNaN(Date.parse(body.recordedAt ?? ""));
}

export async function POST(request: Request) {
  const auth = await requireRole(request, ["employee", "supervisor", "admin", "owner"]);
  if ("error" in auth) return auth.error;
  const body = await request.json().catch(() => ({})) as DestinationBody;
  if (!validBody(body)) return Response.json({ error: "اطلاعات مقصد یا موقعیت GPS معتبر نیست." }, { status: 400 });

  const recordedAt = new Date(body.recordedAt!).toISOString();
  if (Date.parse(recordedAt) > Date.now() + 5 * 60_000) return Response.json({ error: "زمان ثبت مقصد معتبر نیست." }, { status: 400 });
  const db = await ensureDatabase();
  const mission = await db.prepare("SELECT id, assigned_to AS assignedTo, status FROM missions WHERE id = ?").bind(body.missionId).first<{ id: string; assignedTo: string; status: string }>();
  if (!mission) return Response.json({ error: "مأموریت پیدا نشد." }, { status: 404 });
  if (mission.assignedTo !== auth.user.id) return Response.json({ error: "فقط مسئول مأموریت می‌تواند مقصد آن را ثبت کند." }, { status: 403 });
  if (!["open", "in_progress", "revision", "follow_up"].includes(mission.status)) return Response.json({ error: "برای این مأموریت دیگر نمی‌توان مقصد ثبت کرد." }, { status: 409 });

  const session = await db.prepare("SELECT id FROM work_sessions WHERE user_id = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at DESC LIMIT 1")
    .bind(auth.user.id, recordedAt, recordedAt).first<{ id: string }>();
  if (!session) return Response.json({ error: "ثبت مقصد فقط در زمان فعالیت روزانه امکان‌پذیر است." }, { status: 409 });

  const now = new Date().toISOString();
  const destinationName = body.destinationName!.trim();
  const destinationId = crypto.randomUUID();
  await db.batch([
    db.prepare(`INSERT INTO mission_destinations (id, mission_id, user_id, work_session_id, destination_name, latitude_e6, longitude_e6, accuracy_cm, recorded_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), work_session_id = VALUES(work_session_id), destination_name = VALUES(destination_name), latitude_e6 = VALUES(latitude_e6), longitude_e6 = VALUES(longitude_e6), accuracy_cm = VALUES(accuracy_cm), recorded_at = VALUES(recorded_at)`)
      .bind(destinationId, mission.id, auth.user.id, session.id, destinationName, Math.round(body.latitude! * 1_000_000), Math.round(body.longitude! * 1_000_000), Math.round(body.accuracy! * 100), recordedAt, now),
    db.prepare("UPDATE missions SET destination_name = ? WHERE id = ?").bind(destinationName, mission.id),
    db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'mission.destination_registered', 'mission', ?, ?, ?)")
      .bind(crypto.randomUUID(), auth.user.id, mission.id, JSON.stringify({ destinationName, accuracy: Math.round(body.accuracy!), recordedAt }), now),
  ]);
  return Response.json({ destination: { missionId: mission.id, destinationName, latitude: body.latitude, longitude: body.longitude, accuracy: body.accuracy, recordedAt } }, { status: 201 });
}

export async function GET(request: Request) {
  const auth = await requireRole(request, ["employee", "supervisor", "admin", "owner"]);
  if ("error" in auth) return auth.error;
  const url = new URL(request.url);
  const rawPeriod = url.searchParams.get("period");
  const period = rawPeriod === "weekly" || rawPeriod === "monthly" ? rawPeriod : "daily";
  const { start, end, endDateKey } = periodBounds(period, url.searchParams.get("date"));
  const requestedUserId = url.searchParams.get("userId");
  const db = await ensureDatabase();

  const clauses = ["md.recorded_at >= ?", "md.recorded_at < ?"];
  const values: unknown[] = [start, end];
  if (auth.user.role === "employee") {
    clauses.push("md.user_id = ?");
    values.push(auth.user.id);
  } else if (auth.user.role === "supervisor") {
    clauses.push("(u.supervisor_id = ? OR u.id = ?)");
    values.push(auth.user.id, auth.user.id);
    if (requestedUserId) { clauses.push("md.user_id = ?"); values.push(requestedUserId); }
  } else if (requestedUserId) {
    clauses.push("md.user_id = ?");
    values.push(requestedUserId);
  }

  const result = await db.prepare(`SELECT md.id, md.mission_id AS missionId, m.title AS missionTitle, md.user_id AS userId, u.full_name AS fullName,
    md.destination_name AS destinationName, md.latitude_e6 AS latitudeE6, md.longitude_e6 AS longitudeE6, md.accuracy_cm AS accuracyCm, md.recorded_at AS recordedAt
    FROM mission_destinations md JOIN missions m ON m.id = md.mission_id JOIN users u ON u.id = md.user_id
    WHERE ${clauses.join(" AND ")} ORDER BY md.user_id, md.recorded_at`).bind(...values).all<DestinationRow>();

  const counters = new Map<string, number>();
  const destinations = result.results.map((row) => {
    const dateKey = tehranDateKey(row.recordedAt);
    const counterKey = `${row.userId}:${dateKey}`;
    const sequence = (counters.get(counterKey) ?? 0) + 1;
    counters.set(counterKey, sequence);
    return {
      id: row.id, missionId: row.missionId, missionTitle: row.missionTitle, userId: row.userId, fullName: row.fullName,
      destinationName: row.destinationName, latitude: Number(row.latitudeE6) / 1_000_000, longitude: Number(row.longitudeE6) / 1_000_000,
      accuracy: Number(row.accuracyCm) / 100, recordedAt: row.recordedAt, dateKey, sequence,
    };
  });
  return Response.json({ period, endDateKey, start, end, destinations });
}
