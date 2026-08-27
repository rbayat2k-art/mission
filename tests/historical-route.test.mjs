import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildHistoricalRoute,
  detectHistoricalRouteStops,
  HISTORICAL_ROUTE_MAX_POINTS_PER_USER,
  HISTORICAL_ROUTE_MAX_TOTAL_POINTS,
  resolveHistoricalRouteDay,
  splitHistoricalRoute,
} from "../lib/historical-route.ts";

function row(id, recordedAt, overrides = {}) {
  return {
    id,
    userId: "employee-a",
    fullName: "Employee A",
    workSessionId: "session-a",
    latitudeE6: 35_700_000,
    longitudeE6: 51_400_000,
    accuracyCm: 1_000,
    speedCms: 0,
    recordedAt,
    ...overrides,
  };
}

test("resolves one Tehran calendar day and keeps the 90-day window inclusive", () => {
  const crossedMidnight = resolveHistoricalRouteDay(null, new Date("2026-08-27T21:15:00.000Z"));
  assert.equal(crossedMidnight.ok, true);
  assert.equal(crossedMidnight.date, "2026-08-28");
  assert.equal(crossedMidnight.start, "2026-08-27T20:30:00.000Z");
  assert.equal(crossedMidnight.end, "2026-08-28T20:30:00.000Z");

  const now = new Date("2026-08-27T10:00:00.000Z");
  assert.equal(resolveHistoricalRouteDay("2026-08-27", now).ok, true);
  assert.equal(resolveHistoricalRouteDay("2026-05-30", now).ok, true);
  assert.deepEqual(resolveHistoricalRouteDay("2026-05-29", now), { ok: false, reason: "outside_retention" });
  assert.deepEqual(resolveHistoricalRouteDay("2026-08-28", now), { ok: false, reason: "future_date" });
  assert.deepEqual(resolveHistoricalRouteDay("2026-02-30", now), { ok: false, reason: "invalid_date" });
});

test("detects a stop inside 50 metres lasting at least five minutes", () => {
  const { segments } = splitHistoricalRoute([
    row("p1", "2026-08-27T06:00:00.000Z"),
    row("p2", "2026-08-27T06:02:00.000Z", { latitudeE6: 35_700_040 }),
    row("p3", "2026-08-27T06:04:00.000Z", { longitudeE6: 51_400_040 }),
    row("p4", "2026-08-27T06:05:00.000Z", { longitudeE6: 51_400_050 }),
  ]);
  const stops = detectHistoricalRouteStops(segments);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].durationMinutes, 5);
  assert.equal(stops[0].pointCount, 4);
});

test("a GPS gap over two minutes splits the line and reports both endpoints", () => {
  const threeMinuteGap = splitHistoricalRoute([
    row("p1", "2026-08-27T06:00:00.000Z"),
    row("p2", "2026-08-27T06:03:00.001Z", { latitudeE6: 35_701_000 }),
  ]);
  assert.equal(threeMinuteGap.gaps.length, 1);
  assert.equal(threeMinuteGap.segments.length, 2);
  assert.deepEqual(threeMinuteGap.segments.map((segment) => segment.points.length), [1, 1]);

  const exactlyTwoMinutes = splitHistoricalRoute([
    row("p1", "2026-08-27T06:00:00.000Z"),
    row("p2", "2026-08-27T06:02:00.000Z", { latitudeE6: 35_700_100 }),
  ]);
  assert.equal(exactlyTwoMinutes.gaps.length, 0);
  assert.equal(exactlyTwoMinutes.segments.length, 1);
});

test("caps route points per user and across the whole response", () => {
  const base = Date.parse("2026-08-27T00:00:00.000Z");
  const manyForOne = Array.from({ length: 1_000 }, (_, index) => row(`one-${index}`, new Date(base + index * 10_000).toISOString(), {
    latitudeE6: 35_000_000 + index * 500,
  }));
  const oneUser = buildHistoricalRoute(manyForOne);
  assert.ok(oneUser.coverage.returnedPointCount <= HISTORICAL_ROUTE_MAX_POINTS_PER_USER);
  assert.equal(oneUser.coverage.truncated, true);

  const manyUsers = Array.from({ length: 14 }, (_, userIndex) => Array.from({ length: 1_000 }, (_, pointIndex) => row(
    `${userIndex}-${pointIndex}`,
    new Date(base + pointIndex * 10_000).toISOString(),
    {
      userId: `employee-${String(userIndex).padStart(2, "0")}`,
      fullName: `Employee ${userIndex}`,
      workSessionId: `session-${userIndex}`,
      latitudeE6: 35_000_000 + pointIndex * 500,
    },
  ))).flat();
  const allUsers = buildHistoricalRoute(manyUsers);
  assert.ok(allUsers.coverage.returnedPointCount <= HISTORICAL_ROUTE_MAX_TOTAL_POINTS);
  assert.equal(allUsers.coverage.userCount, 14);
  assert.equal(allUsers.coverage.truncated, true);
});

test("route source preserves RBAC, active direct-report scope and no-store responses", async () => {
  const [routeSource, pageSource] = await Promise.all([
    readFile(new URL("../app/api/locations/routes/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(routeSource, /requireRole\(request, \["owner", "admin", "supervisor"\]\)/);
  assert.doesNotMatch(routeSource, /requireRole\(request, \[[^\]]*"employee"/);
  assert.match(routeSource, /supervisor_id = \? AND role = 'employee' AND status = 'active'/);
  assert.match(routeSource, /auth\.user\.role === "supervisor"/);
  assert.match(routeSource, /status: 403/);
  assert.match(routeSource, /url\.searchParams\.get\("date"\)/);
  assert.match(routeSource, /url\.searchParams\.get\("userId"\)/);
  assert.match(routeSource, /private, no-store, max-age=0/);
  assert.match(routeSource, /ROUTE_QUERY_MAX_LENGTH = 192/);
  assert.match(routeSource, /UUID_PATTERN\.test\(requestedUserId\)/);
  assert.match(routeSource, /HISTORICAL_ROUTE_MAX_TOTAL_POINTS \+ 1/);
  assert.match(routeSource, /ROUTE_MAX_STOPS = 500/);
  assert.match(routeSource, /ROUTE_MAX_GAPS = 500/);
  assert.match(pageSource, /period==="daily"/);
  assert.match(pageSource, /api\/locations\/routes\?\$\{query\.toString\(\)\}/);
  assert.match(pageSource, /routeStops=\{historicalRoute\.stops\}/);
  assert.match(pageSource, /gpsGaps=\{historicalRoute\.gpsGaps\}/);
});
