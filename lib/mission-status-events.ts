import { database, type PreparedStatement } from "./server-database";
import type { CapturedMissionLocation } from "./mission-location";
import { APP_VERSION } from "./app-version";

type PrepareTarget = { prepare(query: string): PreparedStatement };

export type MissionStatusEventInput = {
  missionId: string;
  attemptNo?: number | null;
  actorId: string;
  actorRole: string;
  eventType: "created" | "started" | "destination_registered" | "status_set" | "start_cancelled" | "follow_up_decision" | "approval_decision";
  fromStatus?: string | null;
  toStatus?: string | null;
  result?: string | null;
  serverRecordedAt: string;
  location?: CapturedMissionLocation | null;
  metadata?: Record<string, unknown> | null;
};

export function prepareMissionStatusEvent(target: PrepareTarget, input: MissionStatusEventInput) {
  const id = crypto.randomUUID();
  const location = input.location ?? null;
  const statement = target.prepare(`INSERT INTO mission_status_events (
    id, mission_id, attempt_no, actor_id, actor_role, event_type, from_status, to_status, result,
    server_recorded_at, device_recorded_at, latitude_e6, longitude_e6, accuracy_cm, geocode_status, metadata, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    id, input.missionId, input.attemptNo ?? null, input.actorId, input.actorRole, input.eventType,
    input.fromStatus ?? null, input.toStatus ?? null, input.result ?? null, input.serverRecordedAt,
    location?.recordedAt ?? null, location ? Math.round(location.latitude * 1_000_000) : null,
    location ? Math.round(location.longitude * 1_000_000) : null,
    location ? Math.round(location.accuracy * 100) : null, location ? "pending" : "not_requested",
    input.metadata ? JSON.stringify(input.metadata) : null, input.serverRecordedAt,
  );
  return { id, statement };
}

type GeocodeAddress = {
  locationLabel: string | null;
  street: string | null;
  neighborhood: string | null;
  district: string | null;
  city: string | null;
  province: string | null;
};

type CacheRow = GeocodeAddress & { provider: string };

let geocodeQueue: Promise<void> = Promise.resolve();
let lastPublicRequestAt = 0;

function uniqueParts(values: Array<string | null>) {
  return values.filter((value, index): value is string => Boolean(value) && values.indexOf(value) === index);
}

function normalizeAddress(raw: unknown): GeocodeAddress {
  const root = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const address = root.address && typeof root.address === "object" ? root.address as Record<string, unknown> : {};
  const value = (...keys: string[]) => keys.map((key) => address[key]).find((item) => typeof item === "string" && item.trim()) as string | undefined;
  const street = value("road", "pedestrian", "footway", "residential", "highway") ?? null;
  const neighborhood = value("neighbourhood", "suburb", "quarter", "city_district") ?? null;
  const district = value("district", "borough", "county", "state_district") ?? null;
  const city = value("city", "town", "village", "municipality") ?? null;
  const province = value("state", "province") ?? null;
  const parts = uniqueParts([street, neighborhood, district, city, province]);
  return { locationLabel: parts.length ? `نزدیک ${parts.join("، ")}` : null, street, neighborhood, district, city, province };
}

async function wait(milliseconds: number) {
  if (milliseconds <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function reverseGeocode(location: CapturedMissionLocation): Promise<GeocodeAddress> {
  const endpoint = process.env.REVERSE_GEOCODING_URL?.trim() || "https://nominatim.openstreetmap.org/reverse";
  if (endpoint.includes("nominatim.openstreetmap.org")) {
    await wait(Math.max(0, 1_100 - (Date.now() - lastPublicRequestAt)));
    lastPublicRequestAt = Date.now();
  }
  const url = new URL(endpoint);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(location.latitude));
  url.searchParams.set("lon", String(location.longitude));
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("zoom", "18");
  url.searchParams.set("layer", "address");
  url.searchParams.set("accept-language", "fa");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_500);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": `TapraSystem/${APP_VERSION} (https://taprasystem.ir)`, "Accept-Language": "fa" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Reverse geocoder returned ${response.status}`);
    return normalizeAddress(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

function serializeGeocode<T>(task: () => Promise<T>): Promise<T> {
  const result = geocodeQueue.catch(() => undefined).then(task);
  geocodeQueue = result.then(() => undefined, () => undefined);
  return result;
}

function coordinateKey(location: CapturedMissionLocation) {
  return `${location.latitude.toFixed(4)}:${location.longitude.toFixed(4)}`;
}

async function applyAddress(eventId: string, address: GeocodeAddress, provider: string, status = "resolved") {
  const now = new Date().toISOString();
  await database.prepare(`UPDATE mission_status_events SET location_label=?, street=?, neighborhood=?, district=?, city=?, province=?,
    geocode_provider=?, geocode_status=?, geocoded_at=? WHERE id=?`).bind(
    address.locationLabel, address.street, address.neighborhood, address.district, address.city, address.province,
    provider, status, now, eventId,
  ).run();
}

export async function enrichMissionStatusEventLocation(eventId: string, location: CapturedMissionLocation) {
  try {
    const key = coordinateKey(location);
    const cached = await database.prepare(`SELECT location_label AS locationLabel, street, neighborhood, district, city, province, provider
      FROM reverse_geocode_cache WHERE coordinate_key=?`).bind(key).first<CacheRow>();
    if (cached) {
      await applyAddress(eventId, cached, cached.provider);
      return;
    }
    const address = await serializeGeocode(() => reverseGeocode(location));
    const now = new Date().toISOString();
    await database.prepare(`INSERT INTO reverse_geocode_cache (coordinate_key, latitude_e6, longitude_e6, location_label, street, neighborhood, district, city, province, provider, cached_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'nominatim', ?)
      ON DUPLICATE KEY UPDATE location_label=VALUES(location_label), street=VALUES(street), neighborhood=VALUES(neighborhood), district=VALUES(district), city=VALUES(city), province=VALUES(province), provider=VALUES(provider), cached_at=VALUES(cached_at)`).bind(
      key, Math.round(location.latitude * 1_000_000), Math.round(location.longitude * 1_000_000), address.locationLabel,
      address.street, address.neighborhood, address.district, address.city, address.province, now,
    ).run();
    await applyAddress(eventId, address, "nominatim", address.locationLabel ? "resolved" : "unavailable");
  } catch {
    await database.prepare("UPDATE mission_status_events SET geocode_status='failed', geocoded_at=? WHERE id=?")
      .bind(new Date().toISOString(), eventId).run().catch(() => undefined);
  }
}
