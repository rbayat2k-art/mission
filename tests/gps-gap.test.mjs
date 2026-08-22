import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

async function loadGpsGapCalculator() {
  const source = await readFile(new URL("../lib/gps-gap.ts", import.meta.url), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

function session(overrides = {}) {
  return {
    id: "session-1",
    startedAt: "2026-08-22T08:00:00.000Z",
    endedAt: "2026-08-22T09:00:00.000Z",
    startSource: "live",
    approvalStatus: "approved",
    ...overrides,
  };
}

function minutePoints(sessionId, startMinute, endMinute) {
  return Array.from({ length: endMinute - startMinute + 1 }, (_, index) => ({
    workSessionId: sessionId,
    recordedAt: `2026-08-22T08:${String(startMinute + index).padStart(2, "0")}:00.000Z`,
  }));
}

test("GPS gaps are measured from work-session boundaries instead of integrity-event totals", async () => {
  const { calculateGpsGapMinutes } = await loadGpsGapCalculator();
  const points = [
    ...minutePoints("session-1", 0, 9),
    ...minutePoints("session-1", 20, 59),
    { workSessionId: "session-1", recordedAt: "2026-08-22T09:00:00.000Z" },
  ];
  const result = calculateGpsGapMinutes(
    [session()],
    points,
    "2026-08-22T00:00:00.000Z",
    "2026-08-23T00:00:00.000Z",
    new Date("2026-08-22T12:00:00.000Z"),
  );
  assert.equal(result, 11);
});

test("ongoing GPS gaps are visible before the employee ends activity", async () => {
  const { calculateGpsGapMinutes } = await loadGpsGapCalculator();
  const points = Array.from({ length: 6 }, (_, minute) => ({
    workSessionId: "session-1",
    recordedAt: `2026-08-22T10:0${minute}:00.000Z`,
  }));
  const result = calculateGpsGapMinutes(
    [session({ endedAt: null, startedAt: "2026-08-22T10:00:00.000Z" })],
    points,
    "2026-08-22T00:00:00.000Z",
    "2026-08-23T00:00:00.000Z",
    new Date("2026-08-22T10:30:00.000Z"),
  );
  assert.equal(result, 25);
});

test("time outside activity and historical self-reported sessions never become GPS gaps", async () => {
  const { calculateGpsGapMinutes } = await loadGpsGapCalculator();
  const result = calculateGpsGapMinutes(
    [session({ startSource: "self_reported" })],
    [],
    "2026-08-22T00:00:00.000Z",
    "2026-08-23T00:00:00.000Z",
    new Date("2026-08-22T12:00:00.000Z"),
  );
  assert.equal(result, 0);
});
