import assert from "node:assert/strict";
import test from "node:test";

import { locationBatchHasFinalAck } from "../lib/offline-client.ts";

const points = [
  { clientEventId:"accepted-id" },
  { clientEventId:"duplicate-id" },
  { clientEventId:"poison-id" },
];

test("a mixed location batch is removable only when every point has an explicit terminal acknowledgement", () => {
  assert.equal(locationBatchHasFinalAck(points, {
    acceptedIds:["accepted-id"],
    duplicateIds:["duplicate-id"],
    permanentRejected:[{ clientEventId:"poison-id" }],
    retryableRejected:[],
  }), true);
});

test("missing acknowledgement or a retryable point keeps the location batch", () => {
  assert.equal(locationBatchHasFinalAck(points, { acceptedIds:["accepted-id"] }), false);
  assert.equal(locationBatchHasFinalAck(points, {
    acceptedIds:["accepted-id"],
    duplicateIds:["duplicate-id"],
    permanentRejected:[{ clientEventId:"poison-id" }],
    retryableRejected:[{ clientEventId:"duplicate-id" }],
  }), false);
});

test("a retained partial batch becomes removable after retry returns duplicate and accepted acknowledgements", () => {
  const retryPoints = [{clientEventId:"already-stored"}, {clientEventId:"session-was-pending"}];
  assert.equal(locationBatchHasFinalAck(retryPoints, {
    acceptedIds:["already-stored"],
    retryableRejected:[{clientEventId:"session-was-pending"}],
  }), false);
  assert.equal(locationBatchHasFinalAck(retryPoints, {
    duplicateIds:["already-stored"],
    acceptedIds:["session-was-pending"],
    retryableRejected:[],
  }), true);
});
