import { ensureDatabase } from "../../../../../db/runtime";
import { requireRole } from "../../../../../lib/auth";

type ReconciliationRow = {
  userId: string; fullName: string;
  currentConfirmed: number; currentPending: number; currentPenalty: number;
  ledgerConfirmed: number; ledgerPending: number; ledgerPenalty: number;
};

export async function GET(request: Request) {
  const auth = await requireRole(request, ["owner", "admin"]);
  if ("error" in auth) return auth.error;
  const db = await ensureDatabase();
  const result = await db.prepare(`SELECT u.id AS userId, u.full_name AS fullName,
    COALESCE(current_scores.confirmed, 0) AS currentConfirmed,
    COALESCE(current_scores.pending, 0) AS currentPending,
    COALESCE(current_scores.penalty, 0) AS currentPenalty,
    COALESCE(ledger.confirmed, 0) AS ledgerConfirmed,
    COALESCE(ledger.pending, 0) AS ledgerPending,
    COALESCE(ledger.penalty, 0) AS ledgerPenalty
    FROM users u
    LEFT JOIN (
      SELECT user_id, SUM(confirmed) AS confirmed, SUM(pending) AS pending, SUM(penalty) AS penalty FROM (
        SELECT assigned_to AS user_id, SUM(score_confirmed) AS confirmed, SUM(score_pending) AS pending, SUM(score_penalty) AS penalty
        FROM missions GROUP BY assigned_to
        UNION ALL
        SELECT user_id, 0 AS confirmed, 0 AS pending, SUM(score_penalty) AS penalty FROM work_sessions GROUP BY user_id
      ) source_scores GROUP BY user_id
    ) current_scores ON current_scores.user_id = u.id
    LEFT JOIN (
      SELECT user_id,
        SUM(CASE WHEN bucket='confirmed' THEN points_delta ELSE 0 END) AS confirmed,
        SUM(CASE WHEN bucket='pending' THEN points_delta ELSE 0 END) AS pending,
        -SUM(CASE WHEN bucket='penalty' THEN points_delta ELSE 0 END) AS penalty
      FROM score_ledger_entries GROUP BY user_id
    ) ledger ON ledger.user_id = u.id
    ORDER BY u.full_name, u.id`).all<ReconciliationRow>();
  const rows = result.results.map((row) => ({
    ...row,
    matches: Number(row.currentConfirmed) === Number(row.ledgerConfirmed)
      && Number(row.currentPending) === Number(row.ledgerPending)
      && Number(row.currentPenalty) === Number(row.ledgerPenalty),
  }));
  return Response.json({ shadowMode: true, sourceOfTruth: "current_score_columns", rows }, {
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}
