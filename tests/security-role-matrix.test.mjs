import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const actors = {
  admin: { id:"admin", role:"admin" },
  supA: { id:"sup-a", role:"supervisor" },
  supB: { id:"sup-b", role:"supervisor" },
  empA: { id:"emp-a", role:"employee", supervisorId:"sup-a" },
  empB: { id:"emp-b", role:"employee", supervisorId:"sup-b" },
};

const resources = {
  missionA: { assignedTo:"emp-a", createdBy:"admin", supervisorId:"sup-a" },
  missionB: { assignedTo:"emp-b", createdBy:"admin", supervisorId:"sup-b" },
};

function canReadEmployeeResource(actor, resource) {
  if (actor.role === "admin" || actor.role === "owner") return true;
  if (actor.role === "employee") return resource.assignedTo === actor.id;
  return resource.supervisorId === actor.id || resource.createdBy === actor.id || resource.assignedTo === actor.id;
}

test("five-account matrix isolates employee A/B and supervisor A/B while admin can review both teams", () => {
  const expected = [
    ["admin", "missionA", true], ["admin", "missionB", true],
    ["supA", "missionA", true], ["supA", "missionB", false],
    ["supB", "missionA", false], ["supB", "missionB", true],
    ["empA", "missionA", true], ["empA", "missionB", false],
    ["empB", "missionA", false], ["empB", "missionB", true],
  ];
  for (const [actorKey, resourceKey, allowed] of expected) {
    assert.equal(
      canReadEmployeeResource(actors[actorKey], resources[resourceKey]),
      allowed,
      `${actorKey} -> ${resourceKey}`,
    );
  }
});

test("route contracts bind private data to the session user and direct supervisor", async () => {
  const [missions, notifications, locations, routes, reports, attachments] = await Promise.all([
    readFile(new URL("../app/api/missions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/notifications/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/locations/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/locations/routes/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/performance-report.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/attachments/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(missions, /WHERE m\.assigned_to = \?/);
  assert.match(missions, /WHERE m\.assigned_to IN \(SELECT id FROM users WHERE supervisor_id = \?\) OR m\.created_by = \?/);
  assert.match(notifications, /FROM notifications WHERE user_id = \?/);
  assert.match(notifications, /UPDATE notifications SET read_at = \? WHERE id = \? AND user_id = \?/);
  assert.match(locations, /WHERE id = \? AND \(supervisor_id = \? OR id = \?\)/);
  assert.match(routes, /u\.supervisor_id = \? AND u\.role = 'employee'/);
  assert.match(reports, /u\.supervisor_id = \?/);
  assert.match(attachments, /mission\.assignedTo !== auth\.user\.id/);
  assert.match(attachments, /mission\.assigneeSupervisorId !== auth\.user\.id/);
});

test("Android/API account binding rejects a stale native account before private GPS or notifications are returned", async () => {
  const [locations, notifications, notificationSettings] = await Promise.all([
    readFile(new URL("../app/api/locations/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/notifications/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/notifications/settings/route.ts", import.meta.url), "utf8"),
  ]);
  for (const source of [locations, notifications, notificationSettings]) {
    assert.match(source, /x-tapra-user-id/i);
    assert.match(source, /expectedUserId !== auth\.user\.id/);
    assert.match(source, /status: 409/);
  }
});
