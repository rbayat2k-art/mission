import { requireRole } from "../../../../lib/auth";
import { getEmployeeActivitySummary, type ReportPeriod } from "../../../../lib/employee-daily-summary";
import { getPerformanceReport } from "../../../../lib/performance-report";

export async function GET(request: Request) {
  const auth = await requireRole(request, ["employee"]);
  if ("error" in auth) return auth.error;
  const requestedPeriod = new URL(request.url).searchParams.get("period");
  const period: ReportPeriod = requestedPeriod === "weekly" || requestedPeriod === "monthly" ? requestedPeriod : "daily";
  const [summary, performance] = await Promise.all([
    getEmployeeActivitySummary(auth.user.id, period),
    getPerformanceReport(auth.user, period),
  ]);
  return Response.json({ summary: { ...summary, performance: performance.rows[0] ?? null, policy: performance.policy } });
}
