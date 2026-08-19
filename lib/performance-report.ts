import { ensureDatabase } from "../db/runtime";
import type { AppRole } from "./auth";
import { calculateWorkSessionMetrics, OVERTIME_START_MINUTES, REQUIRED_WORK_MINUTES, type WorkSessionPolicyRow } from "./work-session-policy";

export type PerformancePeriod = "daily" | "weekly" | "monthly";
const TEHRAN_OFFSET_MINUTES = 210;
const STANDARD_START_MINUTES = 8 * 60 + 30;
const STANDARD_DAY_MINUTES = REQUIRED_WORK_MINUTES;

export function performancePeriodBounds(now: Date, period: PerformancePeriod) {
  const local = new Date(now.getTime() + TEHRAN_OFFSET_MINUTES * 60_000);
  const todayStart = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - TEHRAN_OFFSET_MINUTES * 60_000);
  const lookbackDays = period === "weekly" ? 6 : period === "monthly" ? 29 : 0;
  const start = new Date(todayStart.getTime() - lookbackDays * 86_400_000);
  return { start: start.toISOString(), end: new Date(todayStart.getTime() + 86_400_000).toISOString(), days: lookbackDays + 1 };
}

type ReportUser = { id: string; fullName: string; username: string; supervisorName: string | null };
type SessionRow = WorkSessionPolicyRow & { endNote: string | null };
type MissionRow = {
  id: string; title: string; status: string; source: string; result: string | null; destinationName: string | null;
  expenseAmount: number; scorePending: number; scoreConfirmed: number; deadlineAt: string | null;
  scorePenalty: number; scoreNote: string | null;
  startedAt: string | null; completedAt: string | null; createdAt: string;
  startLatitudeE6: number | null; startLongitudeE6: number | null; startLocationRecordedAt: string | null;
  destinationLatitudeE6: number | null; destinationLongitudeE6: number | null; destinationRecordedAt: string | null;
};
type LocationRow = { workSessionId: string; latitudeE6: number; longitudeE6: number; speedCms: number | null; recordedAt: string };
type IntegrityRow = { type: string; status: string; details: string; occurredAt: string };

type MissionTrip = {
  missionId: string; title: string; status: string; destinationName: string | null;
  startedAt: string | null; destinationRecordedAt: string | null;
  travelMinutes: number; movingMinutes: number; stoppedMinutes: number; distanceKm: number;
  averageMovingSpeedKmh: number; maxSpeedKmh: number; pointCount: number;
  coverageStatus: "complete" | "partial" | "missing";
};

function clampMinutes(start: string, end: string | null, rangeStart: string, rangeEnd: string, nowIso: string) {
  const from = Math.max(Date.parse(start), Date.parse(rangeStart));
  const to = Math.min(Date.parse(end ?? nowIso), Date.parse(rangeEnd));
  return Math.max(0, Math.round((to - from) / 60_000));
}

function tehranDayKey(value: string) {
  const d = new Date(Date.parse(value) + TEHRAN_OFFSET_MINUTES * 60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function localMinuteOfDay(value: string) {
  const d = new Date(Date.parse(value) + TEHRAN_OFFSET_MINUTES * 60_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function distanceKm(a: LocationRow, b: LocationRow) {
  const rad = Math.PI / 180;
  const lat1 = a.latitudeE6 / 1_000_000 * rad;
  const lat2 = b.latitudeE6 / 1_000_000 * rad;
  const dLat = lat2 - lat1;
  const dLng = (b.longitudeE6 - a.longitudeE6) / 1_000_000 * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function validDate(value: string | null) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function missionTripMetrics(mission: MissionRow, locations: LocationRow[], rangeStart: string, rangeEnd: string): MissionTrip | null {
  const startedAt = mission.startLocationRecordedAt ?? mission.startedAt;
  const startedTimestamp = validDate(startedAt);
  const destinationTimestamp = validDate(mission.destinationRecordedAt);
  const rangeStartTimestamp = Date.parse(rangeStart);
  const rangeEndTimestamp = Date.parse(rangeEnd);
  const intersectsRange = startedTimestamp !== null && startedTimestamp < rangeEndTimestamp &&
    (destinationTimestamp ?? startedTimestamp) >= rangeStartTimestamp;
  if (!intersectsRange) return null;

  const base: MissionTrip = {
    missionId: mission.id, title: mission.title, status: mission.status, destinationName: mission.destinationName,
    startedAt, destinationRecordedAt: mission.destinationRecordedAt,
    travelMinutes: 0, movingMinutes: 0, stoppedMinutes: 0, distanceKm: 0,
    averageMovingSpeedKmh: 0, maxSpeedKmh: 0, pointCount: 0, coverageStatus: "missing",
  };
  if (startedTimestamp === null || destinationTimestamp === null || destinationTimestamp <= startedTimestamp) return base;

  const routeStart = Math.max(startedTimestamp, rangeStartTimestamp);
  const routeEnd = Math.min(destinationTimestamp, rangeEndTimestamp);
  if (routeEnd <= routeStart) return base;

  const routePoints: LocationRow[] = locations.filter(point => {
    const timestamp = Date.parse(point.recordedAt);
    return timestamp >= routeStart && timestamp <= routeEnd;
  });
  if (mission.startLatitudeE6 !== null && mission.startLongitudeE6 !== null && startedTimestamp >= routeStart) {
    routePoints.push({ workSessionId: "", latitudeE6: mission.startLatitudeE6, longitudeE6: mission.startLongitudeE6, speedCms: null, recordedAt: startedAt! });
  }
  if (mission.destinationLatitudeE6 !== null && mission.destinationLongitudeE6 !== null && destinationTimestamp <= routeEnd) {
    routePoints.push({ workSessionId: "", latitudeE6: mission.destinationLatitudeE6, longitudeE6: mission.destinationLongitudeE6, speedCms: null, recordedAt: mission.destinationRecordedAt! });
  }
  routePoints.sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));

  let routeDistance = 0;
  let movingMinutesRaw = 0;
  let maxSpeedKmh = 0;
  let hasLargeGpsGap = false;
  for (let index = 1; index < routePoints.length; index++) {
    const previous = routePoints[index - 1];
    const current = routePoints[index];
    const elapsedMinutes = (Date.parse(current.recordedAt) - Date.parse(previous.recordedAt)) / 60_000;
    if (elapsedMinutes <= 0) continue;
    if (elapsedMinutes > 20) { hasLargeGpsGap = true; continue; }
    const segmentKm = distanceKm(previous, current);
    const inferredSpeedKmh = segmentKm / (elapsedMinutes / 60);
    const deviceSpeedMs = Math.max(previous.speedCms ?? 0, current.speedCms ?? 0) / 100;
    const isMoving = deviceSpeedMs >= 1.4 || inferredSpeedKmh >= 5;
    if (!isMoving || inferredSpeedKmh > 160) continue;
    movingMinutesRaw += elapsedMinutes;
    if (segmentKm >= 0.005) routeDistance += segmentKm;
    maxSpeedKmh = Math.max(maxSpeedKmh, inferredSpeedKmh, deviceSpeedMs * 3.6);
  }

  const travelMinutes = Math.max(1, Math.round((routeEnd - routeStart) / 60_000));
  const movingMinutes = Math.min(travelMinutes, Math.round(movingMinutesRaw));
  const hasExactEndpoints = mission.startLatitudeE6 !== null && mission.startLongitudeE6 !== null &&
    mission.destinationLatitudeE6 !== null && mission.destinationLongitudeE6 !== null;
  const coverageStatus = routePoints.length >= 3 && hasExactEndpoints && !hasLargeGpsGap ? "complete" : routePoints.length >= 2 ? "partial" : "missing";
  const roundedDistance = Math.round(routeDistance * 10) / 10;
  return {
    ...base, travelMinutes, movingMinutes, stoppedMinutes: Math.max(0, travelMinutes - movingMinutes),
    distanceKm: roundedDistance,
    averageMovingSpeedKmh: movingMinutes > 0 ? Math.round(routeDistance / (movingMinutes / 60) * 10) / 10 : 0,
    maxSpeedKmh: Math.round(maxSpeedKmh * 10) / 10, pointCount: routePoints.length, coverageStatus,
  };
}

function percent(part: number, total: number) { return total > 0 ? Math.round(part / total * 100) : 0; }

async function loadUserReport(user: ReportUser, period: PerformancePeriod, now: Date) {
  const db = await ensureDatabase();
  const { start, end } = performancePeriodBounds(now, period);
  const nowIso = now.toISOString();
  const [sessionsResult, missionsResult, locationsResult, integrityResult, attachmentResult, approvalResult] = await Promise.all([
    db.prepare(`SELECT id, status, started_at AS startedAt, ended_at AS endedAt, end_note AS endNote,
      COALESCE(start_source, 'live') AS startSource, end_source AS endSource, COALESCE(work_type, 'regular') AS workType,
      COALESCE(approval_status, 'approved') AS approvalStatus, COALESCE(score_penalty, 0) AS scorePenalty
      FROM work_sessions WHERE user_id = ? AND started_at < ? AND COALESCE(ended_at, ?) >= ? ORDER BY started_at`).bind(user.id, end, nowIso, start).all<SessionRow>(),
    db.prepare(`SELECT m.id, m.title, m.status, m.source, m.result, COALESCE(md.destination_name, m.destination_name) AS destinationName, m.expense_amount AS expenseAmount,
      m.score_pending AS scorePending, m.score_confirmed AS scoreConfirmed, m.score_penalty AS scorePenalty, m.score_note AS scoreNote, m.deadline_at AS deadlineAt,
      m.started_at AS startedAt, m.start_latitude_e6 AS startLatitudeE6, m.start_longitude_e6 AS startLongitudeE6, m.start_location_recorded_at AS startLocationRecordedAt,
      md.latitude_e6 AS destinationLatitudeE6, md.longitude_e6 AS destinationLongitudeE6, md.recorded_at AS destinationRecordedAt,
      m.completed_at AS completedAt, m.created_at AS createdAt FROM missions m LEFT JOIN mission_destinations md ON md.mission_id = m.id
      WHERE m.assigned_to = ? AND
      (m.created_at >= ? AND m.created_at < ? OR m.started_at >= ? AND m.started_at < ? OR m.completed_at >= ? AND m.completed_at < ? OR md.recorded_at >= ? AND md.recorded_at < ? OR m.completed_at IS NULL)
      ORDER BY COALESCE(m.completed_at, m.created_at) DESC`).bind(user.id, start, end, start, end, start, end, start, end).all<MissionRow>(),
    db.prepare("SELECT work_session_id AS workSessionId, latitude_e6 AS latitudeE6, longitude_e6 AS longitudeE6, speed_cms AS speedCms, recorded_at AS recordedAt FROM location_points WHERE user_id = ? AND recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at").bind(user.id, start, end).all<LocationRow>(),
    db.prepare("SELECT type, status, details, occurred_at AS occurredAt FROM integrity_events WHERE user_id = ? AND occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at").bind(user.id, start, end).all<IntegrityRow>(),
    db.prepare("SELECT COUNT(*) AS count FROM attachments a JOIN missions m ON m.id = a.mission_id WHERE m.assigned_to = ? AND a.created_at >= ? AND a.created_at < ?").bind(user.id, start, end).first<{ count: number }>(),
    db.prepare("SELECT a.status FROM approvals a JOIN missions m ON m.id = a.mission_id WHERE m.assigned_to = ? AND a.created_at >= ? AND a.created_at < ?").bind(user.id, start, end).all<{ status: string }>(),
  ]);

  const sessions = sessionsResult.results;
  const missions = missionsResult.results;
  const completed = missions.filter(m => m.completedAt && m.completedAt >= start && m.completedAt < end);
  const created = missions.filter(m => m.createdAt >= start && m.createdAt < end);
  const relevantIds = new Set([...created, ...completed].map(m => m.id));
  const successful = completed.filter(m => m.result === "انجام شد");
  const followUp = completed.filter(m => m.result && m.result !== "انجام شد");
  const open = missions.filter(m => ["open", "in_progress", "revision"].includes(m.status));
  const overdue = open.filter(m => m.deadlineAt && Date.parse(m.deadlineAt) < now.getTime());
  const deadlineCompleted = completed.filter(m => m.deadlineAt);
  const onTime = deadlineCompleted.filter(m => Date.parse(m.completedAt!) <= Date.parse(m.deadlineAt!));

  const points = locationsResult.results;
  const verifiedWork = calculateWorkSessionMetrics(sessions, points, start, end, now);
  const activeMinutes = Math.floor(verifiedWork.intervalMilliseconds / 60_000);
  const eligibleSessions = sessions.filter(session => session.approvalStatus !== "rejected");
  const attendanceDays = new Set(eligibleSessions.map(s => tehranDayKey(s.startedAt))).size;
  const firstByDay = new Map<string, string>();
  for (const session of eligibleSessions) {
    const key = tehranDayKey(session.startedAt);
    if (!firstByDay.has(key) || session.startedAt < firstByDay.get(key)!) firstByDay.set(key, session.startedAt);
  }
  const lateMinutes = [...firstByDay.values()].reduce((sum, value) => sum + Math.max(0, localMinuteOfDay(value) - STANDARD_START_MINUTES), 0);
  const targetMinutes = attendanceDays * STANDARD_DAY_MINUTES;
  const minutesByDay = new Map<string, number>();
  for (const interval of verifiedWork.intervals) {
    const key = tehranDayKey(new Date(interval.start).toISOString());
    minutesByDay.set(key, (minutesByDay.get(key) ?? 0) + (interval.end - interval.start) / 60_000);
  }
  const overtimeMinutes = Math.floor([...minutesByDay.values()].reduce((sum, minutes) => sum + Math.max(0, minutes - OVERTIME_START_MINUTES), 0));
  const shortfallMinutes = Math.max(0, targetMinutes - activeMinutes);

  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    const elapsedMinutes = (Date.parse(points[i].recordedAt) - Date.parse(points[i - 1].recordedAt)) / 60_000;
    if (elapsedMinutes <= 0 || elapsedMinutes > 20) continue;
    const km = distanceKm(points[i - 1], points[i]);
    const speed = km / (elapsedMinutes / 60);
    if (speed <= 160) distance += km;
  }
  const missionTrips = missions.map(mission => missionTripMetrics(mission, points, start, end)).filter((trip): trip is MissionTrip => Boolean(trip));
  const travelMinutes = missionTrips.reduce((sum, trip) => sum + trip.travelMinutes, 0);
  const movingMinutes = missionTrips.reduce((sum, trip) => sum + trip.movingMinutes, 0);
  const stoppedMinutes = missionTrips.reduce((sum, trip) => sum + trip.stoppedMinutes, 0);
  const missionDistanceKm = Math.round(missionTrips.reduce((sum, trip) => sum + trip.distanceKm, 0) * 10) / 10;
  const onSiteMinutes = completed.reduce((sum, mission) => mission.destinationRecordedAt ? sum + clampMinutes(mission.destinationRecordedAt, mission.completedAt, start, end, nowIso) : sum, 0);
  const totalMissionMinutes = completed.reduce((sum, mission) => mission.startedAt ? sum + clampMinutes(mission.startedAt, mission.completedAt, start, end, nowIso) : sum, 0);
  const classifiedMinutes = Math.min(activeMinutes, Math.round(onSiteMinutes + travelMinutes));

  let gpsGapMinutes = 0;
  const integrityEvents = integrityResult.results;
  for (const event of integrityEvents) {
    if (event.type !== "gps_gap" && event.type !== "device_offline") continue;
    try { gpsGapMinutes += Math.max(0, Number((JSON.parse(event.details) as { gapMinutes?: number }).gapMinutes ?? 0)); } catch { /* malformed legacy detail */ }
  }

  const approvedMissions = completed.filter(m => m.status === "approved");
  const pendingMissions = completed.filter(m => m.status === "pending");
  const rejectedMissions = completed.filter(m => ["rejected", "revision"].includes(m.status));
  const approvalRows = approvalResult.results;
  const resolvedApprovals = approvalRows.filter(a => a.status !== "pending");
  const approvedExpenses = approvedMissions.reduce((sum, m) => sum + Number(m.expenseAmount || 0), 0);
  const pendingExpenses = pendingMissions.reduce((sum, m) => sum + Number(m.expenseAmount || 0), 0);
  const rejectedExpenses = rejectedMissions.reduce((sum, m) => sum + Number(m.expenseAmount || 0), 0);
  const totalExpenses = completed.reduce((sum, m) => sum + Number(m.expenseAmount || 0), 0);
  const destinations = [...new Set(completed.map(m => m.destinationName).filter((value): value is string => Boolean(value)))];

  return {
    id: user.id, fullName: user.fullName, username: user.username, supervisorName: user.supervisorName,
    attendance: {
      activeMinutes, attendanceDays, targetMinutes, overtimeMinutes, shortfallMinutes, lateMinutes,
      unverifiedGpsMinutes: Math.max(0, Math.floor((verifiedWork.rawMilliseconds - verifiedWork.intervalMilliseconds) / 60_000)),
      pendingCorrectionMinutes: Math.floor(verifiedWork.pendingCorrectionMilliseconds / 60_000),
      selfReportedStartCount: sessions.filter(session => session.startSource === "self_reported").length,
      firstStartAt: sessions[0]?.startedAt ?? null, lastEndAt: [...sessions].reverse().find(s => s.endedAt)?.endedAt ?? null,
      endNotes: sessions.filter(s => s.endNote).map(s => ({ at: s.endedAt ?? s.startedAt, note: s.endNote! })).slice(-5).reverse(),
    },
    missions: {
      assignedCount: relevantIds.size, completedCount: completed.length, successfulCount: successful.length,
      followUpCount: followUp.length, openCount: open.length, pendingCount: pendingMissions.length, approvedCount: approvedMissions.length,
      rejectedCount: rejectedMissions.length, overdueCount: overdue.length, selfCreatedCount: completed.filter(m => m.source === "employee").length,
      completionRate: percent(completed.length, relevantIds.size), onTimeRate: percent(onTime.length, deadlineCompleted.length),
      averageMissionMinutes: completed.filter(m => m.startedAt).length ? Math.round(totalMissionMinutes / completed.filter(m => m.startedAt).length) : 0,
    },
    movement: {
      distanceKm: Math.round(distance * 10) / 10, missionDistanceKm, travelMinutes, movingMinutes, stoppedMinutes, onSiteMinutes,
      unclassifiedMinutes: Math.max(0, activeMinutes - classifiedMinutes), destinationCount: destinations.length,
      destinations, locationPointCount: points.length, missionTrips,
    },
    integrity: { eventCount: integrityEvents.length, openCount: integrityEvents.filter(e => e.status === "open").length, gpsGapMinutes },
    quality: {
      attachmentCount: Number(attachmentResult?.count ?? 0), approvalCount: approvalRows.filter(a => a.status === "approved").length,
      rejectedOrRevisionCount: approvalRows.filter(a => ["rejected", "revision"].includes(a.status)).length,
      firstPassApprovalRate: percent(approvalRows.filter(a => a.status === "approved").length, resolvedApprovals.length),
      confirmedScore: completed.reduce((sum, m) => sum + Number(m.scoreConfirmed || 0), 0),
      pendingScore: completed.reduce((sum, m) => sum + Number(m.scorePending || 0), 0),
      deductedScore: completed.reduce((sum, m) => sum + Number(m.scorePenalty || 0), 0) + sessions.reduce((sum, session) => sum + Number(session.scorePenalty || 0), 0),
      missedMissionStarts: completed.filter(m => Number(m.scorePenalty || 0) > 0).length,
    },
    finance: { total: totalExpenses, approved: approvedExpenses, pending: pendingExpenses, rejected: rejectedExpenses, averagePerMission: completed.length ? Math.round(totalExpenses / completed.length) : 0 },
  };
}

export type PerformanceUserReport = Awaited<ReturnType<typeof loadUserReport>>;

export async function getPerformanceReport(viewer: { id: string; role: AppRole }, period: PerformancePeriod = "daily", now = new Date()) {
  const db = await ensureDatabase();
  let users;
  if (viewer.role === "employee") {
    users = await db.prepare(`SELECT u.id, u.full_name AS fullName, u.username, s.full_name AS supervisorName FROM users u LEFT JOIN users s ON s.id = u.supervisor_id WHERE u.id = ?`).bind(viewer.id).all<ReportUser>();
  } else if (viewer.role === "supervisor") {
    users = await db.prepare(`SELECT u.id, u.full_name AS fullName, u.username, s.full_name AS supervisorName FROM users u LEFT JOIN users s ON s.id = u.supervisor_id WHERE u.role = 'employee' AND u.status = 'active' AND u.supervisor_id = ? ORDER BY u.full_name`).bind(viewer.id).all<ReportUser>();
  } else {
    users = await db.prepare(`SELECT u.id, u.full_name AS fullName, u.username, s.full_name AS supervisorName FROM users u LEFT JOIN users s ON s.id = u.supervisor_id WHERE u.role = 'employee' AND u.status = 'active' ORDER BY u.full_name`).all<ReportUser>();
  }
  const rows = await Promise.all(users.results.map(user => loadUserReport(user, period, now)));
  const totals = rows.reduce((sum, row) => ({
    activeMinutes: sum.activeMinutes + row.attendance.activeMinutes,
    completedCount: sum.completedCount + row.missions.completedCount,
    approvedCount: sum.approvedCount + row.missions.approvedCount,
    overdueCount: sum.overdueCount + row.missions.overdueCount,
    confirmedScore: sum.confirmedScore + row.quality.confirmedScore,
    pendingScore: sum.pendingScore + row.quality.pendingScore,
    distanceKm: Math.round((sum.distanceKm + row.movement.distanceKm) * 10) / 10,
    missionDistanceKm: Math.round((sum.missionDistanceKm + row.movement.missionDistanceKm) * 10) / 10,
    travelMinutes: sum.travelMinutes + row.movement.travelMinutes,
    movingMinutes: sum.movingMinutes + row.movement.movingMinutes,
    totalExpenses: sum.totalExpenses + row.finance.total,
    gpsGapMinutes: sum.gpsGapMinutes + row.integrity.gpsGapMinutes,
  }), { activeMinutes: 0, completedCount: 0, approvedCount: 0, overdueCount: 0, confirmedScore: 0, pendingScore: 0, distanceKm: 0, missionDistanceKm: 0, travelMinutes: 0, movingMinutes: 0, totalExpenses: 0, gpsGapMinutes: 0 });
  return {
    period, range: performancePeriodBounds(now, period), rows, totals,
    policy: { standardStart: "۰۸:۳۰", standardDailyMinutes: STANDARD_DAY_MINUTES, overtimeStartMinutes: OVERTIME_START_MINUTES, note: "حداقل کار روزانه ۸ ساعت و ۳۰ دقیقه است؛ اضافه‌کاری فقط پس از تکمیل ۹ ساعت کار دارای GPS محاسبه می‌شود. فاصله بین پایان و شروع مجدد جزو کارکرد نیست." },
  };
}
