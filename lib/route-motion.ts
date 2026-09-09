// Reporting estimates only. These limits do not change attendance or scoring.
export const ROUTE_MAX_SPEED_KMH = 160;
export const ROUTE_MAX_GAP_MS = 2 * 60_000;
export type MotionPoint = { workSessionId: string; latitudeE6: number; longitudeE6: number; speedCms: number | null; recordedAt: string };

export function routeMotion(points: MotionPoint[]) {
  const sorted = [...points].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
  let movingMilliseconds = 0, stoppedMilliseconds = 0, movingDistanceKm = 0, maxSpeedKmh = 0;
  let hasGap = false;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    const elapsed = Date.parse(b.recordedAt) - Date.parse(a.recordedAt);
    if (elapsed === 0) continue;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > ROUTE_MAX_GAP_MS ||
        (a.workSessionId && b.workSessionId && a.workSessionId !== b.workSessionId)) { hasGap = true; continue; }
    const rad = Math.PI / 180;
    const lat1 = a.latitudeE6 / 1e6 * rad, lat2 = b.latitudeE6 / 1e6 * rad;
    const h = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((b.longitudeE6 - a.longitudeE6) / 1e6 * rad / 2) ** 2;
    const distance = 6371 * 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))));
    const speed = distance / (elapsed / 3_600_000);
    if (!Number.isFinite(speed) || speed > ROUTE_MAX_SPEED_KMH) { hasGap = true; continue; }
    // Use distance and time from the SAME accepted intervals. Device speed may
    // be absent/stale/corrupt; it must not create movement at unchanged coordinates.
    if (speed >= 5 && distance >= 0.005) {
      movingMilliseconds += elapsed;
      movingDistanceKm += distance;
      maxSpeedKmh = Math.max(maxSpeedKmh, speed);
    } else stoppedMilliseconds += elapsed;
  }
  return { movingMilliseconds, stoppedMilliseconds, movingDistanceKm, maxSpeedKmh, hasGap };
}
