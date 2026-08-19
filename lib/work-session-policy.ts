import { ensureDatabase } from "../db/runtime";

export const REQUIRED_WORK_MINUTES = 8 * 60 + 30;
export const OVERTIME_START_MINUTES = 9 * 60;
export const GPS_GAP_GRACE_MINUTES = 30;
export const SELF_REPORTED_START_PENALTY = 3;
const TEHRAN_OFFSET_MINUTES = 210;

export type WorkSessionPolicyRow = {
  id: string; status: string; startedAt: string; endedAt: string | null;
  startSource: string; endSource: string | null; workType: string; approvalStatus: string; scorePenalty: number;
};
export type WorkLocationPoint = { workSessionId: string; recordedAt: string };
export type WorkInterval = { sessionId: string; workType: string; start: number; end: number };

export function tehranDayBounds(now = new Date()) {
  const local = new Date(now.getTime() + TEHRAN_OFFSET_MINUTES * 60_000);
  const start = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - TEHRAN_OFFSET_MINUTES * 60_000);
  return { start: start.toISOString(), end: new Date(start.getTime() + 86_400_000).toISOString() };
}

export function tehranTimeTodayToIso(time: string, now = new Date()) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const { start } = tehranDayBounds(now);
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(Date.parse(start) + (hours * 60 + minutes) * 60_000).toISOString();
}

function sessionIntervals(session: WorkSessionPolicyRow, allPoints: WorkLocationPoint[], rangeStart: number, rangeEnd: number, now: number) {
  const start = Math.max(Date.parse(session.startedAt), rangeStart);
  const end = Math.min(Date.parse(session.endedAt ?? new Date(now).toISOString()), rangeEnd, now);
  if (end <= start || session.approvalStatus === "rejected") return [] as WorkInterval[];
  if (session.startSource === "self_reported") return [{ sessionId: session.id, workType: session.workType, start, end }];

  const points = allPoints.filter(point => point.workSessionId === session.id)
    .map(point => Date.parse(point.recordedAt))
    .filter(timestamp => Number.isFinite(timestamp) && timestamp >= start && timestamp <= end)
    .sort((a, b) => a - b);
  const intervals: WorkInterval[] = [];
  const graceMilliseconds = GPS_GAP_GRACE_MINUTES * 60_000;
  let coveredFrom = start;
  for (const point of points) {
    if (point <= coveredFrom) continue;
    const coveredTo = Math.min(point, coveredFrom + graceMilliseconds);
    if (coveredTo > coveredFrom) intervals.push({ sessionId: session.id, workType: session.workType, start: coveredFrom, end: coveredTo });
    coveredFrom = point;
  }
  const coveredTo = Math.min(end, coveredFrom + graceMilliseconds);
  if (coveredTo > coveredFrom) intervals.push({ sessionId: session.id, workType: session.workType, start: coveredFrom, end: coveredTo });
  return intervals;
}

function mergeIntervals(intervals: WorkInterval[]) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: WorkInterval[] = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && previous.sessionId === interval.sessionId && previous.workType === interval.workType && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

export function calculateWorkSessionMetrics(sessions: WorkSessionPolicyRow[], points: WorkLocationPoint[], rangeStartIso: string, rangeEndIso: string, now = new Date()) {
  const rangeStart = Date.parse(rangeStartIso);
  const rangeEnd = Date.parse(rangeEndIso);
  const intervals = mergeIntervals(sessions.flatMap(session => sessionIntervals(session, points, rangeStart, rangeEnd, now.getTime())));
  const intervalMilliseconds = intervals.reduce((sum, interval) => sum + interval.end - interval.start, 0);
  const regularMilliseconds = intervals.filter(interval => interval.workType !== "overtime").reduce((sum, interval) => sum + interval.end - interval.start, 0);
  const overtimeMilliseconds = intervals.filter(interval => interval.workType === "overtime").reduce((sum, interval) => sum + interval.end - interval.start, 0);
  const rawMilliseconds = sessions.filter(session => session.approvalStatus !== "rejected").reduce((sum, session) => {
    const from = Math.max(Date.parse(session.startedAt), rangeStart);
    const to = Math.min(Date.parse(session.endedAt ?? now.toISOString()), rangeEnd, now.getTime());
    return sum + Math.max(0, to - from);
  }, 0);
  const pendingCorrectionMilliseconds = intervals.filter(interval => sessions.find(session => session.id === interval.sessionId)?.approvalStatus === "pending").reduce((sum, interval) => sum + interval.end - interval.start, 0);
  return { intervals, intervalMilliseconds, regularMilliseconds, overtimeMilliseconds, rawMilliseconds, pendingCorrectionMilliseconds };
}

export async function getDailyWorkMetrics(userId: string, now = new Date()) {
  const db = await ensureDatabase();
  const { start, end } = tehranDayBounds(now);
  const [sessionResult, locationResult] = await Promise.all([
    db.prepare(`SELECT id, status, started_at AS startedAt, ended_at AS endedAt,
      COALESCE(start_source, 'live') AS startSource, end_source AS endSource, COALESCE(work_type, 'regular') AS workType,
      COALESCE(approval_status, 'approved') AS approvalStatus, COALESCE(score_penalty, 0) AS scorePenalty
      FROM work_sessions WHERE user_id = ? AND started_at < ? AND COALESCE(ended_at, ?) >= ? ORDER BY started_at`)
      .bind(userId, end, now.toISOString(), start).all<WorkSessionPolicyRow>(),
    db.prepare("SELECT work_session_id AS workSessionId, recorded_at AS recordedAt FROM location_points WHERE user_id = ? AND recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at")
      .bind(userId, start, end).all<WorkLocationPoint>(),
  ]);
  const sessions = sessionResult.results;
  const { intervals, intervalMilliseconds, regularMilliseconds, overtimeMilliseconds, rawMilliseconds, pendingCorrectionMilliseconds } = calculateWorkSessionMetrics(sessions, locationResult.results, start, end, now);
  return {
    start, end, sessions, intervals,
    firstStartAt: sessions[0] ? new Date(Math.max(Date.parse(sessions[0].startedAt), Date.parse(start))).toISOString() : null,
    lastEndAt: [...sessions].reverse().find(session => session.endedAt)?.endedAt ?? null,
    activeMinutes: Math.floor(intervalMilliseconds / 60_000),
    regularMinutes: Math.floor(regularMilliseconds / 60_000),
    overtimeMinutes: Math.floor(overtimeMilliseconds / 60_000),
    unverifiedGpsMinutes: Math.max(0, Math.floor((rawMilliseconds - intervalMilliseconds) / 60_000)),
    pendingCorrectionMinutes: Math.floor(pendingCorrectionMilliseconds / 60_000),
    requiredMinutes: REQUIRED_WORK_MINUTES, overtimeStartsAtMinutes: OVERTIME_START_MINUTES,
  };
}

export async function reconcileNineHourLimit(userId: string, now = new Date()) {
  const metrics = await getDailyWorkMetrics(userId, now);
  const activeRegular = metrics.sessions.find(session => session.status === "active" && session.workType !== "overtime");
  if (!activeRegular || metrics.regularMinutes < OVERTIME_START_MINUTES) return { autoEnded: false, metrics };

  let accumulated = 0;
  let cutoff = now.getTime();
  for (const interval of metrics.intervals.filter(item => item.workType !== "overtime").sort((a, b) => a.start - b.start)) {
    const duration = interval.end - interval.start;
    if (accumulated + duration >= OVERTIME_START_MINUTES * 60_000) {
      cutoff = interval.start + (OVERTIME_START_MINUTES * 60_000 - accumulated);
      break;
    }
    accumulated += duration;
  }
  cutoff = Math.max(Date.parse(activeRegular.startedAt), Math.min(cutoff, now.getTime()));
  const endedAt = new Date(cutoff).toISOString();
  const db = await ensureDatabase();
  await db.batch([
    db.prepare("UPDATE work_sessions SET status = 'ended', ended_at = ?, end_source = 'system_auto_9h', end_note = ? WHERE id = ? AND status = 'active'")
      .bind(endedAt, "پایان خودکار سیستمی پس از تکمیل ۹ ساعت کار دارای GPS", activeRegular.id),
    db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'work_session.auto_ended_9h', 'work_session', ?, ?, ?)")
      .bind(crypto.randomUUID(), userId, activeRegular.id, JSON.stringify({ endedAt, verifiedMinutes: OVERTIME_START_MINUTES }), now.toISOString()),
  ]);
  return { autoEnded: true, endedAt, sessionId: activeRegular.id, metrics: await getDailyWorkMetrics(userId, now) };
}
