export const TRACKING_CONTACT_WARNING_MS = 5 * 60_000;
export const TRACKING_CONTACT_HIGH_MS = 15 * 60_000;
export const TRACKING_GPS_WARNING_MS = 5 * 60_000;
export const TRACKING_GPS_HIGH_MS = 10 * 60_000;
export const TRACKING_ALERT_REPEAT_MS = 30 * 60_000;

export function evaluateTrackingSignal(lastSeenAt, now, warningMs, highMs) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const lastSeenMs = Date.parse(String(lastSeenAt ?? ""));
  const ageMs = Number.isFinite(lastSeenMs) ? Math.max(0, nowMs - lastSeenMs) : Number.POSITIVE_INFINITY;
  return {
    state: ageMs >= highMs ? "high" : ageMs >= warningMs ? "warning" : "normal",
    ageMs,
    ageSeconds: Number.isFinite(ageMs) ? Math.floor(ageMs / 1000) : null,
  };
}

export function evaluateTrackingPresence({ startedAt, lastContactAt, lastTrustedGpsAt }, now = new Date()) {
  return {
    contact: evaluateTrackingSignal(lastContactAt ?? startedAt, now, TRACKING_CONTACT_WARNING_MS, TRACKING_CONTACT_HIGH_MS),
    trustedGps: evaluateTrackingSignal(lastTrustedGpsAt ?? startedAt, now, TRACKING_GPS_WARNING_MS, TRACKING_GPS_HIGH_MS),
  };
}

export function trackingNotificationDecision(currentState, nextState, lastNotificationAt, now = new Date()) {
  if (currentState !== nextState) {
    return {
      notify: nextState !== "normal" || currentState !== "normal",
      reason: nextState === "normal" ? "recovered" : "state_changed",
    };
  }
  if (nextState === "normal") return { notify: false, reason: "unchanged" };
  const lastNotificationMs = Date.parse(String(lastNotificationAt ?? ""));
  const repeatDue = !Number.isFinite(lastNotificationMs) || now.getTime() - lastNotificationMs >= TRACKING_ALERT_REPEAT_MS;
  return { notify: repeatDue, reason: repeatDue ? "repeat" : "unchanged" };
}
