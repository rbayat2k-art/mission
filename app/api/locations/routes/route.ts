import { ensureDatabase } from "../../../../db/runtime";
import { requireRole } from "../../../../lib/auth";
import {
  buildHistoricalRoute,
  HISTORICAL_ROUTE_GAP_MS,
  HISTORICAL_ROUTE_MAX_POINTS_PER_USER,
  HISTORICAL_ROUTE_MAX_SPEED_KMH,
  HISTORICAL_ROUTE_MAX_TOTAL_POINTS,
  HISTORICAL_ROUTE_RETENTION_DAYS,
  HISTORICAL_ROUTE_STOP_MINIMUM_MS,
  HISTORICAL_ROUTE_STOP_RADIUS_METERS,
  resolveHistoricalRouteDay,
  type StoredHistoricalRoutePoint,
} from "../../../../lib/historical-route";
import { MAX_TRUSTED_LOCATION_ACCURACY_METERS } from "../../../../lib/mission-location";

const noStoreHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "Pragma": "no-cache",
  "Vary": "Cookie",
};
const ROUTE_QUERY_MAX_LENGTH = 192;
const ROUTE_MAX_STOPS = 500;
const ROUTE_MAX_GAPS = 500;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalidDateMessage(reason: "invalid_date" | "future_date" | "outside_retention") {
  if (reason === "future_date") return "تاریخ آینده برای مسیر قابل انتخاب نیست.";
  if (reason === "outside_retention") return `مسیر فقط تا ${HISTORICAL_ROUTE_RETENTION_DAYS.toLocaleString("fa-IR")} روز گذشته نگهداری می‌شود.`;
  return "تاریخ مسیر باید با قالب YYYY-MM-DD و معتبر باشد.";
}

export async function GET(request: Request) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor"]);
  if ("error" in auth) return auth.error;

  const url = new URL(request.url);
  if (url.search.length > ROUTE_QUERY_MAX_LENGTH || [...url.searchParams.keys()].some((key) => key !== "date" && key !== "userId")) {
    return Response.json({ error: "پارامترهای درخواست مسیر معتبر نیستند." }, { status: 400, headers: noStoreHeaders });
  }
  const day = resolveHistoricalRouteDay(url.searchParams.get("date"), new Date());
  if (!day.ok) return Response.json({ error: invalidDateMessage(day.reason) }, { status: 400, headers: noStoreHeaders });
  const requestedUserId = url.searchParams.get("userId")?.trim() || null;
  if (requestedUserId && !UUID_PATTERN.test(requestedUserId)) {
    return Response.json({ error: "شناسه کاربر معتبر نیست." }, { status: 400, headers: noStoreHeaders });
  }

  const db = await ensureDatabase();
  if (auth.user.role === "supervisor" && requestedUserId) {
    const allowed = await db.prepare(`SELECT id FROM users WHERE id = ? AND
      (id = ? OR (supervisor_id = ? AND role = 'employee' AND status = 'active'))`)
      .bind(requestedUserId, auth.user.id, auth.user.id).first();
    if (!allowed) return Response.json({ error: "forbidden" }, { status: 403, headers: noStoreHeaders });
  }

  const trustedAccuracy = MAX_TRUSTED_LOCATION_ACCURACY_METERS * 100;
  const baseQuery = `SELECT lp.id, lp.user_id AS userId, u.full_name AS fullName,
    lp.work_session_id AS workSessionId, lp.latitude_e6 AS latitudeE6,
    lp.longitude_e6 AS longitudeE6, lp.accuracy_cm AS accuracyCm,
    lp.speed_cms AS speedCms, lp.recorded_at AS recordedAt
    FROM location_points lp
    JOIN users u ON u.id = lp.user_id
    JOIN work_sessions ws ON ws.id = lp.work_session_id
    JOIN (
      SELECT sampled.user_id, sampled.work_session_id,
        MIN(CONCAT(sampled.recorded_at, '#', sampled.id)) AS firstKey,
        MAX(CONCAT(sampled.recorded_at, '#', sampled.id)) AS lastKey
      FROM location_points sampled
      WHERE sampled.accuracy_cm <= ? AND sampled.recorded_at >= ? AND sampled.recorded_at < ?
      GROUP BY sampled.user_id, sampled.work_session_id, LEFT(sampled.recorded_at, 16)
    ) sample ON sample.user_id = lp.user_id AND sample.work_session_id = lp.work_session_id
      AND CONCAT(lp.recorded_at, '#', lp.id) IN (sample.firstKey, sample.lastKey)
    WHERE lp.accuracy_cm <= ? AND lp.recorded_at >= ? AND lp.recorded_at < ?`;
  const commonBindings = [trustedAccuracy, day.start, day.end, trustedAccuracy, day.start, day.end];

  let rows: StoredHistoricalRoutePoint[];
  if (auth.user.role === "supervisor") {
    const userFilter = requestedUserId ? " AND u.id = ?" : "";
    rows = (await db.prepare(`${baseQuery} AND
      (u.id = ? OR (u.supervisor_id = ? AND u.role = 'employee' AND u.status = 'active'))${userFilter}
      ORDER BY lp.user_id, lp.recorded_at, lp.received_at LIMIT ?`)
      .bind(...commonBindings, auth.user.id, auth.user.id, ...(requestedUserId ? [requestedUserId] : []), HISTORICAL_ROUTE_MAX_TOTAL_POINTS + 1)
      .all<StoredHistoricalRoutePoint>()).results;
  } else {
    const userFilter = requestedUserId ? " AND u.id = ?" : "";
    rows = (await db.prepare(`${baseQuery}${userFilter} ORDER BY lp.user_id, lp.recorded_at, lp.received_at LIMIT ?`)
      .bind(...commonBindings, ...(requestedUserId ? [requestedUserId] : []), HISTORICAL_ROUTE_MAX_TOTAL_POINTS + 1)
      .all<StoredHistoricalRoutePoint>()).results;
  }

  const queryTruncated = rows.length > HISTORICAL_ROUTE_MAX_TOTAL_POINTS;
  const route = buildHistoricalRoute(rows.slice(0, HISTORICAL_ROUTE_MAX_TOTAL_POINTS));
  const stopsTruncated = route.stops.length > ROUTE_MAX_STOPS;
  const gapsTruncated = route.gpsGaps.length > ROUTE_MAX_GAPS;
  return Response.json({
    date: day.date,
    range: { start: day.start, end: day.end, oldestDate: day.oldestDate, retentionDays: HISTORICAL_ROUTE_RETENTION_DAYS },
    selectedUserId: requestedUserId,
    rules: {
      maxAccuracyMeters: MAX_TRUSTED_LOCATION_ACCURACY_METERS,
      gapMinutes: HISTORICAL_ROUTE_GAP_MS / 60_000,
      stopRadiusMeters: HISTORICAL_ROUTE_STOP_RADIUS_METERS,
      stopMinimumMinutes: HISTORICAL_ROUTE_STOP_MINIMUM_MS / 60_000,
      maxSpeedKmh: HISTORICAL_ROUTE_MAX_SPEED_KMH,
      maxPointsPerUser: route.perUserBudget,
      configuredMaxPointsPerUser: HISTORICAL_ROUTE_MAX_POINTS_PER_USER,
      maxTotalPoints: HISTORICAL_ROUTE_MAX_TOTAL_POINTS,
    },
    truncatedUsers: route.truncatedUsers,
    segments: route.segments,
    stops: route.stops.slice(0, ROUTE_MAX_STOPS),
    gpsGaps: route.gpsGaps.slice(0, ROUTE_MAX_GAPS),
    coverage: {
      ...route.coverage,
      stopCount: Math.min(route.coverage.stopCount, ROUTE_MAX_STOPS),
      gapCount: Math.min(route.coverage.gapCount, ROUTE_MAX_GAPS),
      truncated: route.coverage.truncated || queryTruncated || stopsTruncated || gapsTruncated,
    },
  }, { headers: noStoreHeaders });
}
