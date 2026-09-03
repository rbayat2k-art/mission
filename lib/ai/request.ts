import type { PerformancePeriod } from "../performance-report.ts";

export function parseAiSummaryRequest(value: unknown): { period: PerformancePeriod; userId?: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => key !== "period" && key !== "userId")) return null;
  const period = body.period ?? "daily";
  if (period !== "daily" && period !== "weekly" && period !== "monthly") return null;
  if (body.userId !== undefined && (typeof body.userId !== "string" || !body.userId.trim() || body.userId.trim().length > 64)) return null;
  return { period, userId: typeof body.userId === "string" ? body.userId.trim() : undefined };
}
