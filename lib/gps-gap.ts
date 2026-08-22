export const GPS_REPORT_STALE_MINUTES = 2;

export type GpsGapSession = {
  id: string;
  startedAt: string;
  endedAt: string | null;
  startSource: string;
  approvalStatus: string;
};

export type GpsGapPoint = {
  workSessionId: string;
  recordedAt: string;
};

type GapInterval = { start: number; end: number };

function validTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function mergeIntervals(intervals: GapInterval[]) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: GapInterval[] = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

/**
 * Measures stale GPS windows only while a real work session is open.
 * Historical self-reported sessions are excluded because they never had live tracking.
 */
export function calculateGpsGapMinutes(
  sessions: GpsGapSession[],
  points: GpsGapPoint[],
  rangeStartIso: string,
  rangeEndIso: string,
  now = new Date(),
) {
  const rangeStart = Date.parse(rangeStartIso);
  const rangeEnd = Math.min(Date.parse(rangeEndIso), now.getTime());
  const staleMilliseconds = GPS_REPORT_STALE_MINUTES * 60_000;
  const gaps: GapInterval[] = [];

  for (const session of sessions) {
    if (session.approvalStatus === "rejected" || session.startSource === "self_reported") continue;
    const sessionStartedAt = validTimestamp(session.startedAt);
    const sessionEndedAt = session.endedAt ? validTimestamp(session.endedAt) : now.getTime();
    if (sessionStartedAt === null || sessionEndedAt === null) continue;
    const start = Math.max(sessionStartedAt, rangeStart);
    const end = Math.min(sessionEndedAt, rangeEnd);
    if (end <= start) continue;

    const timestamps = points
      .filter(point => point.workSessionId === session.id)
      .map(point => validTimestamp(point.recordedAt))
      .filter((timestamp): timestamp is number => timestamp !== null && timestamp >= start && timestamp <= end)
      .sort((a, b) => a - b);

    let lastCoveredAt = start;
    for (const timestamp of timestamps) {
      if (timestamp <= lastCoveredAt) continue;
      if (timestamp - lastCoveredAt > staleMilliseconds) gaps.push({ start: lastCoveredAt, end: timestamp });
      lastCoveredAt = timestamp;
    }
    if (end - lastCoveredAt > staleMilliseconds) gaps.push({ start: lastCoveredAt, end });
  }

  return Math.floor(mergeIntervals(gaps).reduce((sum, gap) => sum + gap.end - gap.start, 0) / 60_000);
}
