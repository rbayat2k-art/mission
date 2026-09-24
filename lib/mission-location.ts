export type CapturedMissionLocation = {
  latitude: number;
  longitude: number;
  accuracy: number;
  recordedAt: string;
};

export const MAX_TRUSTED_LOCATION_ACCURACY_METERS = 100;
export const MAX_LOCATION_FUTURE_SKEW_MS = 2 * 60_000;
export const MAX_TRUSTED_LOCATION_AGE_MS = 2 * 60_000;
export const MAX_CLIENT_CLOCK_SKEW_MS = 2 * 60_000;

export type TrustedLocationErrorCode =
  | "LOCATION_MISSING"
  | "LOCATION_INVALID_COORDINATES"
  | "LOCATION_INVALID_ACCURACY"
  | "LOCATION_ACCURACY_TOO_LOW"
  | "LOCATION_INVALID_TIMESTAMP"
  | "LOCATION_STALE"
  | "LOCATION_CLOCK_SKEW"
  | "LOCATION_FUTURE_TIMESTAMP";

export type TrustedLocationValidation = {
  location: CapturedMissionLocation | null;
  code: TrustedLocationErrorCode | null;
  diagnostics: { accuracyMeters: number | null; ageMs: number | null; timestampValid: boolean; clientClockSkewMs?: number };
};

type TrustedLocationOptions = { nowMs?: number; maxAgeMs?: number; clientTimeMs?: number | null };

/** Validate a location without coercing strings/null/booleans into coordinates. Never returns coordinates in diagnostics. */
export function validateTrustedLocation(input: unknown, options: TrustedLocationOptions = {}): TrustedLocationValidation {
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? MAX_TRUSTED_LOCATION_AGE_MS;
  const emptyDiagnostics = { accuracyMeters: null, ageMs: null, timestampValid: false };
  if (!input || typeof input !== "object" || Array.isArray(input)) return { location: null, code: "LOCATION_MISSING", diagnostics: emptyDiagnostics };
  const value = input as Record<string, unknown>;
  const latitude = value.latitude;
  const longitude = value.longitude;
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return { location: null, code: "LOCATION_INVALID_COORDINATES", diagnostics: emptyDiagnostics };
  }
  const accuracy = value.accuracy;
  if (typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy < 0) {
    return { location: null, code: "LOCATION_INVALID_ACCURACY", diagnostics: emptyDiagnostics };
  }
  if (accuracy > MAX_TRUSTED_LOCATION_ACCURACY_METERS) {
    return { location: null, code: "LOCATION_ACCURACY_TOO_LOW", diagnostics: { ...emptyDiagnostics, accuracyMeters: Math.round(accuracy * 10) / 10 } };
  }
  const recordedTime = typeof value.recordedAt === "string" ? Date.parse(value.recordedAt) : Number.NaN;
  if (!Number.isFinite(recordedTime)) return { location: null, code: "LOCATION_INVALID_TIMESTAMP", diagnostics: { accuracyMeters: accuracy, ageMs: null, timestampValid: false } };
  const ageMs = nowMs - recordedTime;
  const clientTimeMs = options.clientTimeMs;
  const clientClockSkewMs = typeof clientTimeMs === "number" && Number.isFinite(clientTimeMs) ? nowMs - clientTimeMs : undefined;
  const diagnostics = { accuracyMeters: Math.round(accuracy * 10) / 10, ageMs: Math.round(ageMs), timestampValid: true, ...(clientClockSkewMs === undefined ? {} : { clientClockSkewMs: Math.round(clientClockSkewMs) }) };
  if (clientClockSkewMs !== undefined && Math.abs(clientClockSkewMs) > MAX_CLIENT_CLOCK_SKEW_MS) {
    return { location: null, code: "LOCATION_CLOCK_SKEW", diagnostics };
  }
  if (ageMs < -MAX_LOCATION_FUTURE_SKEW_MS) return { location: null, code: "LOCATION_FUTURE_TIMESTAMP", diagnostics };
  if (ageMs > maxAgeMs) return { location: null, code: "LOCATION_STALE", diagnostics };
  return { location: { latitude, longitude, accuracy, recordedAt: new Date(recordedTime).toISOString() }, code: null, diagnostics };
}

export function parseMissionLocation(input: unknown): CapturedMissionLocation | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  const validated = validateTrustedLocation(value, { maxAgeMs: Number.POSITIVE_INFINITY });
  if (validated.code === "LOCATION_STALE" || validated.code === "LOCATION_CLOCK_SKEW") return null;
  return validated.location;
}

export function locationSqlValues(location: CapturedMissionLocation) {
  return [
    Math.round(location.latitude * 1_000_000),
    Math.round(location.longitude * 1_000_000),
    Math.round(location.accuracy * 100),
    location.recordedAt,
  ] as const;
}

export function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = radians(b.latitude - a.latitude);
  const longitudeDelta = radians(b.longitude - a.longitude);
  const value = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return Math.round(6_371_000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value)));
}
