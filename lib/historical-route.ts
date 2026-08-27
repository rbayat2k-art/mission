export const HISTORICAL_ROUTE_RETENTION_DAYS = 90;
export const HISTORICAL_ROUTE_GAP_MS = 2 * 60_000;
export const HISTORICAL_ROUTE_STOP_RADIUS_METERS = 50;
export const HISTORICAL_ROUTE_STOP_MINIMUM_MS = 5 * 60_000;
export const HISTORICAL_ROUTE_MAX_SPEED_KMH = 160;
export const HISTORICAL_ROUTE_MAX_POINTS_PER_USER = 900;
export const HISTORICAL_ROUTE_MAX_TOTAL_POINTS = 12_000;

const TEHRAN_OFFSET = "+03:30";
const DAY_MS = 86_400_000;

function distanceMeters(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const earthRadiusMeters = 6_371_000;
  const latitudeDelta = radians(to.latitude - from.latitude);
  const longitudeDelta = radians(to.longitude - from.longitude);
  const fromLatitude = radians(from.latitude);
  const toLatitude = radians(to.latitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

export type StoredHistoricalRoutePoint = {
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

export type HistoricalRoutePoint = {
  id: string;
  latitude: number;
  longitude: number;
  accuracy: number;
  speed: number | null;
  recordedAt: string;
};

export type HistoricalRouteSegment = {
  id: string;
  userId: string;
  fullName: string;
  workSessionId: string;
  points: HistoricalRoutePoint[];
};

export type HistoricalRouteStop = {
  id: string;
  userId: string;
  fullName: string;
  workSessionId: string;
  latitude: number;
  longitude: number;
  startedAt: string;
  endedAt: string;
  durationMinutes: number;
  pointCount: number;
};

export type HistoricalRouteGap = {
  id: string;
  userId: string;
  fullName: string;
  workSessionId: string;
  from: HistoricalRoutePoint;
  to: HistoricalRoutePoint;
  startedAt: string;
  endedAt: string;
  durationMinutes: number;
};

export type HistoricalRouteCoverage = {
  status: "complete" | "partial" | "missing";
  sampledPointCount: number;
  returnedPointCount: number;
  userCount: number;
  gapCount: number;
  gapMinutes: number;
  stopCount: number;
  truncated: boolean;
  perUser: Array<{
    userId: string;
    fullName: string;
    sampledPointCount: number;
    returnedPointCount: number;
    gapCount: number;
    gapMinutes: number;
    stopCount: number;
    status: "complete" | "partial" | "missing";
  }>;
};

function dateKeyInTehran(value: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function dayStart(dateKey: string) {
  return new Date(`${dateKey}T00:00:00${TEHRAN_OFFSET}`);
}

export function resolveHistoricalRouteDay(requestedDate: string | null, now = new Date()) {
  const today = dateKeyInTehran(now);
  const date = requestedDate == null || requestedDate === "" ? today : requestedDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false as const, reason: "invalid_date" as const };
  const startDate = dayStart(date);
  if (!Number.isFinite(startDate.getTime()) || dateKeyInTehran(startDate) !== date) {
    return { ok: false as const, reason: "invalid_date" as const };
  }
  const todayStart = dayStart(today);
  const oldestStart = new Date(todayStart.getTime() - (HISTORICAL_ROUTE_RETENTION_DAYS - 1) * DAY_MS);
  if (startDate.getTime() > todayStart.getTime()) return { ok: false as const, reason: "future_date" as const };
  if (startDate.getTime() < oldestStart.getTime()) return { ok: false as const, reason: "outside_retention" as const };
  return {
    ok: true as const,
    date,
    today,
    start: startDate.toISOString(),
    end: new Date(startDate.getTime() + DAY_MS).toISOString(),
    oldestDate: dateKeyInTehran(oldestStart),
  };
}

function toPoint(row: StoredHistoricalRoutePoint): HistoricalRoutePoint {
  return {
    id: row.id,
    latitude: Number(row.latitudeE6) / 1_000_000,
    longitude: Number(row.longitudeE6) / 1_000_000,
    accuracy: Number(row.accuracyCm) / 100,
    speed: row.speedCms == null ? null : Number(row.speedCms) / 100,
    recordedAt: row.recordedAt,
  };
}

export function splitHistoricalRoute(rows: StoredHistoricalRoutePoint[]) {
  const segments: HistoricalRouteSegment[] = [];
  const gaps: HistoricalRouteGap[] = [];
  let current: HistoricalRouteSegment | null = null;
  let previousRow: StoredHistoricalRoutePoint | null = null;
  let previousPoint: HistoricalRoutePoint | null = null;

  for (const row of rows) {
    const point = toPoint(row);
    const sameTrack = previousRow?.userId === row.userId && previousRow.workSessionId === row.workSessionId;
    const elapsedMs = sameTrack && previousPoint ? Date.parse(point.recordedAt) - Date.parse(previousPoint.recordedAt) : 0;
    const calculatedSpeedKmh = sameTrack && previousPoint && elapsedMs > 0
      ? distanceMeters(previousPoint, point) / (elapsedMs / 1000) * 3.6
      : 0;
    const hasGap = sameTrack && previousPoint != null && elapsedMs > HISTORICAL_ROUTE_GAP_MS;
    if (hasGap && previousPoint) {
      gaps.push({
        id: `${row.userId}:${row.workSessionId}:${previousPoint.id}:${point.id}`,
        userId: row.userId,
        fullName: row.fullName,
        workSessionId: row.workSessionId,
        from: previousPoint,
        to: point,
        startedAt: previousPoint.recordedAt,
        endedAt: point.recordedAt,
        durationMinutes: Math.max(1, Math.floor(elapsedMs / 60_000)),
      });
    }
    const shouldSplit = !current || !sameTrack || !previousPoint || elapsedMs <= 0 || hasGap ||
      calculatedSpeedKmh > HISTORICAL_ROUTE_MAX_SPEED_KMH ||
      (point.speed != null && point.speed * 3.6 > HISTORICAL_ROUTE_MAX_SPEED_KMH);
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
    if (!current) throw new Error("Historical route segment invariant failed");
    current.points.push(point);
    previousRow = row;
    previousPoint = point;
  }
  return { segments, gaps };
}

function meanPoint(points: HistoricalRoutePoint[]) {
  const latitude = points.reduce((sum, point) => sum + point.latitude, 0) / points.length;
  const longitude = points.reduce((sum, point) => sum + point.longitude, 0) / points.length;
  return { latitude, longitude };
}

export function detectHistoricalRouteStops(segments: HistoricalRouteSegment[]) {
  const stops: HistoricalRouteStop[] = [];
  for (const segment of segments) {
    let cluster: HistoricalRoutePoint[] = [];
    const commit = () => {
      if (cluster.length < 2) { cluster = []; return; }
      const startedAt = cluster[0].recordedAt;
      const endedAt = cluster[cluster.length - 1].recordedAt;
      const durationMs = Date.parse(endedAt) - Date.parse(startedAt);
      if (durationMs >= HISTORICAL_ROUTE_STOP_MINIMUM_MS) {
        const center = meanPoint(cluster);
        stops.push({
          id: `${segment.id}:stop:${cluster[0].id}`,
          userId: segment.userId,
          fullName: segment.fullName,
          workSessionId: segment.workSessionId,
          ...center,
          startedAt,
          endedAt,
          durationMinutes: Math.floor(durationMs / 60_000),
          pointCount: cluster.length,
        });
      }
      cluster = [];
    };

    for (const point of segment.points) {
      if (!cluster.length) { cluster = [point]; continue; }
      const center = meanPoint(cluster);
      if (distanceMeters(center, point) <= HISTORICAL_ROUTE_STOP_RADIUS_METERS) cluster.push(point);
      else { commit(); cluster = [point]; }
    }
    commit();
  }
  return stops;
}

function simplifyPoints(points: HistoricalRoutePoint[], maxPoints: number) {
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

function capSegments(segments: HistoricalRouteSegment[], maxPoints: number) {
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

export function buildHistoricalRoute(rows: StoredHistoricalRoutePoint[]) {
  const ordered = [...rows].sort((left, right) => left.userId.localeCompare(right.userId) ||
    Date.parse(left.recordedAt) - Date.parse(right.recordedAt) || left.id.localeCompare(right.id));
  const { segments: rawSegments, gaps } = splitHistoricalRoute(ordered);
  const stops = detectHistoricalRouteStops(rawSegments);
  const userIds = [...new Set(ordered.map((row) => row.userId))];
  const includedUserIds = userIds.slice(0, Math.floor(HISTORICAL_ROUTE_MAX_TOTAL_POINTS / 2));
  const perUserBudget = Math.max(2, Math.min(HISTORICAL_ROUTE_MAX_POINTS_PER_USER,
    Math.floor(HISTORICAL_ROUTE_MAX_TOTAL_POINTS / Math.max(1, includedUserIds.length))));
  const segments = includedUserIds.flatMap((userId) => capSegments(
    rawSegments.filter((segment) => segment.userId === userId), perUserBudget,
  ));
  const included = new Set(includedUserIds);
  const returnedPointCount = segments.reduce((sum, segment) => sum + segment.points.length, 0);
  const includedGaps = gaps.filter((gap) => included.has(gap.userId));
  const includedStops = stops.filter((stop) => included.has(stop.userId));
  const perUser = includedUserIds.map((userId) => {
    const userRows = ordered.filter((row) => row.userId === userId);
    const userReturned = segments.filter((segment) => segment.userId === userId).reduce((sum, segment) => sum + segment.points.length, 0);
    const userGaps = includedGaps.filter((gap) => gap.userId === userId);
    const fullName = userRows[0]?.fullName ?? "";
    return {
      userId,
      fullName,
      sampledPointCount: userRows.length,
      returnedPointCount: userReturned,
      gapCount: userGaps.length,
      gapMinutes: userGaps.reduce((sum, gap) => sum + gap.durationMinutes, 0),
      stopCount: includedStops.filter((stop) => stop.userId === userId).length,
      status: (userRows.length < 2 ? "missing" : userGaps.length ? "partial" : "complete") as "complete" | "partial" | "missing",
    };
  });
  const coverage: HistoricalRouteCoverage = {
    status: ordered.length < 2 ? "missing" : includedGaps.length ? "partial" : "complete",
    sampledPointCount: ordered.length,
    returnedPointCount,
    userCount: includedUserIds.length,
    gapCount: includedGaps.length,
    gapMinutes: includedGaps.reduce((sum, gap) => sum + gap.durationMinutes, 0),
    stopCount: includedStops.length,
    truncated: userIds.length > includedUserIds.length || returnedPointCount < ordered.length,
    perUser,
  };
  return {
    segments,
    stops: includedStops,
    gpsGaps: includedGaps,
    coverage,
    perUserBudget,
    truncatedUsers: userIds.length - includedUserIds.length,
  };
}
