import { ensureDatabase } from "../../../db/runtime";
import { requireRole } from "../../../lib/auth";

export async function GET(request: Request) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor"]);
  if ("error" in auth) return auth.error;
  const db = await ensureDatabase();
  const select = `SELECT a.id, a.status, a.created_at AS createdAt, m.id AS missionId, m.title, m.result, m.report, m.destination_name AS destinationName, m.expense_amount AS expenseAmount, m.score_pending AS scorePending, u.full_name AS employeeName FROM approvals a JOIN missions m ON m.id = a.mission_id JOIN users u ON u.id = m.assigned_to`;
  const result = auth.user.role === "supervisor"
    ? await db.prepare(`${select} WHERE a.status = 'pending' AND u.supervisor_id = ? ORDER BY a.created_at DESC`).bind(auth.user.id).all()
    : await db.prepare(`${select} WHERE a.status = 'pending' ORDER BY a.created_at DESC`).all();
  return Response.json({ approvals: result.results });
}
