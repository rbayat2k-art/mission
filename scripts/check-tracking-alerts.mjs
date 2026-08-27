import mysql from "mysql2/promise";
import webpush from "web-push";
import {
  evaluateTrackingPresence,
  TRACKING_ALERT_REPEAT_MS,
  trackingNotificationDecision,
} from "../lib/tracking-alert-policy.mjs";

const LOCK_NAME = "tapra:tracking-alert-check";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function alertCopy(fullName, type, state, ageSeconds) {
  const subject = type === "contact" ? "ارتباط دستگاه" : "GPS معتبر";
  if (state === "normal") return {
    type: `tracking_${type}_recovered`,
    title: `${subject} بازیابی شد`,
    message: `${fullName}: ${subject} دوباره در دسترس است. این رخداد هیچ اثر خودکاری روی امتیاز یا کارکرد ندارد.`,
  };
  const minutes = Math.max(1, Math.floor((ageSeconds ?? 0) / 60));
  return {
    type: `tracking_${type}_${state}`,
    title: type === "contact"
      ? state === "high" ? "هشدار جدی: ارتباطی از دستگاه دریافت نشده" : "ارتباطی از دستگاه دریافت نشده"
      : state === "high" ? `هشدار جدی قطع ${subject}` : `هشدار قطع ${subject}`,
    message: `${fullName}: ${type === "contact" ? "ارتباطی از دستگاه" : subject} حدود ${minutes.toLocaleString("fa-IR")} دقیقه دریافت نشده است. این هشدار فقط برای بررسی است و امتیاز یا کارکرد را تغییر نمی‌دهد.`,
  };
}

const connection = await mysql.createConnection({
  host: process.env.DB_HOST?.trim() || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: required("DB_USER"),
  password: required("DB_PASSWORD"),
  database: required("DB_NAME"),
  charset: "utf8mb4",
  timezone: "Z",
});

let lockAcquired = false;
const pushJobs = [];
try {
  const [lockRows] = await connection.execute("SELECT GET_LOCK(?, 0) AS acquired", [LOCK_NAME]);
  lockAcquired = Number(lockRows[0]?.acquired) === 1;
  if (!lockAcquired) process.exitCode = 0;
  else {
    const now = new Date();
    const nowIso = now.toISOString();
    await connection.beginTransaction();
    try {
      const [activeSessions] = await connection.execute(`SELECT ws.id AS workSessionId, ws.user_id AS userId,
        ws.started_at AS startedAt, u.full_name AS fullName, tp.last_contact_at AS lastContactAt,
        tp.last_trusted_gps_at AS lastTrustedGpsAt
        FROM work_sessions ws JOIN users u ON u.id = ws.user_id
        LEFT JOIN tracking_presence tp ON tp.work_session_id = ws.id
        WHERE ws.status = 'active' AND u.status = 'active'`);
      const [stateRows] = await connection.execute(`SELECT work_session_id AS workSessionId, user_id AS userId,
        alert_type AS alertType, state, last_transition_at AS lastTransitionAt,
        last_notification_at AS lastNotificationAt FROM tracking_alert_states`);
      const [recipientRows] = await connection.execute(`SELECT employee.id AS employeeId, manager.id AS managerId
        FROM users employee JOIN users manager ON manager.status = 'active' AND
          (manager.role IN ('owner', 'admin') OR (manager.role = 'supervisor' AND manager.id = employee.supervisor_id))
        WHERE employee.status = 'active' AND manager.id <> employee.id`);
      const states = new Map(stateRows.map((row) => [`${row.workSessionId}:${row.alertType}`, row]));
      const recipients = new Map();
      for (const row of recipientRows) recipients.set(row.employeeId, [...(recipients.get(row.employeeId) ?? []), row.managerId]);
      const activeKeys = new Set();

      const persist = async (session, alertType, next, ages, forcedReason = null) => {
        const key = `${session.workSessionId}:${alertType}`;
        activeKeys.add(key);
        const current = states.get(key);
        const fromState = current?.state ?? "normal";
        const decision = forcedReason
          ? { notify: false, reason: forcedReason }
          : trackingNotificationDecision(fromState, next.state, current?.lastNotificationAt ?? null, now);
        const stateChanged = fromState !== next.state;
        const shouldRecord = stateChanged || decision.reason === "repeat" || Boolean(forcedReason);
        const lastTransitionAt = stateChanged ? nowIso : current?.lastTransitionAt ?? nowIso;
        const lastNotificationAt = decision.notify ? nowIso : current?.lastNotificationAt ?? null;
        await connection.execute(`INSERT INTO tracking_alert_states
          (work_session_id, alert_type, user_id, state, last_observed_at, last_transition_at, last_notification_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), state = VALUES(state),
            last_observed_at = VALUES(last_observed_at), last_transition_at = VALUES(last_transition_at),
            last_notification_at = VALUES(last_notification_at), updated_at = VALUES(updated_at)`,
          [session.workSessionId, alertType, session.userId, next.state, nowIso, lastTransitionAt, lastNotificationAt, nowIso, nowIso]);

        const bucket = decision.reason === "repeat" ? Math.floor(now.getTime() / TRACKING_ALERT_REPEAT_MS) : nowIso;
        const dedupeKey = `${session.workSessionId}:${alertType}:${fromState}:${next.state}:${decision.reason}:${bucket}`;
        const integrityType = alertType === "contact" ? "tracking_contact_stale" : "tracking_gps_stale";
        const [openIntegrityRows] = await connection.execute(`SELECT id FROM integrity_events
          WHERE user_id = ? AND work_session_id = ? AND type = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
          [session.userId, session.workSessionId, integrityType]);
        let integrityEventId = openIntegrityRows[0]?.id ?? null;
        const integrityDetails = JSON.stringify({
          alertType,
          state: next.state,
          ageSeconds: next.ageSeconds,
          contactAgeSeconds: ages.contact,
          gpsAgeSeconds: ages.gps,
          transitionDedupeKey: dedupeKey,
          scoreImpact: false,
          serverCheckedAt: nowIso,
        });
        if (next.state === "normal") {
          if (integrityEventId) await connection.execute(`UPDATE integrity_events SET status = 'resolved',
            reviewed_at = ?, review_note = ?, details = ? WHERE id = ? AND status = 'open'`,
            [nowIso, forcedReason ? "پایان فعالیت یا غیرفعال‌شدن حساب؛ هشدار سیستمی بسته شد." : "ارتباط معتبر بازیابی شد؛ هشدار سیستمی بسته شد.", integrityDetails, integrityEventId]);
        } else if (integrityEventId) {
          await connection.execute("UPDATE integrity_events SET severity = ?, details = ? WHERE id = ? AND status = 'open'",
            [next.state === "high" ? "high" : "medium", integrityDetails, integrityEventId]);
        } else if (shouldRecord) {
          integrityEventId = crypto.randomUUID();
          await connection.execute(`INSERT INTO integrity_events
            (id, user_id, work_session_id, type, severity, status, details, occurred_at, created_at)
            VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
            [integrityEventId, session.userId, session.workSessionId, integrityType,
              next.state === "high" ? "high" : "medium", integrityDetails, nowIso, nowIso]);
        }
        if (!shouldRecord) return;

        const transitionId = crypto.randomUUID();
        const managerIds = decision.notify ? recipients.get(session.userId) ?? [] : [];
        const [transitionResult] = await connection.execute(`INSERT IGNORE INTO tracking_alert_transitions
          (id, dedupe_key, work_session_id, user_id, alert_type, from_state, to_state, reason,
            contact_age_seconds, gps_age_seconds, score_impact, notification_sent, occurred_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
          [transitionId, dedupeKey, session.workSessionId, session.userId, alertType, fromState, next.state,
            decision.reason, ages.contact, ages.gps, managerIds.length ? 1 : 0, nowIso, nowIso]);
        if (!transitionResult.affectedRows || !decision.notify) return;

        const copy = alertCopy(session.fullName, alertType, next.state, next.ageSeconds);
        for (const managerId of managerIds) {
          const notificationId = crypto.randomUUID();
          const notificationDedupe = `tracking:${dedupeKey}:${managerId}`;
          const [notificationResult] = await connection.execute(`INSERT IGNORE INTO notifications
            (id, user_id, dedupe_key, type, title, message, entity_type, entity_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'integrity_event', ?, ?)`,
            [notificationId, managerId, notificationDedupe, copy.type, copy.title, copy.message, integrityEventId ?? transitionId, nowIso]);
          if (notificationResult.affectedRows) pushJobs.push({ id: notificationId, userId: managerId, ...copy });
        }
      };

      for (const session of activeSessions) {
        const evaluation = evaluateTrackingPresence(session, now);
        const ages = { contact: evaluation.contact.ageSeconds, gps: evaluation.trustedGps.ageSeconds };
        await persist(session, "contact", evaluation.contact, ages);
        await persist(session, "trusted_gps", evaluation.trustedGps, ages);
      }

      for (const state of stateRows) {
        const key = `${state.workSessionId}:${state.alertType}`;
        if (activeKeys.has(key) || state.state === "normal") continue;
        await persist({
          workSessionId: state.workSessionId,
          userId: state.userId,
          fullName: "کارمند",
        }, state.alertType, { state: "normal", ageSeconds: null }, { contact: null, gps: null }, "session_ended_or_user_inactive");
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }

    const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
    const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
    if (publicKey && privateKey && pushJobs.length) {
      webpush.setVapidDetails(process.env.VAPID_SUBJECT?.trim() || "mailto:admin@taprasystem.ir", publicKey, privateKey);
      for (const job of pushJobs) {
        const [preferences] = await connection.execute("SELECT notification_enabled AS enabled FROM users WHERE id = ?", [job.userId]);
        if (!preferences[0]?.enabled) continue;
        const [subscriptions] = await connection.execute("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?", [job.userId]);
        for (const subscription of subscriptions) {
          try {
            await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, JSON.stringify({
              title: job.title,
              body: job.message,
              url: "/?panel=admin&screen=integrity",
              tag: job.type,
            }));
          } catch (error) {
            const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 0;
            if ([404, 410].includes(statusCode)) await connection.execute("DELETE FROM push_subscriptions WHERE id = ?", [subscription.id]);
          }
        }
      }
    }
  }
} finally {
  if (lockAcquired) await connection.execute("SELECT RELEASE_LOCK(?)", [LOCK_NAME]).catch(() => undefined);
  await connection.end();
}
