export type CapturedMissionLocation = {
  latitude: number;
  longitude: number;
  accuracy: number;
  recordedAt: string;
};

export function parseMissionLocation(input: unknown): CapturedMissionLocation | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  const accuracy = Number(value.accuracy);
  const recordedTime = Date.parse(String(value.recordedAt ?? ""));
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
    !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
    !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 10_000 ||
    Number.isNaN(recordedTime) || recordedTime > Date.now() + 5 * 60_000) return null;
  return { latitude, longitude, accuracy, recordedAt: new Date(recordedTime).toISOString() };
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
