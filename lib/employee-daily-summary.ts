import { ensureDatabase } from "../db/runtime";
import { calculateWorkSessionMetrics, OVERTIME_START_MINUTES, REQUIRED_WORK_MINUTES, type WorkLocationPoint, type WorkSessionPolicyRow } from "./work-session-policy";

const TEHRAN_OFFSET_MINUTES = 210;
export type ReportPeriod = "daily" | "weekly" | "monthly";

function tehranPeriodBounds(now: Date, period: ReportPeriod) {
  const local = new Date(now.getTime() + TEHRAN_OFFSET_MINUTES * 60_000);
  const todayStart = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - TEHRAN_OFFSET_MINUTES * 60_000);
  const lookbackDays = period === "weekly" ? 6 : period === "monthly" ? 29 : 0;
  const start = new Date(todayStart.getTime() - lookbackDays * 24 * 60 * 60_000);
  return { start: start.toISOString(), end: new Date(todayStart.getTime() + 24 * 60 * 60_000).toISOString() };
}

type DailyMission = {
  id: string;
  title: string;
  status: string;
  result: string | null;
  report: string | null;
  destinationName: string | null;
  expenseAmount: number;
  scorePending: number;
  scoreConfirmed: number;
  scorePenalty: number;
  scoreNote: string | null;
  deadline: string | null;
  completedAt: string | null;
};

export async function getEmployeeActivitySummary(userId: string, period: ReportPeriod = "daily", now = new Date()) {
  const db = await ensureDatabase();
  const { start, end } = tehranPeriodBounds(now, period);
  const [completedResult, incompleteResult, locationResult, sessionResult, workLocationResult] = await Promise.all([
    db.prepare(`SELECT id, title, status, result, report, destination_name AS destinationName, expense_amount AS expenseAmount, score_pending AS scorePending, score_confirmed AS scoreConfirmed, score_penalty AS scorePenalty, score_note AS scoreNote, deadline, completed_at AS completedAt FROM missions WHERE assigned_to = ? AND completed_at >= ? AND completed_at < ? ORDER BY completed_at DESC`).bind(userId, start, end).all<DailyMission>(),
    db.prepare(`SELECT id, title, status, result, report, destination_name AS destinationName, expense_amount AS expenseAmount, score_pending AS scorePending, score_confirmed AS scoreConfirmed, score_penalty AS scorePenalty, score_note AS scoreNote, deadline, completed_at AS completedAt FROM missions WHERE assigned_to = ? AND status IN ('open', 'in_progress', 'revision', 'follow_up', 'follow_up_pending') ORDER BY created_at DESC`).bind(userId).all<DailyMission>(),
    db.prepare("SELECT COUNT(*) AS pointCount, MIN(recorded_at) AS firstAt, MAX(recorded_at) AS lastAt FROM location_points WHERE user_id = ? AND recorded_at >= ? AND recorded_at < ?").bind(userId, start, end).first<{ pointCount: number; firstAt: string | null; lastAt: string | null }>(),
    db.prepare(`SELECT id, status, started_at AS startedAt, ended_at AS endedAt, end_note AS endNote,
      COALESCE(start_source, 'live') AS startSource, end_source AS endSource, COALESCE(work_type, 'regular') AS workType,
      COALESCE(approval_status, 'approved') AS approvalStatus, COALESCE(score_penalty, 0) AS scorePenalty
      FROM work_sessions WHERE user_id = ? AND started_at < ? AND COALESCE(ended_at, ?) >= ? ORDER BY started_at ASC`).bind(userId, end, now.toISOString(), start).all<WorkSessionPolicyRow & { endNote: string | null }>(),
    db.prepare("SELECT work_session_id AS workSessionId, recorded_at AS recordedAt FROM location_points WHERE user_id = ? AND recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at").bind(userId, start, end).all<WorkLocationPoint>(),
  ]);
  const completed = completedResult.results;
  const incomplete = incompleteResult.results;
  const destinations = [...new Set(completed.map(mission => mission.destinationName).filter((value): value is string => Boolean(value)))];
  const sessions = sessionResult.results.map(session => {
    const sessionStart = Math.max(Date.parse(session.startedAt), Date.parse(start));
    const sessionEnd = Math.min(Date.parse(session.endedAt ?? now.toISOString()), Date.parse(end));
    return { ...session, startedAt: new Date(sessionStart).toISOString(), endedAt: session.endedAt ? new Date(sessionEnd).toISOString() : null, durationMinutes: Math.max(0, Math.round((sessionEnd - sessionStart) / 60_000)) };
  });
  const workMetrics = calculateWorkSessionMetrics(sessionResult.results, workLocationResult.results, start, end, now);
  const activeMinutes = Math.floor(workMetrics.intervalMilliseconds / 60_000);
  const dailyVerifiedMinutes = new Map<string, number>();
  for (const interval of workMetrics.intervals) {
    const local = new Date(interval.start + TEHRAN_OFFSET_MINUTES * 60_000);
    const key = `${local.getUTCFullYear()}-${local.getUTCMonth()}-${local.getUTCDate()}`;
    dailyVerifiedMinutes.set(key, (dailyVerifiedMinutes.get(key) ?? 0) + (interval.end - interval.start) / 60_000);
  }
  const overtimeMinutes = Math.floor([...dailyVerifiedMinutes.values()].reduce((sum, minutes) => sum + Math.max(0, minutes - OVERTIME_START_MINUTES), 0));
  return {
    period,
    date: start,
    completed,
    incomplete,
    destinations,
    locationSummary: { pointCount: Number(locationResult?.pointCount ?? 0), firstAt: locationResult?.firstAt ?? null, lastAt: locationResult?.lastAt ?? null },
    sessions,
    firstStartAt: sessions[0]?.startedAt ?? null,
    lastEndAt: [...sessions].reverse().find(session => session.endedAt)?.endedAt ?? null,
    activeMinutes,
    rawSessionMinutes: sessions.reduce((total, session) => total + session.durationMinutes, 0),
    unverifiedGpsMinutes: Math.max(0, Math.floor((workMetrics.rawMilliseconds - workMetrics.intervalMilliseconds) / 60_000)),
    pendingCorrectionMinutes: Math.floor(workMetrics.pendingCorrectionMilliseconds / 60_000),
    requiredMinutes: REQUIRED_WORK_MINUTES,
    overtimeStartsAtMinutes: OVERTIME_START_MINUTES,
    overtimeMinutes,
    confirmedScore: completed.reduce((sum, mission) => sum + Number(mission.scoreConfirmed ?? 0), 0),
    pendingScore: completed.reduce((sum, mission) => sum + Number(mission.scorePending ?? 0), 0),
    confirmationMissionIds: [...new Set([...completed.map(mission => mission.id), ...incomplete.map(mission => mission.id)])].sort(),
  };
}

export async function getEmployeeDailySummary(userId: string, now = new Date()) {
  return getEmployeeActivitySummary(userId, "daily", now);
}
