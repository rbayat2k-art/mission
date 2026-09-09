import { ensureDatabase } from "../../../db/runtime";
import { requireRole } from "../../../lib/auth";
import { classifyLocationBatch, validDeviceSpeed, type ExistingLocationEvent, type IncomingLocationPoint, type LocationSessionWindow } from "../../../lib/location-batch";
import { MAX_LOCATION_FUTURE_SKEW_MS, MAX_TRUSTED_LOCATION_ACCURACY_METERS } from "../../../lib/mission-location";
import { createManagerIntegrityNotifications } from "../../../lib/push-notifications";
import { GPS_GAP_GRACE_MINUTES, reconcileNineHourLimit } from "../../../lib/work-session-policy";

export async function POST(request: Request) {
  const auth = await requireRole(request, ["employee", "supervisor", "admin", "owner"]);
  if ("error" in auth) return auth.error;
  const expectedUserId = request.headers.get("x-tapra-user-id")?.trim();
  if (expectedUserId && expectedUserId !== auth.user.id) {
    return Response.json({ error: "حساب فعال برنامه با نشست سرور یکسان نیست." }, { status: 409 });
  }

  const body = await request.json().catch(() => ({})) as { points?: IncomingLocationPoint[] };
  const incomingPoints = Array.isArray(body?.points) ? body.points.slice(0, 100).filter(point => point && typeof point === "object" && !Array.isArray(point)) : [];
  if (!incomingPoints.length) return Response.json({ error: "نقطه موقعیت معتبری دریافت نشد." }, { status: 400 });

  const db = await ensureDatabase();
  const receivedAt = new Date().toISOString();
  const activeSession = await db.prepare("SELECT id, user_id AS userId, started_at AS startedAt, ended_at AS endedAt, status FROM work_sessions WHERE user_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1")
    .bind(auth.user.id).first<LocationSessionWindow>();
  const explicitSessionIds = [...new Set(incomingPoints.map((point) => typeof point.workSessionId === "string" ? point.workSessionId.trim() : "").filter(Boolean))];
  const sessionPlaceholders = explicitSessionIds.map(() => "?").join(", ");
  const sessionResult = explicitSessionIds.length
    ? await db.prepare(`SELECT id, user_id AS userId, started_at AS startedAt, ended_at AS endedAt, status FROM work_sessions WHERE (user_id = ? AND status = 'active') OR id IN (${sessionPlaceholders})`).bind(auth.user.id, ...explicitSessionIds).all<LocationSessionWindow>()
    : await db.prepare("SELECT id, user_id AS userId, started_at AS startedAt, ended_at AS endedAt, status FROM work_sessions WHERE user_id = ? AND status = 'active'").bind(auth.user.id).all<LocationSessionWindow>();

  const eventIds = [...new Set(incomingPoints.map((point) => typeof point.clientEventId === "string" ? point.clientEventId.trim() : "").filter(Boolean))];
  const eventPlaceholders = eventIds.map(() => "?").join(", ");
  const existingResult = eventIds.length
    ? await db.prepare(`SELECT client_event_id AS clientEventId, user_id AS userId, work_session_id AS workSessionId FROM location_points WHERE client_event_id IN (${eventPlaceholders})`).bind(...eventIds).all<ExistingLocationEvent>()
    : { results: [] as ExistingLocationEvent[] };
  const classification = classifyLocationBatch({
    points: incomingPoints,
    userId: auth.user.id,
    sessions: sessionResult.results,
    activeSessionId: activeSession?.id ?? null,
    existingEvents: existingResult.results,
    receivedAt,
    clockSkewMs: MAX_LOCATION_FUTURE_SKEW_MS,
  });

  const acceptedIds: string[] = [];
  const raceDuplicateIds: string[] = [];
  await db.transaction(async (transaction) => {
    for (const point of classification.candidates) {
      const inserted = await transaction.prepare("INSERT IGNORE INTO location_points (id, client_event_id, user_id, work_session_id, latitude_e6, longitude_e6, accuracy_cm, altitude_cm, speed_cms, heading_deg, recorded_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(
        crypto.randomUUID(), point.clientEventId, auth.user.id, point.workSessionId,
        Math.round(point.latitude * 1_000_000), Math.round(point.longitude * 1_000_000), Math.round(point.accuracy * 100),
        point.altitude == null ? null : Math.round(point.altitude * 100), point.speed == null ? null : Math.round(point.speed * 100), point.heading == null ? null : Math.round(point.heading),
        point.recordedAt, receivedAt,
      ).run();
      if ((inserted.meta.changes ?? 0) > 0) acceptedIds.push(point.clientEventId);
      else raceDuplicateIds.push(point.clientEventId);
    }
  });

  const acceptedSet = new Set(acceptedIds);
  const acceptedPoints = classification.candidates.filter((point) => acceptedSet.has(point.clientEventId));
  const gapNotifications: { id:string; gapMinutes:number }[] = [];
  for (const sessionId of [...new Set(acceptedPoints.map((point) => point.workSessionId))]) {
    const sessionPoints = acceptedPoints.filter((point) => point.workSessionId === sessionId).sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
    const trusted = sessionPoints.filter((point) => point.accuracy <= MAX_TRUSTED_LOCATION_ACCURACY_METERS);
    const firstRecorded = trusted[0]?.recordedAt;
    const latestTrusted = trusted[trusted.length - 1];
    if (activeSession?.id === sessionId) {
      await db.prepare(`INSERT INTO tracking_presence
        (work_session_id, user_id, last_contact_at, last_contact_source, last_trusted_gps_at, last_trusted_gps_received_at, created_at, updated_at)
        VALUES (?, ?, ?, 'gps', ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), last_contact_at = VALUES(last_contact_at),
          last_contact_source = 'gps',
          last_trusted_gps_at = IF(VALUES(last_trusted_gps_at) IS NULL, last_trusted_gps_at,
            IF(last_trusted_gps_at IS NULL OR last_trusted_gps_at < VALUES(last_trusted_gps_at), VALUES(last_trusted_gps_at), last_trusted_gps_at)),
          last_trusted_gps_received_at = IF(VALUES(last_trusted_gps_at) IS NULL, last_trusted_gps_received_at, VALUES(last_trusted_gps_received_at)),
          updated_at = VALUES(updated_at)`)
        .bind(sessionId, auth.user.id, receivedAt, latestTrusted?.recordedAt ?? null, latestTrusted ? receivedAt : null, receivedAt, receivedAt).run();
    }
    if (firstRecorded) {
      const previous = await db.prepare("SELECT recorded_at AS recordedAt FROM location_points WHERE user_id = ? AND work_session_id = ? AND accuracy_cm <= ? AND recorded_at < ? ORDER BY recorded_at DESC LIMIT 1")
        .bind(auth.user.id, sessionId, MAX_TRUSTED_LOCATION_ACCURACY_METERS * 100, firstRecorded).first<{ recordedAt:string }>();
      if (previous && Date.parse(firstRecorded) - Date.parse(previous.recordedAt) > GPS_GAP_GRACE_MINUTES * 60_000) {
        const gapMinutes = Math.round((Date.parse(firstRecorded) - Date.parse(previous.recordedAt)) / 60_000);
        const eventId = crypto.randomUUID();
        await db.prepare("INSERT INTO integrity_events (id, user_id, work_session_id, type, severity, details, occurred_at, created_at) VALUES (?, ?, ?, 'gps_gap', 'high', ?, ?, ?)").bind(
          eventId, auth.user.id, sessionId, JSON.stringify({ previousAt:previous.recordedAt, resumedAt:firstRecorded, gapMinutes, graceMinutes:GPS_GAP_GRACE_MINUTES, deductedMinutes:Math.max(0, gapMinutes-GPS_GAP_GRACE_MINUTES) }), firstRecorded, receivedAt,
        ).run();
        gapNotifications.push({ id:eventId, gapMinutes });
      }
    }
    const inaccurate = sessionPoints.find((point) => point.accuracy > MAX_TRUSTED_LOCATION_ACCURACY_METERS);
    if (inaccurate) {
      await db.prepare("INSERT INTO integrity_events (id, user_id, work_session_id, type, severity, details, occurred_at, created_at) VALUES (?, ?, ?, 'low_accuracy', 'medium', ?, ?, ?)").bind(
        crypto.randomUUID(), auth.user.id, sessionId, JSON.stringify({ accuracy:Math.round(inaccurate.accuracy) }), inaccurate.recordedAt, receivedAt,
      ).run();
    }
  }
  for (const gapNotification of gapNotifications) await createManagerIntegrityNotifications(auth.user.id, {
    type:"gps_gap", title:"وقفه GPS کارمند ثبت شد",
    message:`${auth.user.fullName}: ثبت GPS پس از ${gapNotification.gapMinutes.toLocaleString("fa-IR")} دقیقه از سر گرفته شد.`,
    entityId:gapNotification.id, url:"/?panel=admin&screen=integrity",
  });

  const mockedRejections = classification.permanentRejected.filter((item) => item.reason === "mock_location");
  let mockNotification: { id:string; count:number } | null = null;
  if (mockedRejections.length && activeSession) {
    const existing = await db.prepare("SELECT id FROM integrity_events WHERE user_id = ? AND work_session_id = ? AND type = 'mock_location_detected' AND status = 'open' ORDER BY created_at DESC LIMIT 1").bind(auth.user.id, activeSession.id).first<{id:string}>();
    if (!existing) {
      const eventId = crypto.randomUUID();
      await db.prepare("INSERT INTO integrity_events (id, user_id, work_session_id, type, severity, details, occurred_at, created_at) VALUES (?, ?, ?, 'mock_location_detected', 'high', ?, ?, ?)").bind(
        eventId, auth.user.id, activeSession.id, JSON.stringify({ rejectedPoints: mockedRejections.length, providerReportedMock: true }), receivedAt, receivedAt,
      ).run();
      mockNotification = { id:eventId, count:mockedRejections.length };
    }
  }
  if (mockNotification) await createManagerIntegrityNotifications(auth.user.id, {
    type:"mock_location_detected", title:"موقعیت غیرواقعی شناسایی شد",
    message:`${auth.user.fullName}: برنامه اندروید ${mockNotification.count.toLocaleString("fa-IR")} نقطه GPS جعلی را رد کرد.`,
    entityId:mockNotification.id, url:"/?panel=admin&screen=integrity",
  });

  const duplicateIds = [...new Set([...classification.duplicateIds, ...raceDuplicateIds])].filter((id) => !acceptedSet.has(id));
  const reconciliation = activeSession ? await reconcileNineHourLimit(auth.user.id, new Date(receivedAt)) : { autoEnded:false, endedAt:null };
  return Response.json({
    accepted: acceptedIds.length,
    acceptedIds,
    duplicateIds,
    permanentRejected: classification.permanentRejected,
    retryableRejected: classification.retryableRejected,
    unidentifiedRejected: classification.unidentifiedRejected,
    receivedAt,
    autoEnded: reconciliation.autoEnded,
    endedAt: reconciliation.autoEnded ? reconciliation.endedAt : null,
  }, { status: 201 });
}

export async function GET(request: Request) {
  const auth = await requireRole(request, ["employee", "supervisor", "admin", "owner"]);
  if ("error" in auth) return auth.error;
  const db = await ensureDatabase();
  const url = new URL(request.url);
  const requestedUser = url.searchParams.get("userId");
  const mode = url.searchParams.get("mode") === "last" ? "last" : "live";
  const canViewTeam = ["owner", "admin", "supervisor"].includes(auth.user.role);
  const userId = canViewTeam ? requestedUser : auth.user.id;
  const liveSince = new Date(Date.now() - 2 * 60_000).toISOString();

  const baseSelect = `SELECT lp.id, lp.user_id AS userId, u.full_name AS fullName, lp.work_session_id AS workSessionId, lp.latitude_e6 AS latitudeE6, lp.longitude_e6 AS longitudeE6, lp.accuracy_cm AS accuracyCm, lp.speed_cms AS speedCms, lp.recorded_at AS recordedAt, lp.received_at AS receivedAt, ws.status AS workSessionStatus FROM location_points lp JOIN users u ON u.id = lp.user_id JOIN work_sessions ws ON ws.id = lp.work_session_id`;
  const trustedAccuracy = MAX_TRUSTED_LOCATION_ACCURACY_METERS * 100;
  const latestLivePoint = `lp.id = (SELECT latest.id FROM location_points latest JOIN work_sessions latest_ws ON latest_ws.id = latest.work_session_id WHERE latest.user_id = lp.user_id AND latest.accuracy_cm <= ${trustedAccuracy} AND latest_ws.status = 'active' AND latest.recorded_at >= ? ORDER BY latest.recorded_at DESC LIMIT 1)`;
  const latestAnyPoint = `lp.id = (SELECT latest.id FROM location_points latest WHERE latest.user_id = lp.user_id AND latest.accuracy_cm <= ${trustedAccuracy} ORDER BY latest.recorded_at DESC, latest.received_at DESC LIMIT 1)`;
  let result;
  if (auth.user.role === "supervisor") {
    if (userId) {
      const allowed = await db.prepare("SELECT id FROM users WHERE id = ? AND (supervisor_id = ? OR id = ?)").bind(userId, auth.user.id, auth.user.id).first();
      if (!allowed) return Response.json({ error: "forbidden" }, { status: 403 });
      result = await db.prepare(`${baseSelect} WHERE lp.user_id = ? AND lp.accuracy_cm <= ? ORDER BY lp.recorded_at DESC LIMIT 250`).bind(userId, trustedAccuracy).all<Record<string, number | string | null>>();
    } else if (mode === "last") {
      result = await db.prepare(`${baseSelect} WHERE (u.supervisor_id = ? OR u.id = ?) AND u.status = 'active' AND ${latestAnyPoint} ORDER BY lp.recorded_at DESC`).bind(auth.user.id, auth.user.id).all<Record<string, number | string | null>>();
    } else {
      result = await db.prepare(`${baseSelect} WHERE (u.supervisor_id = ? OR u.id = ?) AND u.status = 'active' AND ws.status = 'active' AND lp.recorded_at >= ? AND ${latestLivePoint} ORDER BY lp.recorded_at DESC`).bind(auth.user.id, auth.user.id, liveSince, liveSince).all<Record<string, number | string | null>>();
    }
  } else {
    result = userId
      ? await db.prepare(`${baseSelect} WHERE lp.user_id = ? AND lp.accuracy_cm <= ? ORDER BY lp.recorded_at DESC LIMIT 250`).bind(userId, trustedAccuracy).all<Record<string, number | string | null>>()
      : mode === "last"
        ? await db.prepare(`${baseSelect} WHERE u.status = 'active' AND ${latestAnyPoint} ORDER BY lp.recorded_at DESC`).all<Record<string, number | string | null>>()
        : await db.prepare(`${baseSelect} WHERE u.status = 'active' AND ws.status = 'active' AND lp.recorded_at >= ? AND ${latestLivePoint} ORDER BY lp.recorded_at DESC`).bind(liveSince, liveSince).all<Record<string, number | string | null>>();
  }

  const freshnessThreshold = Date.now() - 2 * 60_000;
  return Response.json({ mode, locations: result.results.map((row) => {
    const recordedAt = String(row.recordedAt);
    return {
      id: row.id, userId: row.userId, fullName: row.fullName, workSessionId: row.workSessionId,
      latitude: Number(row.latitudeE6) / 1_000_000, longitude: Number(row.longitudeE6) / 1_000_000,
      accuracy: Number(row.accuracyCm) / 100, speed: row.speedCms == null ? null : validDeviceSpeed(Number(row.speedCms) / 100),
      recordedAt, receivedAt: row.receivedAt, workSessionStatus: row.workSessionStatus,
      isLive: row.workSessionStatus === "active" && Date.parse(recordedAt) >= freshnessThreshold,
    };
  }) });
}
