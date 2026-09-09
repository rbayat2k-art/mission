import assert from "node:assert/strict";
import test from "node:test";
import { routeMotion } from "../lib/route-motion.ts";
import { loadTypescript } from "./helpers/load-typescript.mjs";

const { missionTripMetrics, multiStageMissionTrips } = await loadTypescript(new URL("../lib/performance-report.ts", import.meta.url), {
  "../db/runtime": { ensureDatabase: () => { throw new Error("Database forbidden"); } },
  "./gps-gap": {}, "./work-session-policy": {}, "./mission-location": {}, "./route-motion": { routeMotion },
});
const at = seconds => new Date(Date.UTC(2026, 8, 9, 8) + seconds * 1000).toISOString();
const point = (seconds, longitudeE6, overrides = {}) => ({ workSessionId:"session-a", latitudeE6:0, longitudeE6, speedCms:null, recordedAt:at(seconds), ...overrides });
const mission = (seconds = 40) => ({ id:"test", title:"fixture", status:"done", startedAt:at(0), startLocationRecordedAt:at(0), destinationRecordedAt:at(seconds), startLatitudeE6:0, startLongitudeE6:0, destinationLatitudeE6:0, destinationLongitudeE6:5995 });

test("speed uses precise elapsed time, not rounded report minutes", () => {
  const result = missionTripMetrics(mission(), [point(0,0),point(20,2997),point(40,5995)], at(0), at(60));
  assert.equal(result.movingMinutes,1);
  assert.equal(result.averageMovingSpeedKmh,60);
  assert.equal(result.maxSpeedKmh,60);
});
test("a corrupt device speed cannot create stationary movement or an impossible maximum", () => {
  const still = routeMotion([point(0,0,{speedCms:900000}),point(40,0,{speedCms:900000})]);
  assert.equal(still.movingMilliseconds,0);
  assert.equal(still.maxSpeedKmh,0);
  const moving = missionTripMetrics(mission(),[point(0,0,{speedCms:900000}),point(40,5995,{speedCms:900000})],at(0),at(60));
  assert.equal(moving.maxSpeedKmh,60);
});
test("GPS gaps and impossible jumps are unknown, not verified stops or speed", () => {
  for (const points of [[point(0,0),point(600,5995)], [point(0,0),point(1,10000000)], [point(0,0),point(40,5995,{workSessionId:"session-b"})]]) {
    const result = routeMotion(points);
    assert.equal(result.hasGap,true);
    assert.equal(result.maxSpeedKmh,0);
    assert.equal(result.movingMilliseconds,0);
    assert.equal(result.stoppedMilliseconds,0);
  }
});
test("short multistage segments retain their fractional time until aggregation", () => {
  const rows = [0,100].map(start => ({missionId:"m1",title:"fixture",status:"done",workSessionId:"session-a",startedAt:at(start),endedAt:at(start+20),destinationRecordedAt:at(start+20)}));
  const points = [point(0,0),point(20,2997),point(100,10000),point(120,12997)];
  const [result] = multiStageMissionTrips(rows,points,at(0),at(200));
  assert.equal(result.averageMovingSpeedKmh,60);
  assert.equal(result.movingMinutes,1);
  assert.equal(result.distanceKm,.7);
});
test("multistage report rejects GPS jumps instead of reporting them as peak speed", () => {
  const [result] = multiStageMissionTrips([{missionId:"m1",title:"fixture",workSessionId:"session-a",startedAt:at(0),endedAt:at(20)}],[point(0,0),point(20,10000000)],at(0),at(60));
  assert.equal(result.maxSpeedKmh,0);
  assert.equal(result.stoppedMinutes,0);
  assert.equal(result.coverageStatus,"partial");
});
test("sorting, duplicate timestamps and mixed walking/stopping remain finite", () => {
  const result = routeMotion([point(40,5995),point(20,2997),point(0,0),point(40,5995),point(60,5995)]);
  assert.equal(result.stoppedMilliseconds,20000);
  assert.equal(result.movingMilliseconds,40000);
  assert.ok(result.maxSpeedKmh <=160);
});
