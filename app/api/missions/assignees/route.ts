import { ensureDatabase } from "../../../../db/runtime";
import { requireRole } from "../../../../lib/auth";
import { ASSIGNEE_HISTORY_DAYS, sortMissionAssignees, type MissionAssignee } from "../../../../lib/mission-assignee-order";

const privateHeaders = { "Cache-Control": "private, no-store", "Vary": "Cookie, X-Tapra-User-Id" };

export async function GET(request: Request) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor"]);
  if ("error" in auth) {
    const response = auth.error ?? Response.json({ error: "unauthorized" }, { status: 401 });
    for (const [key, value] of Object.entries(privateHeaders)) response.headers.set(key, value);
    return response;
  }
  const db = await ensureDatabase();
  const supervisor = auth.user.role === "supervisor";
  const userQuery = `SELECT id, full_name AS fullName, username, role FROM users
    WHERE status = 'active'${supervisor ? " AND role = 'employee' AND supervisor_id = ?" : ""}`;
  const users = await db.prepare(userQuery).bind(...(supervisor ? [auth.user.id] : [])).all<Pick<MissionAssignee, "id" | "fullName" | "username" | "role">>();
  const now = new Date();
  const since = new Date(now.getTime() - ASSIGNEE_HISTORY_DAYS * 86_400_000).toISOString();
  let orderMode: "recent" | "name" = "recent";
  let history: { assignedTo: string; recentAssignmentCount: number | string; lastAssignedAt: string }[] = [];
  try {
    // Use the immutable creation recipient, not just missions.created_by: another
    // manager can reassign an existing mission. Edits are not extra assignments.
    // Exclude deleted/cancelled/reassigned registrations from this suggestion.
    const result = await db.prepare(`SELECT m.assigned_to AS assignedTo,
      COUNT(DISTINCT m.id) AS recentAssignmentCount, MAX(a.created_at) AS lastAssignedAt
      FROM audit_logs a JOIN missions m ON m.id = a.entity_id
      JOIN users u ON u.id = m.assigned_to
      WHERE a.actor_id = ? AND a.action = 'mission.created' AND a.entity_type = 'mission'
        AND a.created_at >= ? AND a.created_at <= ?
        AND m.status <> 'cancelled' AND u.status = 'active'
        AND JSON_UNQUOTE(JSON_EXTRACT(CASE WHEN JSON_VALID(a.details) THEN a.details ELSE '{}' END, '$.assignedTo')) = m.assigned_to
        ${supervisor ? "AND u.role = 'employee' AND u.supervisor_id = ?" : ""}
      GROUP BY m.assigned_to`).bind(auth.user.id, since, now.toISOString(), ...(supervisor ? [auth.user.id] : [])).all<typeof history[number]>();
    history = result.results;
  } catch {
    // Suggestion history must not stop mission registration. Never expose raw
    // audit details or database errors; the UI explicitly labels the fallback.
    orderMode = "name";
  }
  const byAssignee = new Map(history.map(row => [row.assignedTo, row]));
  const assignees = sortMissionAssignees(users.results.map(user => {
    const row = byAssignee.get(user.id);
    const count = Number(row?.recentAssignmentCount ?? 0);
    const lastAssignedAt = row?.lastAssignedAt && Number.isFinite(Date.parse(row.lastAssignedAt)) ? row.lastAssignedAt : null;
    return { ...user, recentAssignmentCount: Number.isSafeInteger(count) && count > 0 && lastAssignedAt ? count : 0, lastAssignedAt };
  }));
  return Response.json({ accountId: auth.user.id, assignees, historyDays: ASSIGNEE_HISTORY_DAYS, orderMode }, { headers: privateHeaders });
}
