import { ensureDatabase } from "../../../db/runtime";
import { requireRole } from "../../../lib/auth";
import { getEmployeeDailySummary } from "../../../lib/employee-daily-summary";
import { parseMissionLocation } from "../../../lib/mission-location";
import { getDailyWorkMetrics, GPS_GAP_GRACE_MINUTES, OVERTIME_START_MINUTES, reconcileNineHourLimit, SELF_REPORTED_START_PENALTY, tehranDayBounds, tehranTimeTodayToIso } from "../../../lib/work-session-policy";

type WorkSessionBody = {
  action?: "start" | "end" | "self_report_start";
  location?: unknown;
  startTime?: string;
  reason?: string;
  confirmDailySummary?: boolean;
  confirmedMissionIds?: string[];
  endNote?: string;
  endTime?: string;
};

function freshLocation(input: unknown, now = new Date()) {
  const location = parseMissionLocation(input);
  if (!location || now.getTime() - Date.parse(location.recordedAt) > 2 * 60_000 || location.accuracy > 100) return null;
  return location;
}

function locationInsert(db: Awaited<ReturnType<typeof ensureDatabase>>, userId: string, sessionId: string, location: NonNullable<ReturnType<typeof freshLocation>>, receivedAt: string) {
  return db.prepare("INSERT IGNORE INTO location_points (id, client_event_id, user_id, work_session_id, latitude_e6, longitude_e6, accuracy_cm, altitude_cm, speed_cms, heading_deg, recorded_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)")
    .bind(crypto.randomUUID(), `work-session-${sessionId}-${crypto.randomUUID()}`, userId, sessionId, Math.round(location.latitude * 1_000_000), Math.round(location.longitude * 1_000_000), Math.round(location.accuracy * 100), location.recordedAt, receivedAt);
}

export async function GET(request: Request) {
  const auth = await requireRole(request, ["employee", "supervisor", "admin", "owner"]);
  if ("error" in auth) return auth.error;
  const reconciliation = await reconcileNineHourLimit(auth.user.id);
  const db = await ensureDatabase();
  const current = await db.prepare("SELECT id, status, started_at AS startedAt, ended_at AS endedAt, COALESCE(work_type, 'regular') AS workType FROM work_sessions WHERE user_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1").bind(auth.user.id).first();
  const today = reconciliation.autoEnded ? reconciliation.metrics : await getDailyWorkMetrics(auth.user.id);
  return Response.json({
    current,
    autoEnded: reconciliation.autoEnded,
    today: {
      activeMinutes: today.activeMinutes, firstStartAt: today.firstStartAt,
      lastEndAt: today.lastEndAt,
      requiredMinutes: today.requiredMinutes, overtimeStartsAtMinutes: today.overtimeStartsAtMinutes,
      overtimeMinutes: today.overtimeMinutes, unverifiedGpsMinutes: today.unverifiedGpsMinutes,
      pendingCorrectionMinutes: today.pendingCorrectionMinutes,
    },
  });
}

export async function POST(request: Request) {
  const auth = await requireRole(request, ["employee", "supervisor", "admin", "owner"]);
  if ("error" in auth) return auth.error;
  const body = await request.json().catch(() => ({})) as WorkSessionBody;
  const db = await ensureDatabase();
  const nowDate = new Date();
  const now = nowDate.toISOString();
  if (body.action !== "end") await reconcileNineHourLimit(auth.user.id, nowDate);

  if (body.action === "start") {
    const location = freshLocation(body.location, nowDate);
    if (!location) return Response.json({ error: "شروع فعالیت فقط با GPS روشن، موقعیت تازه و دقت حداکثر ۱۰۰ متر امکان‌پذیر است." }, { status: 400 });
    const existing = await db.prepare("SELECT id FROM work_sessions WHERE user_id = ? AND status = 'active'").bind(auth.user.id).first<{ id: string }>();
    if (existing) return Response.json({ error: "فعالیت باز وجود دارد." }, { status: 409 });
    const metrics = await getDailyWorkMetrics(auth.user.id, nowDate);
    const workType = metrics.regularMinutes >= OVERTIME_START_MINUTES ? "overtime" : "regular";
    const session = { id: crypto.randomUUID(), status: "active", startedAt: now, workType };
    await db.batch([
      db.prepare("INSERT INTO work_sessions (id, user_id, status, started_at, start_source, work_type, approval_status, score_penalty, created_at) VALUES (?, ?, 'active', ?, 'live', ?, 'approved', 0, ?)").bind(session.id, auth.user.id, now, workType, now),
      locationInsert(db, auth.user.id, session.id, location, now),
      db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'work_session.started_with_gps', 'work_session', ?, ?, ?)")
        .bind(crypto.randomUUID(), auth.user.id, session.id, JSON.stringify({ workType, accuracy: Math.round(location.accuracy), recordedAt: location.recordedAt }), now),
    ]);
    return Response.json({ session, policy: { overtime: workType === "overtime" } }, { status: 201 });
  }

  if (body.action === "self_report_start") {
    const location = freshLocation(body.location, nowDate);
    if (!location) return Response.json({ error: "برای ثبت خوداظهاری و شروع فعالیت فعلی، GPS تازه با دقت حداکثر ۱۰۰ متر لازم است." }, { status: 400 });
    const reason = body.reason?.trim() ?? "";
    if (reason.length < 10 || reason.length > 500) return Response.json({ error: "دلیل فراموشی شروع فعالیت باید بین ۱۰ تا ۵۰۰ کاراکتر باشد." }, { status: 400 });
    const claimedStart = tehranTimeTodayToIso(body.startTime ?? "", nowDate);
    const { start: dayStart } = tehranDayBounds(nowDate);
    if (!claimedStart || Date.parse(claimedStart) < Date.parse(dayStart) || Date.parse(claimedStart) >= nowDate.getTime() - 60_000) return Response.json({ error: "ساعت خوداظهاری باید مربوط به امروز و حداقل یک دقیقه قبل باشد." }, { status: 400 });
    const existing = await db.prepare("SELECT id FROM work_sessions WHERE user_id = ? AND status = 'active'").bind(auth.user.id).first<{ id: string }>();
    if (existing) return Response.json({ error: "برای خوداظهاری نباید فعالیت بازی وجود داشته باشد." }, { status: 409 });
    const overlap = await db.prepare("SELECT id FROM work_sessions WHERE user_id = ? AND COALESCE(approval_status, 'approved') <> 'rejected' AND started_at < ? AND COALESCE(ended_at, ?) > ? LIMIT 1")
      .bind(auth.user.id, now, now, claimedStart).first<{ id: string }>();
    if (overlap) return Response.json({ error: "بازه خوداظهاری با یک فعالیت ثبت‌شده دیگر هم‌پوشانی دارد." }, { status: 409 });

    const metrics = await getDailyWorkMetrics(auth.user.id, nowDate);
    const remainingRegularMinutes = Math.max(0, OVERTIME_START_MINUTES - metrics.regularMinutes);
    if (remainingRegularMinutes <= 0) return Response.json({ error: "۹ ساعت کار عادی تکمیل شده است؛ فعالیت جدید را به‌عنوان اضافه‌کاری شروع کنید." }, { status: 409 });
    const maximumClaimEnd = Date.parse(claimedStart) + remainingRegularMinutes * 60_000;
    const claimedEnd = new Date(Math.min(nowDate.getTime(), maximumClaimEnd)).toISOString();
    const claimedMinutes = Math.max(1, Math.floor((Date.parse(claimedEnd) - Date.parse(claimedStart)) / 60_000));
    const correctionId = crypto.randomUUID();
    const liveSessionId = crypto.randomUUID();
    const liveWorkType = metrics.regularMinutes + claimedMinutes >= OVERTIME_START_MINUTES ? "overtime" : "regular";
    const eventId = crypto.randomUUID();
    await db.batch([
      db.prepare("INSERT INTO work_sessions (id, user_id, status, started_at, ended_at, end_note, start_source, end_source, work_type, approval_status, score_penalty, created_at) VALUES (?, ?, 'ended', ?, ?, ?, 'self_reported', 'self_report_submitted', 'regular', 'pending', ?, ?)")
        .bind(correctionId, auth.user.id, claimedStart, claimedEnd, reason, SELF_REPORTED_START_PENALTY, now),
      db.prepare("INSERT INTO work_sessions (id, user_id, status, started_at, start_source, work_type, approval_status, score_penalty, created_at) VALUES (?, ?, 'active', ?, 'live', ?, 'approved', 0, ?)")
        .bind(liveSessionId, auth.user.id, now, liveWorkType, now),
      locationInsert(db, auth.user.id, liveSessionId, location, now),
      db.prepare("INSERT INTO integrity_events (id, user_id, work_session_id, type, severity, details, occurred_at, created_at) VALUES (?, ?, ?, 'self_reported_work_start', 'high', ?, ?, ?)")
        .bind(eventId, auth.user.id, correctionId, JSON.stringify({ sessionId: correctionId, claimedStart, claimedEnd, claimedMinutes, reason, scorePenalty: SELF_REPORTED_START_PENALTY }), now, now),
      db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'work_session.self_reported_start', 'work_session', ?, ?, ?)")
        .bind(crypto.randomUUID(), auth.user.id, correctionId, JSON.stringify({ claimedStart, claimedEnd, claimedMinutes, reason, scorePenalty: SELF_REPORTED_START_PENALTY, approvalStatus: "pending", continuedSessionId: liveSessionId }), now),
    ]);
    return Response.json({
      correction: { id: correctionId, status: "pending", startedAt: claimedStart, endedAt: claimedEnd, claimedMinutes, scorePenalty: SELF_REPORTED_START_PENALTY },
      session: { id: liveSessionId, status: "active", startedAt: now, workType: liveWorkType },
    }, { status: 201 });
  }

  if (body.action === "end") {
    const location = freshLocation(body.location, nowDate);
    const current = await db.prepare("SELECT id, started_at AS startedAt FROM work_sessions WHERE user_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1").bind(auth.user.id).first<{ id: string; startedAt: string }>();
    if (!current) return Response.json({ error: "فعالیت بازی وجود ندارد." }, { status: 409 });
    const requestedEndTime = Date.parse(body.endTime ?? "");
    const requestedEndIsValid = Number.isFinite(requestedEndTime) && requestedEndTime >= Date.parse(current.startedAt) && requestedEndTime <= nowDate.getTime() + 2 * 60_000;
    const endedAt = new Date(requestedEndIsValid ? Math.min(requestedEndTime, nowDate.getTime()) : nowDate.getTime()).toISOString();
    const endedAtDate = new Date(endedAt);
    if (!body.confirmDailySummary) return Response.json({ error: "تأیید فهرست فعالیت‌های امروز برای پایان کار الزامی است." }, { status: 400 });
    const endNote = body.endNote?.trim() ?? "";
    if (endNote.length < 3) return Response.json({ error: "ثبت توضیحات پایان فعالیت الزامی است." }, { status: 400 });
    if (endNote.length > 1000) return Response.json({ error: "توضیحات پایان فعالیت نباید بیشتر از ۱۰۰۰ کاراکتر باشد." }, { status: 400 });
    const summary = await getEmployeeDailySummary(auth.user.id, endedAtDate);
    const confirmedMissionIds = [...new Set(body.confirmedMissionIds ?? [])].sort();
    if (JSON.stringify(confirmedMissionIds) !== JSON.stringify(summary.confirmationMissionIds)) return Response.json({ error: "فهرست فعالیت‌ها تغییر کرده است؛ گزارش امروز را دوباره مرور و تأیید کنید." }, { status: 409 });
    const previousPoint = await db.prepare("SELECT recorded_at AS recordedAt FROM location_points WHERE user_id = ? AND work_session_id = ? AND recorded_at <= ? ORDER BY recorded_at DESC LIMIT 1")
      .bind(auth.user.id, current.id, endedAt).first<{ recordedAt: string }>();
    const gapStartedAt = previousPoint?.recordedAt ?? current.startedAt;
    const gapEndedAt = location?.recordedAt ?? endedAt;
    const gapMinutes = Math.max(0, Math.floor((Date.parse(gapEndedAt) - Date.parse(gapStartedAt)) / 60_000));
    const deductedMinutes = Math.max(0, gapMinutes - GPS_GAP_GRACE_MINUTES);
    const statements = [
      db.prepare("UPDATE work_sessions SET status = 'ended', ended_at = ?, end_source = ?, end_note = ? WHERE id = ?").bind(endedAt, location ? "employee" : "employee_without_gps", endNote, current.id),
      db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'work_session.daily_summary_confirmed', 'work_session', ?, ?, ?)").bind(crypto.randomUUID(), auth.user.id, current.id, JSON.stringify({ completedCount: summary.completed.length, incompleteCount: summary.incomplete.length, missionIds: summary.confirmationMissionIds, endNoteRecorded: true, endNoteLength: endNote.length, endedAt, clientEndTimeAccepted: requestedEndIsValid, gpsAtEnd: Boolean(location), gpsRecordedAt: location?.recordedAt ?? null, gpsGraceMinutes: GPS_GAP_GRACE_MINUTES, deductedMinutes }), now),
    ];
    if (location) statements.unshift(locationInsert(db, auth.user.id, current.id, location, now));
    if (deductedMinutes > 0) {
      statements.push(db.prepare("INSERT INTO integrity_events (id, user_id, work_session_id, type, severity, details, occurred_at, created_at) VALUES (?, ?, ?, 'gps_gap', 'high', ?, ?, ?)").bind(
        crypto.randomUUID(), auth.user.id, current.id, JSON.stringify({ previousAt: gapStartedAt, resumedAt: location?.recordedAt ?? null, endedAt, gapMinutes, graceMinutes: GPS_GAP_GRACE_MINUTES, deductedMinutes, detectedAtWorkEnd: true }), endedAt, now,
      ));
    }
    await db.batch(statements);
    const metrics = await getDailyWorkMetrics(auth.user.id, endedAtDate);
    return Response.json({ session: { id: current.id, status: "ended", endedAt }, today: metrics, gpsAtEnd: Boolean(location), gpsWarning: !location, deductedMinutes });
  }
  return Response.json({ error: "عملیات نامعتبر است." }, { status: 400 });
}
