import { ensureDatabase } from "../../../../db/runtime";
import { buildPerformanceAdvisory, canAccessPerformanceInsight, type AdvisorySubject } from "../../../../lib/advisory-insights";
import { requireRole } from "../../../../lib/auth";
import { getPerformanceReport, type PerformancePeriod } from "../../../../lib/performance-report";

const noStoreHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "Pragma": "no-cache",
  "Vary": "Cookie",
};

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status, headers: noStoreHeaders });
}

export async function GET(request: Request) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor", "employee"]);
  if (!("user" in auth)) {
    const status = auth.error.status;
    return errorResponse(status === 401 ? "unauthorized" : "forbidden", status);
  }
  const sessionUser = auth.user;
  if (!sessionUser) return errorResponse("unauthorized", 401);

  const url = new URL(request.url);
  const requestedPeriod = url.searchParams.get("period") ?? "daily";
  if (!["daily", "weekly", "monthly"].includes(requestedPeriod)) return errorResponse("invalid_period", 400);
  const period = requestedPeriod as PerformancePeriod;
  const requestedUserId = url.searchParams.get("userId")?.trim() || sessionUser.id;
  if (requestedUserId.length > 64) return errorResponse("invalid_user", 400);

  const db = await ensureDatabase();
  const subject = await db.prepare("SELECT id, role, status, supervisor_id AS supervisorId FROM users WHERE id = ?")
    .bind(requestedUserId).first<AdvisorySubject>();
  if (!subject) return errorResponse("not_found", 404);
  if (!canAccessPerformanceInsight(sessionUser, subject)) return errorResponse("forbidden", 403);

  // The existing report engine remains the only calculation source. Passing an
  // employee-scoped viewer after the explicit RBAC check returns exactly one row
  // without changing any performance formula or exposing team data.
  const report = await getPerformanceReport({ id: requestedUserId, role: "employee" }, period);
  const row = report.rows[0];
  if (!row) return errorResponse("not_found", 404);

  return Response.json({
    period,
    range: report.range,
    user: { id: row.id, fullName: row.fullName },
    insights: buildPerformanceAdvisory(row),
  }, { headers: noStoreHeaders });
}
