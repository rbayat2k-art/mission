import { ensureDatabase } from "../../../db/runtime";
import { requireRole } from "../../../lib/auth";
import { GPS_GAP_GRACE_MINUTES, reconcileNineHourLimit } from "../../../lib/work-session-policy";

type IncomingPoint = {
  clientEventId?: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  altitude?: number | null;
  speed?: number | null;
  heading?: number | null;
  recordedAt?: string;
};

function validPoint(point: IncomingPoint) {
  return typeof point.clientEventId === "string" && point.clientEventId.length >= 8 &&
    Number.isFinite(point.latitude) && Number.isFinite(point.longitude) && Number.isFinite(point.accuracy) &&
    point.latitude! >= -90 && point.latitude! <= 90 && point.longitude! >= -180 && point.longitude! <= 180 &&
    point.accuracy! >= 0 && point.accuracy! <= 10_000 && !Number.isNaN(Date.parse(point.recordedAt ?? ""));
}

export async function POST(request: Request) {
  const auth = await requireRole(request, ["employee", "supervisor", "admin", "owner"]);
  if ("error" in auth) return auth.error;
  const body = await request.json().catch(() => ({})) as { points?: IncomingPoint[] };
  const points = (body.points ?? []).filter(validPoint).slice(0, 100).sort((a, b) => Date.parse(a.recordedAt!) - Date.parse(b.recordedAt!));
  if (!points.length) return Response.json({ error: "نقطه موقعیت معتبری دریافت نشد." }, { status: 400 });

  const db = await ensureDatabase();
  const session = await db.prepare("SELECT id FROM work_sessions WHERE user_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1").bind(auth.user.id).first<{ id: string }>();
  if (!session) return Response.json({ error: "برای ثبت موقعیت باید فعالیت باز باشد." }, { status: 409 });

  const receivedAt = new Date().toISOString();
  const previous = await db.prepare("SELECT recorded_at AS recordedAt FROM location_points WHERE user_id = ? AND work_session_id = ? ORDER BY recorded_at DESC LIMIT 1").bind(auth.user.id, session.id).first<{ recordedAt: string }>();
  const statements = points.map((point) => db.prepare("INSERT IGNORE INTO location_points (id, client_event_id, user_id, work_session_id, latitude_e6, longitude_e6, accuracy_cm, altitude_cm, speed_cms, heading_deg, recorded_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(
    crypto.randomUUID(), point.clientEventId!, auth.user.id, session.id,
    Math.round(point.latitude! * 1_000_000), Math.round(point.longitude! * 1_000_000), Math.round(point.accuracy! * 100),
    point.altitude == null ? null : Math.round(point.altitude * 100), point.speed == null ? null : Math.round(point.speed * 100), point.heading == null ? null : Math.round(point.heading),
    new Date(point.recordedAt!).toISOString(), receivedAt,
  ));

  const firstRecorded = new Date(points[0].recordedAt!).toISOString();
  if (previous && Date.parse(firstRecorded) - Date.parse(previous.recordedAt) > GPS_GAP_GRACE_MINUTES * 60_000) {
    const gapMinutes = Math.round((Date.parse(firstRecorded) - Date.parse(previous.recordedAt)) / 60_000);
    statements.push(db.prepare("INSERT INTO integrity_events (id, user_id, work_session_id, type, severity, details, occurred_at, created_at) VALUES (?, ?, ?, 'gps_gap', 'high', ?, ?, ?)").bind(
      crypto.randomUUID(), auth.user.id, session.id, JSON.stringify({ previousAt: previous.recordedAt, resumedAt: firstRecorded, gapMinutes, graceMinutes: GPS_GAP_GRACE_MINUTES, deductedMinutes: Math.max(0, gapMinutes - GPS_GAP_GRACE_MINUTES) }), firstRecorded, receivedAt,
    ));
  }
  const inaccurate = points.find((point) => point.accuracy! > 100);
  if (inaccurate) {
    statements.push(db.prepare("INSERT INTO integrity_events (id, user_id, work_session_id, type, severity, details, occurred_at, created_at) VALUES (?, ?, ?, 'low_accuracy', 'medium', ?, ?, ?)").bind(
      crypto.randomUUID(), auth.user.id, session.id, JSON.stringify({ accuracy: Math.round(inaccurate.accuracy!) }), inaccurate.recordedAt!, receivedAt,
    ));
  }
  await db.batch(statements);
  const reconciliation = await reconcileNineHourLimit(auth.user.id, new Date(receivedAt));
  return Response.json({ accepted: points.length, receivedAt, autoEnded: reconciliation.autoEnded, endedAt: reconciliation.autoEnded ? reconciliation.endedAt : null }, { status: 201 });
}

export async function GET(request: Request) {
  const auth = await requireRole(request, ["employee", "supervisor", "admin", "owner"]);
  if ("error" in auth) return auth.error;
  const db = await ensureDatabase();
  const url = new URL(request.url);
  const requestedUser = url.searchParams.get("userId");
  const canViewTeam = ["owner", "admin", "supervisor"].includes(auth.user.role);
  const userId = canViewTeam ? requestedUser : auth.user.id;
  const liveSince = new Date(Date.now() - 2 * 60_000).toISOString();

  const baseSelect = `SELECT lp.id, lp.user_id AS userId, u.full_name AS fullName, lp.work_session_id AS workSessionId, lp.latitude_e6 AS latitudeE6, lp.longitude_e6 AS longitudeE6, lp.accuracy_cm AS accuracyCm, lp.speed_cms AS speedCms, lp.recorded_at AS recordedAt, lp.received_at AS receivedAt FROM location_points lp JOIN users u ON u.id = lp.user_id JOIN work_sessions ws ON ws.id = lp.work_session_id`;
  const latestLivePoint = `lp.id = (SELECT latest.id FROM location_points latest JOIN work_sessions latest_ws ON latest_ws.id = latest.work_session_id WHERE latest.user_id = lp.user_id AND latest_ws.status = 'active' AND latest.recorded_at >= ? ORDER BY latest.recorded_at DESC LIMIT 1)`;
  let result;
  if (auth.user.role === "supervisor") {
    if (userId) {
      const allowed = await db.prepare("SELECT id FROM users WHERE id = ? AND (supervisor_id = ? OR id = ?)").bind(userId, auth.user.id, auth.user.id).first();
      if (!allowed) return Response.json({ error: "forbidden" }, { status: 403 });
      result = await db.prepare(`${baseSelect} WHERE lp.user_id = ? ORDER BY lp.recorded_at DESC LIMIT 250`).bind(userId).all<Record<string, number | string | null>>();
    } else {
      result = await db.prepare(`${baseSelect} WHERE (u.supervisor_id = ? OR u.id = ?) AND u.status = 'active' AND ws.status = 'active' AND lp.recorded_at >= ? AND ${latestLivePoint} ORDER BY lp.recorded_at DESC`).bind(auth.user.id, auth.user.id, liveSince, liveSince).all<Record<string, number | string | null>>();
    }
  } else {
    result = userId
      ? await db.prepare(`${baseSelect} WHERE lp.user_id = ? ORDER BY lp.recorded_at DESC LIMIT 250`).bind(userId).all<Record<string, number | string | null>>()
      : await db.prepare(`${baseSelect} WHERE u.status = 'active' AND ws.status = 'active' AND lp.recorded_at >= ? AND ${latestLivePoint} ORDER BY lp.recorded_at DESC`).bind(liveSince, liveSince).all<Record<string, number | string | null>>();
  }

  return Response.json({ locations: result.results.map((row) => ({
    id: row.id, userId: row.userId, fullName: row.fullName, workSessionId: row.workSessionId,
    latitude: Number(row.latitudeE6) / 1_000_000, longitude: Number(row.longitudeE6) / 1_000_000,
    accuracy: Number(row.accuracyCm) / 100, speed: row.speedCms == null ? null : Number(row.speedCms) / 100,
    recordedAt: row.recordedAt, receivedAt: row.receivedAt,
  })) });
}
