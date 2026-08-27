export type IncomingLocationPoint = {
  clientEventId?: string;
  workSessionId?: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  altitude?: number | null;
  speed?: number | null;
  heading?: number | null;
  recordedAt?: string;
  mocked?: boolean;
};

export type LocationSessionWindow = {
  id: string;
  userId?: string;
  startedAt: string;
  endedAt: string | null;
  status: string;
};

export type ExistingLocationEvent = {
  clientEventId: string;
  userId: string;
  workSessionId: string;
};

export type PermanentLocationRejection = {
  clientEventId: string;
  reason: "invalid_point" | "mock_location" | "unknown_or_foreign_session" | "outside_session_window" | "event_id_conflict";
};

export type RetryableLocationRejection = {
  clientEventId: string;
  reason: "session_not_ready";
};

export type ClassifiedLocationPoint = IncomingLocationPoint & {
  clientEventId: string;
  workSessionId: string;
  latitude: number;
  longitude: number;
  accuracy: number;
  recordedAt: string;
};

export type LocationBatchClassification = {
  candidates: ClassifiedLocationPoint[];
  duplicateIds: string[];
  permanentRejected: PermanentLocationRejection[];
  retryableRejected: RetryableLocationRejection[];
  unidentifiedRejected: number;
};

function hasValidEventId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 8 && value.trim().length <= 100;
}

function hasValidSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(value.trim());
}

function validCoordinates(point: IncomingLocationPoint) {
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude) && Number.isFinite(point.accuracy) &&
    point.latitude! >= -90 && point.latitude! <= 90 && point.longitude! >= -180 && point.longitude! <= 180 &&
    point.accuracy! >= 0 && point.accuracy! <= 10_000 && Number.isFinite(Date.parse(point.recordedAt ?? ""));
}

export function classifyLocationBatch(input: {
  points: IncomingLocationPoint[];
  userId: string;
  sessions: LocationSessionWindow[];
  activeSessionId: string | null;
  existingEvents: ExistingLocationEvent[];
  receivedAt: string;
  clockSkewMs: number;
}): LocationBatchClassification {
  const sessions = new Map(input.sessions.map((session) => [session.id, session]));
  const existing = new Map(input.existingEvents.map((event) => [event.clientEventId, event]));
  const seen = new Set<string>();
  const candidates: ClassifiedLocationPoint[] = [];
  const duplicateIds: string[] = [];
  const permanentRejected: PermanentLocationRejection[] = [];
  const retryableRejected: RetryableLocationRejection[] = [];
  let unidentifiedRejected = 0;
  const maximumRecordedAt = Date.parse(input.receivedAt) + input.clockSkewMs;

  for (const raw of input.points.slice(0, 100)) {
    if (!hasValidEventId(raw.clientEventId)) {
      unidentifiedRejected += 1;
      continue;
    }
    const clientEventId = raw.clientEventId.trim();
    if (seen.has(clientEventId)) {
      duplicateIds.push(clientEventId);
      continue;
    }
    seen.add(clientEventId);

    if (!validCoordinates(raw)) {
      permanentRejected.push({ clientEventId, reason: "invalid_point" });
      continue;
    }

    const existingEvent = existing.get(clientEventId);
    if (existingEvent) {
      if (existingEvent.userId === input.userId) duplicateIds.push(clientEventId);
      else permanentRejected.push({ clientEventId, reason: "event_id_conflict" });
      continue;
    }

    if (raw.mocked === true) {
      permanentRejected.push({ clientEventId, reason: "mock_location" });
      continue;
    }

    // Legacy browser/native points may omit the session only while the matching
    // current session is still active. Historical points must name their session.
    const hasExplicitSession = typeof raw.workSessionId === "string" && raw.workSessionId.trim().length > 0;
    if (hasExplicitSession && !hasValidSessionId(raw.workSessionId)) {
      permanentRejected.push({ clientEventId, reason: "unknown_or_foreign_session" });
      continue;
    }
    const workSessionId = hasExplicitSession ? raw.workSessionId!.trim() : input.activeSessionId;
    if (!workSessionId) {
      permanentRejected.push({ clientEventId, reason: "unknown_or_foreign_session" });
      continue;
    }
    const session = sessions.get(workSessionId);
    if (!session && hasExplicitSession) {
      retryableRejected.push({ clientEventId, reason:"session_not_ready" });
      continue;
    }
    if (!session || (session.userId != null && session.userId !== input.userId) || (!hasExplicitSession && session.status !== "active")) {
      permanentRejected.push({ clientEventId, reason: "unknown_or_foreign_session" });
      continue;
    }

    const recordedAt = Date.parse(raw.recordedAt!);
    const minimumRecordedAt = Date.parse(session.startedAt) - input.clockSkewMs;
    const sessionMaximum = session.endedAt
      ? Date.parse(session.endedAt) + input.clockSkewMs
      : maximumRecordedAt;
    if (recordedAt < minimumRecordedAt || recordedAt > Math.min(sessionMaximum, maximumRecordedAt)) {
      permanentRejected.push({ clientEventId, reason: "outside_session_window" });
      continue;
    }

    candidates.push({
      ...raw,
      clientEventId,
      workSessionId,
      latitude: raw.latitude!,
      longitude: raw.longitude!,
      accuracy: raw.accuracy!,
      recordedAt: new Date(recordedAt).toISOString(),
    });
  }

  return { candidates, duplicateIds, permanentRejected, retryableRejected, unidentifiedRejected };
}
