import { requireRole } from "../../../../lib/auth";
import { getPerformanceReport, type PerformancePeriod } from "../../../../lib/performance-report";

export async function GET(request: Request) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor"]);
  if ("error" in auth) return auth.error;
  const requested = new URL(request.url).searchParams.get("period");
  const period: PerformancePeriod = requested === "weekly" || requested === "monthly" ? requested : "daily";
  const report = await getPerformanceReport(auth.user, period, new Date(), { includeComparison: true });
  return Response.json({
    rows: report.rows, totals: report.totals, dailySeries: report.dailySeries,
    comparison: report.comparison, policy: report.policy, range: report.range, period,
  });
}
