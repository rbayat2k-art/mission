export const MAX_CONCURRENT_MISSIONS = 3;
export const MISSION_START_CANCEL_WINDOW_MS = 5 * 60_000;

export function missionStartCancellationState(startedAt: string | null | undefined, now = Date.now()) {
  const startedTime = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (!Number.isFinite(startedTime)) return { allowed: false, remainingMs: 0, elapsedMs: 0 };
  const elapsedMs = Math.max(0, now - startedTime);
  return {
    allowed: elapsedMs <= MISSION_START_CANCEL_WINDOW_MS,
    remainingMs: Math.max(0, MISSION_START_CANCEL_WINDOW_MS - elapsedMs),
    elapsedMs,
  };
}
