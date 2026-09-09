import assert from "node:assert/strict";
import test from "node:test";

import { classifyLocationBatch } from "../lib/location-batch.ts";

test("invalid optional speed does not poison a valid GPS point", () => {
  for (const speed of [-1, Infinity, NaN, "20", 1000]) {
    const result = classify([point("event-speed-00001", { speed, altitude:Infinity, heading:-1 })]);
    assert.equal(result.candidates.length,1);
    assert.equal(result.candidates[0].speed,null);
    assert.equal(result.candidates[0].altitude,null);
    assert.equal(result.candidates[0].heading,null);
  }
  assert.equal(classify([point("event-speed-00001",{speed:0})]).candidates[0].speed,0);
  assert.equal(classify([point("event-speed-00001",{speed:10})]).candidates[0].speed,10);
  assert.equal(classify([null,23,[],point("event-speed-00001")]).candidates.length,1);
});

const activeId = "11111111-1111-4111-8111-111111111111";
const closedId = "22222222-2222-4222-8222-222222222222";
const foreignId = "33333333-3333-4333-8333-333333333333";
const receivedAt = "2026-08-27T12:00:00.000Z";

function point(id, overrides = {}) {
  return {
    clientEventId:id,
    workSessionId:activeId,
    latitude:35.7,
    longitude:51.4,
    accuracy:12,
    recordedAt:"2026-08-27T11:59:00.000Z",
    ...overrides,
  };
}

function classify(points, existingEvents = []) {
  return classifyLocationBatch({
    points,
    userId:"employee-a",
    activeSessionId:activeId,
    sessions:[
      { id:activeId, userId:"employee-a", startedAt:"2026-08-27T08:00:00.000Z", endedAt:null, status:"active" },
      { id:closedId, userId:"employee-a", startedAt:"2026-08-26T08:00:00.000Z", endedAt:"2026-08-26T16:00:00.000Z", status:"ended" },
      { id:foreignId, userId:"employee-b", startedAt:"2026-08-27T08:00:00.000Z", endedAt:null, status:"active" },
    ],
    existingEvents,
    receivedAt,
    clockSkewMs:2 * 60_000,
  });
}

test("mixed batches accept active and owned closed-session points while rejecting foreign and poison rows", () => {
  const result = classify([
    point("event-active-0001"),
    point("event-closed-0002", { workSessionId:closedId, recordedAt:"2026-08-26T12:00:00.000Z" }),
    point("event-foreign-003", { workSessionId:foreignId }),
    point("event-old-0000004", { workSessionId:closedId, recordedAt:"2026-08-25T12:00:00.000Z" }),
    point("event-mocked-0005", { mocked:true }),
    point("event-poison-0006", { latitude:999 }),
  ]);

  assert.deepEqual(result.candidates.map((item) => item.clientEventId), ["event-active-0001", "event-closed-0002"]);
  assert.deepEqual(Object.fromEntries(result.permanentRejected.map((item) => [item.clientEventId, item.reason])), {
    "event-foreign-003":"unknown_or_foreign_session",
    "event-old-0000004":"outside_session_window",
    "event-mocked-0005":"mock_location",
    "event-poison-0006":"invalid_point",
  });
});

test("known event IDs are acknowledged as duplicates and cross-user collisions are terminal conflicts", () => {
  const result = classify([
    point("event-duplicate-1"),
    point("event-conflict-02"),
  ], [
    { clientEventId:"event-duplicate-1", userId:"employee-a", workSessionId:activeId },
    { clientEventId:"event-conflict-02", userId:"employee-b", workSessionId:foreignId },
  ]);
  assert.deepEqual(result.duplicateIds, ["event-duplicate-1"]);
  assert.deepEqual(result.permanentRejected, [{ clientEventId:"event-conflict-02", reason:"event_id_conflict" }]);
});

test("legacy points without a session bind only to the current matching active session", () => {
  const accepted = classify([point("legacy-current-01", { workSessionId:undefined })]);
  assert.equal(accepted.candidates[0].workSessionId, activeId);

  const noCurrent = classifyLocationBatch({
    points:[point("legacy-no-current", { workSessionId:undefined })],
    userId:"employee-a",
    activeSessionId:null,
    sessions:[{ id:closedId, startedAt:"2026-08-26T08:00:00.000Z", endedAt:"2026-08-26T16:00:00.000Z", status:"ended" }],
    existingEvents:[], receivedAt, clockSkewMs:2*60_000,
  });
  assert.deepEqual(noCurrent.permanentRejected, [{ clientEventId:"legacy-no-current", reason:"unknown_or_foreign_session" }]);
});

test("a valid client session that is not committed yet is retryable instead of being lost", () => {
  const pendingId = "44444444-4444-4444-8444-444444444444";
  const result = classify([point("session-not-ready", { workSessionId:pendingId })]);
  assert.deepEqual(result.retryableRejected, [{ clientEventId:"session-not-ready", reason:"session_not_ready" }]);
  assert.equal(result.permanentRejected.length, 0);
});

test("unidentified poison rows are counted but cannot be falsely acknowledged", () => {
  const result = classify([{ latitude:35, longitude:51, accuracy:10, recordedAt:receivedAt }]);
  assert.equal(result.unidentifiedRejected, 1);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.permanentRejected.length, 0);
});
