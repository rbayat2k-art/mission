import { ensureDatabase } from "../db/runtime";
import type { AppRole } from "./auth";
import { calculateGpsGapMinutes } from "./gps-gap";
import { calculateWorkSessionMetrics, OVERTIME_START_MINUTES, REQUIRED_WORK_MINUTES, type WorkSessionPolicyRow } from "./work-session-policy";

export type PerformancePeriod = "daily" | "weekly" | "monthly";
export type PerformanceMetricKey =
  | "activeMinutes" | "completedCount" | "successRate" | "firstVisitSuccessRate"
  | "averageMissionMinutes" | "averageTravelMinutes" | "averageOnSiteMinutes"
  | "averageMissionDistanceKm" | "missionDistanceKm" | "gpsCoverageRate"
  | "gpsGapMinutes" | "internetGapMinutes" | "totalExpenses";
const TEHRAN_OFFSET_MINUTES = 210;
const STANDARD_START_MINUTES = 8 * 60 + 30;
const STANDARD_DAY_MINUTES = REQUIRED_WORK_MINUTES;

export function performancePeriodBounds(now: Date, period: PerformancePeriod) {
  const local = new Date(now.getTime() + TEHRAN_OFFSET_MINUTES * 60_000);
  const todayStart = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - TEHRAN_OFFSET_MINUTES * 60_000);
  const lookbackDays = period === "weekly" ? 6 : period === "monthly" ? 29 : 0;
  const start = new Date(todayStart.getTime() - lookbackDays * 86_400_000);
  return { start: start.toISOString(), end: now.toISOString(), days: lookbackDays + 1 };
}

function previousPeriodNow(now: Date, period: PerformancePeriod) {
  const days = period === "weekly" ? 7 : period === "monthly" ? 30 : 1;
  return new Date(now.getTime() - days * 86_400_000);
}

type ReportUser = { id: string; fullName: string; username: string; supervisorName: string | null };
type SessionRow = WorkSessionPolicyRow & { endNote: string | null };
type MissionRow = {
  id: string; title: string; status: string; source: string; result: string | null; destinationName: string | null;
  expenseAmount: number; scorePending: number; scoreConfirmed: number; deadlineAt: string | null;
  scorePenalty: number; scoreNote: string | null;
  startedAt: string | null; completedAt: string | null; createdAt: string;
  attemptCount: number;
  startLatitudeE6: number | null; startLongitudeE6: number | null; startLocationRecordedAt: string | null;
  destinationLatitudeE6: number | null; destinationLongitudeE6: number | null; destinationRecordedAt: string | null;
};
type LocationRow = { workSessionId: string; latitudeE6: number; longitudeE6: number; speedCms: number | null; recordedAt: string };
type IntegrityRow = { type: string; status: string; details: string; occurredAt: string };

export type PerformanceDailyPoint = {
  date: string; activeMinutes: number; completedCount: number; successfulCount: number;
  travelMinutes: number; onSiteMinutes: number; missionDistanceKm: number;
  distanceKm: number; measuredMissionCount: number; firstStartAt: string | null; lastEndAt: string | null; hasActiveSession: boolean;
  gpsGapMinutes: number; internetGapMinutes: number;
};

export type PerformanceComparisonMetric = {
  current: number; previous: number; delta: number; percentChange: number | null;
};

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

function totalLocationDistanceKm(points: LocationRow[]) {
  let total = 0;
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous.workSessionId !== current.workSessionId) continue;
    const elapsedMinutes = (Date.parse(current.recordedAt) - Date.parse(previous.recordedAt)) / 60_000;
    if (elapsedMinutes <= 0 || elapsedMinutes > 20) continue;
    const segmentKm = distanceKm(previous, current);
    const speed = segmentKm / (elapsedMinutes / 60);
    if (speed <= 160) total += segmentKm;
  }
  return Math.round(total * 10) / 10;
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

function eventGapMinutes(event: IntegrityRow) {
  try { return Math.max(0, Number((JSON.parse(event.details) as { gapMinutes?: number }).gapMinutes ?? 0)); }
  catch { return 0; }
}

function dayWindows(start: string, days: number, reportEnd: string) {
  const startTimestamp = Date.parse(start);
  const reportEndTimestamp = Date.parse(reportEnd);
  return Array.from({ length: days }, (_, index) => {
    const dayStart = startTimestamp + index * 86_400_000;
    const dayEnd = Math.min(dayStart + 86_400_000, reportEndTimestamp);
    return { start: new Date(dayStart).toISOString(), end: new Date(dayEnd).toISOString() };
  }).filter(window => Date.parse(window.end) > Date.parse(window.start));
}

function comparisonMetric(current: number, previous: number): PerformanceComparisonMetric {
  const delta = Math.round((current - previous) * 10) / 10;
  return {
    current, previous, delta,
    percentChange: previous === 0 ? current === 0 ? 0 : null : Math.round(delta / Math.abs(previous) * 1000) / 10,
  };
}

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
      (SELECT COUNT(*) FROM mission_attempts ma WHERE ma.mission_id = m.id) AS attemptCount,
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
  const firstVisitSuccessful = successful.filter(m => Number(m.attemptCount || 0) <= 1);
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

  const distance = totalLocationDistanceKm(points);
  const missionTrips = missions.map(mission => missionTripMetrics(mission, points, start, end)).filter((trip): trip is MissionTrip => Boolean(trip));
  const travelMinutes = missionTrips.reduce((sum, trip) => sum + trip.travelMinutes, 0);
  const movingMinutes = missionTrips.reduce((sum, trip) => sum + trip.movingMinutes, 0);
  const stoppedMinutes = missionTrips.reduce((sum, trip) => sum + trip.stoppedMinutes, 0);
  const missionDistanceKm = Math.round(missionTrips.reduce((sum, trip) => sum + trip.distanceKm, 0) * 10) / 10;
  const onSiteMinutes = completed.reduce((sum, mission) => mission.destinationRecordedAt ? sum + clampMinutes(mission.destinationRecordedAt, mission.completedAt, start, end, nowIso) : sum, 0);
  const totalMissionMinutes = completed.reduce((sum, mission) => mission.startedAt ? sum + clampMinutes(mission.startedAt, mission.completedAt, start, end, nowIso) : sum, 0);
  const classifiedMinutes = Math.min(activeMinutes, Math.round(onSiteMinutes + travelMinutes));

  let internetGapMinutes = 0;
  const integrityEvents = integrityResult.results;
  for (const event of integrityEvents) {
    if (event.type === "device_offline") internetGapMinutes += eventGapMinutes(event);
  }
  const gpsGapMinutes = calculateGpsGapMinutes(sessions, points, start, end, now);

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
  const timedMissions = completed.filter(m => m.startedAt);
  const measuredMissionTrips = missionTrips.filter(trip => trip.coverageStatus !== "missing");
  const tripByMission = new Map(missionTrips.map(trip => [trip.missionId, trip]));
  const missionDetails = completed.map(mission => {
    const trip = tripByMission.get(mission.id);
    const totalMinutes = mission.startedAt ? clampMinutes(mission.startedAt, mission.completedAt, start, end, nowIso) : 0;
    const serviceMinutes = mission.destinationRecordedAt ? clampMinutes(mission.destinationRecordedAt, mission.completedAt, start, end, nowIso) : 0;
    return {
      id: mission.id, title: mission.title, source: mission.source, status: mission.status, result: mission.result,
      destinationName: mission.destinationName, createdAt: mission.createdAt, startedAt: mission.startedAt,
      destinationRecordedAt: mission.destinationRecordedAt, completedAt: mission.completedAt, deadlineAt: mission.deadlineAt,
      attemptCount: Number(mission.attemptCount || 0), totalMinutes, serviceMinutes,
      travelMinutes: trip?.travelMinutes ?? 0, distanceKm: trip?.distanceKm ?? 0,
      coverageStatus: trip?.coverageStatus ?? "missing", expenseAmount: Number(mission.expenseAmount || 0),
      confirmedScore: Number(mission.scoreConfirmed || 0), pendingScore: Number(mission.scorePending || 0),
    };
  });

  const dailySeries: PerformanceDailyPoint[] = dayWindows(start, performancePeriodBounds(now, period).days, end).map(window => {
    const dailySessions = sessions.filter(session => Date.parse(session.startedAt) < Date.parse(window.end) && Date.parse(session.endedAt ?? nowIso) >= Date.parse(window.start));
    const dailyPoints = points.filter(point => point.recordedAt >= window.start && point.recordedAt < window.end);
    const work = calculateWorkSessionMetrics(dailySessions, dailyPoints, window.start, window.end, now);
    const dailyCompleted = completed.filter(mission => mission.completedAt! >= window.start && mission.completedAt! < window.end);
    const dailyTrips = missionTrips.filter(trip => {
      const at = trip.destinationRecordedAt ?? trip.startedAt;
      return Boolean(at && at >= window.start && at < window.end);
    });
    const dailyMeasuredTrips = dailyTrips.filter(trip => trip.coverageStatus !== "missing");
    const dailyEvents = integrityEvents.filter(event => event.occurredAt >= window.start && event.occurredAt < window.end);
    const dailyStarts = dailySessions.map(session => session.startedAt).filter(value => value >= window.start && value < window.end).sort();
    const dailyEnds = dailySessions.map(session => session.endedAt).filter((value): value is string => Boolean(value && value >= window.start && value < window.end)).sort();
    return {
      date: window.start,
      activeMinutes: Math.floor(work.intervalMilliseconds / 60_000),
      completedCount: dailyCompleted.length,
      successfulCount: dailyCompleted.filter(mission => mission.result === "انجام شد").length,
      travelMinutes: dailyTrips.reduce((sum, trip) => sum + trip.travelMinutes, 0),
      onSiteMinutes: dailyCompleted.reduce((sum, mission) => mission.destinationRecordedAt ? sum + clampMinutes(mission.destinationRecordedAt, mission.completedAt, window.start, window.end, nowIso) : sum, 0),
      missionDistanceKm: Math.round(dailyTrips.reduce((sum, trip) => sum + trip.distanceKm, 0) * 10) / 10,
      distanceKm: totalLocationDistanceKm(dailyPoints),
      measuredMissionCount: dailyMeasuredTrips.length,
      firstStartAt: dailyStarts[0] ?? null,
      lastEndAt: dailyEnds.at(-1) ?? null,
      hasActiveSession: dailySessions.some(session => session.status === "active"),
      gpsGapMinutes: calculateGpsGapMinutes(dailySessions, dailyPoints, window.start, window.end, now),
      internetGapMinutes: dailyEvents.filter(event => event.type === "device_offline").reduce((sum, event) => sum + eventGapMinutes(event), 0),
    };
  });

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
      firstVisitSuccessfulCount: firstVisitSuccessful.length,
      followUpCount: followUp.length, openCount: open.length, pendingCount: pendingMissions.length, approvedCount: approvedMissions.length,
      rejectedCount: rejectedMissions.length, overdueCount: overdue.length, selfCreatedCount: completed.filter(m => m.source === "employee").length,
      completionRate: percent(completed.length, relevantIds.size), successRate: percent(successful.length, completed.length),
      firstVisitSuccessRate: percent(firstVisitSuccessful.length, completed.length), followUpRate: percent(followUp.length, completed.length),
      onTimeRate: percent(onTime.length, deadlineCompleted.length), timedMissionCount: timedMissions.length,
      averageMissionMinutes: timedMissions.length ? Math.round(totalMissionMinutes / timedMissions.length) : 0,
      missionDetails,
    },
    movement: {
      distanceKm: distance, missionDistanceKm, travelMinutes, movingMinutes, stoppedMinutes, onSiteMinutes,
      unclassifiedMinutes: Math.max(0, activeMinutes - classifiedMinutes), destinationCount: destinations.length,
      destinations, locationPointCount: points.length, missionTrips,
      averageTravelMinutes: missionTrips.length ? Math.round(travelMinutes / missionTrips.length) : 0,
      averageOnSiteMinutes: completed.length ? Math.round(onSiteMinutes / completed.length) : 0,
      averageMissionDistanceKm: measuredMissionTrips.length ? Math.round(missionDistanceKm / measuredMissionTrips.length * 10) / 10 : 0,
    },
    integrity: {
      eventCount: integrityEvents.length, openCount: integrityEvents.filter(e => e.status === "open").length,
      gpsGapMinutes, internetGapMinutes,
      gpsCoverageRate: percent(activeMinutes, activeMinutes + Math.max(0, Math.floor((verifiedWork.rawMilliseconds - verifiedWork.intervalMilliseconds) / 60_000))),
    },
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
    dailySeries,
  };
}

export type PerformanceUserReport = Awaited<ReturnType<typeof loadUserReport>>;

function summarizeRows(rows: PerformanceUserReport[]) {
  const sums = rows.reduce((sum, row) => ({
    activeMinutes: sum.activeMinutes + row.attendance.activeMinutes,
    rawMinutes: sum.rawMinutes + row.attendance.activeMinutes + row.attendance.unverifiedGpsMinutes,
    assignedCount: sum.assignedCount + row.missions.assignedCount,
    completedCount: sum.completedCount + row.missions.completedCount,
    successfulCount: sum.successfulCount + row.missions.successfulCount,
    firstVisitSuccessfulCount: sum.firstVisitSuccessfulCount + row.missions.firstVisitSuccessfulCount,
    followUpCount: sum.followUpCount + row.missions.followUpCount,
    timedMissionCount: sum.timedMissionCount + row.missions.timedMissionCount,
    totalMissionMinutes: sum.totalMissionMinutes + row.missions.averageMissionMinutes * row.missions.timedMissionCount,
    approvedCount: sum.approvedCount + row.missions.approvedCount,
    overdueCount: sum.overdueCount + row.missions.overdueCount,
    confirmedScore: sum.confirmedScore + row.quality.confirmedScore,
    pendingScore: sum.pendingScore + row.quality.pendingScore,
    distanceKm: sum.distanceKm + row.movement.distanceKm,
    missionDistanceKm: sum.missionDistanceKm + row.movement.missionDistanceKm,
    measuredMissionCount: sum.measuredMissionCount + row.movement.missionTrips.filter(trip => trip.coverageStatus !== "missing").length,
    travelMinutes: sum.travelMinutes + row.movement.travelMinutes,
    tripCount: sum.tripCount + row.movement.missionTrips.length,
    movingMinutes: sum.movingMinutes + row.movement.movingMinutes,
    onSiteMinutes: sum.onSiteMinutes + row.movement.onSiteMinutes,
    totalExpenses: sum.totalExpenses + row.finance.total,
    gpsGapMinutes: sum.gpsGapMinutes + row.integrity.gpsGapMinutes,
    internetGapMinutes: sum.internetGapMinutes + row.integrity.internetGapMinutes,
  }), {
    activeMinutes: 0, rawMinutes: 0, assignedCount: 0, completedCount: 0, successfulCount: 0,
    firstVisitSuccessfulCount: 0, followUpCount: 0, timedMissionCount: 0, totalMissionMinutes: 0,
    approvedCount: 0, overdueCount: 0, confirmedScore: 0, pendingScore: 0, distanceKm: 0,
    missionDistanceKm: 0, measuredMissionCount: 0, travelMinutes: 0, tripCount: 0, movingMinutes: 0,
    onSiteMinutes: 0, totalExpenses: 0, gpsGapMinutes: 0, internetGapMinutes: 0,
  });
  return {
    userCount: rows.length,
    activeMinutes: sums.activeMinutes,
    assignedCount: sums.assignedCount,
    completedCount: sums.completedCount,
    successfulCount: sums.successfulCount,
    firstVisitSuccessfulCount: sums.firstVisitSuccessfulCount,
    followUpCount: sums.followUpCount,
    approvedCount: sums.approvedCount,
    overdueCount: sums.overdueCount,
    confirmedScore: sums.confirmedScore,
    pendingScore: sums.pendingScore,
    distanceKm: Math.round(sums.distanceKm * 10) / 10,
    missionDistanceKm: Math.round(sums.missionDistanceKm * 10) / 10,
    travelMinutes: sums.travelMinutes,
    movingMinutes: sums.movingMinutes,
    onSiteMinutes: sums.onSiteMinutes,
    totalExpenses: sums.totalExpenses,
    gpsGapMinutes: sums.gpsGapMinutes,
    internetGapMinutes: sums.internetGapMinutes,
    completionRate: percent(sums.completedCount, sums.assignedCount),
    successRate: percent(sums.successfulCount, sums.completedCount),
    firstVisitSuccessRate: percent(sums.firstVisitSuccessfulCount, sums.completedCount),
    followUpRate: percent(sums.followUpCount, sums.completedCount),
    averageMissionMinutes: sums.timedMissionCount ? Math.round(sums.totalMissionMinutes / sums.timedMissionCount) : 0,
    averageTravelMinutes: sums.tripCount ? Math.round(sums.travelMinutes / sums.tripCount) : 0,
    averageOnSiteMinutes: sums.completedCount ? Math.round(sums.onSiteMinutes / sums.completedCount) : 0,
    averageMissionDistanceKm: sums.measuredMissionCount ? Math.round(sums.missionDistanceKm / sums.measuredMissionCount * 10) / 10 : 0,
    gpsCoverageRate: percent(sums.activeMinutes, sums.rawMinutes),
  };
}

function summarizeDailySeries(rows: PerformanceUserReport[]) {
  const points = new Map<string, PerformanceDailyPoint>();
  for (const row of rows) for (const point of row.dailySeries) {
    const current = points.get(point.date) ?? { date: point.date, activeMinutes: 0, completedCount: 0, successfulCount: 0, travelMinutes: 0, onSiteMinutes: 0, missionDistanceKm: 0, distanceKm: 0, measuredMissionCount: 0, firstStartAt: null, lastEndAt: null, hasActiveSession: false, gpsGapMinutes: 0, internetGapMinutes: 0 };
    current.activeMinutes += point.activeMinutes;
    current.completedCount += point.completedCount;
    current.successfulCount += point.successfulCount;
    current.travelMinutes += point.travelMinutes;
    current.onSiteMinutes += point.onSiteMinutes;
    current.missionDistanceKm = Math.round((current.missionDistanceKm + point.missionDistanceKm) * 10) / 10;
    current.distanceKm = Math.round((current.distanceKm + point.distanceKm) * 10) / 10;
    current.measuredMissionCount += point.measuredMissionCount;
    current.firstStartAt = [current.firstStartAt, point.firstStartAt].filter((value): value is string => Boolean(value)).sort()[0] ?? null;
    current.lastEndAt = [current.lastEndAt, point.lastEndAt].filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
    current.hasActiveSession ||= point.hasActiveSession;
    current.gpsGapMinutes += point.gpsGapMinutes;
    current.internetGapMinutes += point.internetGapMinutes;
    points.set(point.date, current);
  }
  return [...points.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function getPerformanceReport(
  viewer: { id: string; role: AppRole }, period: PerformancePeriod = "daily", now = new Date(),
  options: { includeComparison?: boolean } = {},
) {
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
  const totals = summarizeRows(rows);
  const dailySeries = summarizeDailySeries(rows);
  let comparison = null;
  if (options.includeComparison) {
    const comparisonNow = previousPeriodNow(now, period);
    const previousRows = await Promise.all(users.results.map(user => loadUserReport(user, period, comparisonNow)));
    const previousTotals = summarizeRows(previousRows);
    const metrics = {
      activeMinutes: comparisonMetric(totals.activeMinutes, previousTotals.activeMinutes),
      completedCount: comparisonMetric(totals.completedCount, previousTotals.completedCount),
      successRate: comparisonMetric(totals.successRate, previousTotals.successRate),
      firstVisitSuccessRate: comparisonMetric(totals.firstVisitSuccessRate, previousTotals.firstVisitSuccessRate),
      averageMissionMinutes: comparisonMetric(totals.averageMissionMinutes, previousTotals.averageMissionMinutes),
      averageTravelMinutes: comparisonMetric(totals.averageTravelMinutes, previousTotals.averageTravelMinutes),
      averageOnSiteMinutes: comparisonMetric(totals.averageOnSiteMinutes, previousTotals.averageOnSiteMinutes),
      averageMissionDistanceKm: comparisonMetric(totals.averageMissionDistanceKm, previousTotals.averageMissionDistanceKm),
      missionDistanceKm: comparisonMetric(totals.missionDistanceKm, previousTotals.missionDistanceKm),
      gpsCoverageRate: comparisonMetric(totals.gpsCoverageRate, previousTotals.gpsCoverageRate),
      gpsGapMinutes: comparisonMetric(totals.gpsGapMinutes, previousTotals.gpsGapMinutes),
      internetGapMinutes: comparisonMetric(totals.internetGapMinutes, previousTotals.internetGapMinutes),
      totalExpenses: comparisonMetric(totals.totalExpenses, previousTotals.totalExpenses),
    } satisfies Record<PerformanceMetricKey, PerformanceComparisonMetric>;
    comparison = { previousRange: performancePeriodBounds(comparisonNow, period), previousTotals, metrics };
  }
  return {
    period, range: performancePeriodBounds(now, period), rows, totals, dailySeries, comparison,
    policy: { standardStart: "۰۸:۳۰", standardDailyMinutes: STANDARD_DAY_MINUTES, overtimeStartMinutes: OVERTIME_START_MINUTES, note: "حداقل کار روزانه ۸ ساعت و ۳۰ دقیقه است؛ اضافه‌کاری فقط پس از تکمیل ۹ ساعت کارکرد واقعی محاسبه می‌شود. برای هر قطعی پیوسته GPS، ۳۰ دقیقه مهلت وجود دارد و فقط زمان اضافه بر آن از کارکرد واقعی خارج می‌شود. فاصله بین پایان و شروع مجدد جزو کارکرد نیست." },
  };
}
