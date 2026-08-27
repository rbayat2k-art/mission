import { ensureDatabase } from "../../../../db/runtime";
import { requireRole } from "../../../../lib/auth";
import { distanceMeters, MAX_TRUSTED_LOCATION_ACCURACY_METERS } from "../../../../lib/mission-location";
import { tehranDayBounds } from "../../../../lib/work-session-policy";

const ROUTE_GAP_MS = 2 * 60_000;
const MAX_ROUTE_SPEED_KMH = 160;
const MAX_POINTS_PER_USER = 900;
const MAX_TOTAL_POINTS = 12_000;

type StoredRoutePoint = {
  id: string;
  userId: string;
  fullName: string;
  workSessionId: string;
  latitudeE6: number;
  longitudeE6: number;
  accuracyCm: number;
  speedCms: number | null;
  recordedAt: string;
};

type RoutePoint = {
  id: string;
  latitude: number;
  longitude: number;
  accuracy: number;
  speed: number | null;
  recordedAt: string;
};

type RouteSegment = {
  id: string;
  userId: string;
  fullName: string;
  workSessionId: string;
  points: RoutePoint[];
};

function splitIntoSegments(rows: StoredRoutePoint[]) {
  const segments: RouteSegment[] = [];
  let current: RouteSegment | null = null;
  let previous: RoutePoint | null = null;

  for (const row of rows) {
    const point: RoutePoint = {
      id: row.id,
      latitude: Number(row.latitudeE6) / 1_000_000,
      longitude: Number(row.longitudeE6) / 1_000_000,
      accuracy: Number(row.accuracyCm) / 100,
      speed: row.speedCms == null ? null : Number(row.speedCms) / 100,
      recordedAt: row.recordedAt,
    };
    const elapsedMs = previous ? Date.parse(point.recordedAt) - Date.parse(previous.recordedAt) : 0;
    const calculatedSpeedKmh = previous && elapsedMs > 0
      ? distanceMeters(previous, point) / (elapsedMs / 1000) * 3.6
      : 0;
    const shouldSplit = !current || current.userId !== row.userId || current.workSessionId !== row.workSessionId ||
      !previous || elapsedMs <= 0 || elapsedMs > ROUTE_GAP_MS || calculatedSpeedKmh > MAX_ROUTE_SPEED_KMH ||
      (point.speed != null && point.speed * 3.6 > MAX_ROUTE_SPEED_KMH);

    if (shouldSplit) {
      current = {
        id: `${row.userId}:${row.workSessionId}:${point.id}`,
        userId: row.userId,
        fullName: row.fullName,
        workSessionId: row.workSessionId,
        points: [],
      };
      segments.push(current);
    }
    if (!current) continue;
    current.points.push(point);
    previous = point;
  }
  return segments;
}

function simplifyPoints(points: RoutePoint[], maxPoints: number) {
  if (points.length <= maxPoints) return points;
  if (maxPoints <= 2) return [points[0], points[points.length - 1]];
  const lastIndex = points.length - 1;
  const result = [points[0]];
  for (let index = 1; index < maxPoints - 1; index += 1) {
    result.push(points[Math.round(index * lastIndex / (maxPoints - 1))]);
  }
  result.push(points[lastIndex]);
  return result;
}

function capSegments(segments: RouteSegment[], maxPoints: number) {
  let drawable = segments.filter((segment) => segment.points.length >= 2);
  const maxSegmentCount = Math.max(1, Math.floor(maxPoints / 2));
  if (drawable.length > maxSegmentCount) drawable = drawable.slice(-maxSegmentCount);

  const minimumPoints = drawable.length * 2;
  const remaining = Math.max(0, maxPoints - minimumPoints);
  const totalExtra = drawable.reduce((sum, segment) => sum + Math.max(0, segment.points.length - 2), 0);
  const budgets = drawable.map((segment) => 2 + (totalExtra
    ? Math.floor(remaining * Math.max(0, segment.points.length - 2) / totalExtra)
    : 0));
  let allocated = budgets.reduce((sum, budget) => sum + budget, 0);
  for (let index = 0; allocated < maxPoints && index < drawable.length; index = (index + 1) % drawable.length) {
    if (budgets[index] < drawable[index].points.length) {
      budgets[index] += 1;
      allocated += 1;
    } else if (drawable.every((segment, segmentIndex) => budgets[segmentIndex] >= segment.points.length)) break;
  }
  return drawable.map((segment, index) => ({ ...segment, points: simplifyPoints(segment.points, budgets[index]) }));
}

export async function GET(request: Request) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor"]);
  if ("error" in auth) return auth.error;

  const db = await ensureDatabase();
  const { start, end } = tehranDayBounds(new Date());
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
    WHERE u.status = 'active'
      AND lp.accuracy_cm <= ? AND lp.recorded_at >= ? AND lp.recorded_at < ?`;

  const result = auth.user.role === "supervisor"
    ? await db.prepare(`${baseQuery} AND (u.id = ? OR (u.supervisor_id = ? AND u.role = 'employee')) ORDER BY lp.user_id, lp.recorded_at, lp.received_at`)
      .bind(trustedAccuracy, start, end, trustedAccuracy, start, end, auth.user.id, auth.user.id).all<StoredRoutePoint>()
    : await db.prepare(`${baseQuery} ORDER BY lp.user_id, lp.recorded_at, lp.received_at`)
      .bind(trustedAccuracy, start, end, trustedAccuracy, start, end).all<StoredRoutePoint>();

  const rawSegments = splitIntoSegments(result.results);
  const userIds = [...new Set(rawSegments.map((segment) => segment.userId))];
  const includedUserIds = userIds.slice(0, Math.floor(MAX_TOTAL_POINTS / 2));
  const perUserBudget = Math.max(2, Math.min(MAX_POINTS_PER_USER, Math.floor(MAX_TOTAL_POINTS / Math.max(1, includedUserIds.length))));
  const segments = includedUserIds.flatMap((userId) => capSegments(rawSegments.filter((segment) => segment.userId === userId), perUserBudget));

  return Response.json({
    date: start,
    rules: { maxAccuracyMeters: MAX_TRUSTED_LOCATION_ACCURACY_METERS, gapMinutes: 2, maxSpeedKmh: MAX_ROUTE_SPEED_KMH, maxPointsPerUser: perUserBudget, maxTotalPoints: MAX_TOTAL_POINTS },
    truncatedUsers: userIds.length - includedUserIds.length,
    segments,
  }, { headers: { "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache", "Vary": "Cookie" } });
}
