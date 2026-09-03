import { ensureDatabase } from "../../../../../db/runtime";
import { buildPerformanceAdvisory, canAccessPerformanceInsight, type AdvisorySubject } from "../../../../../lib/advisory-insights";
import { requireRole, type AppRole } from "../../../../../lib/auth";
import { loadAiFeatureConfig, isAiRoleEnabled } from "../../../../../lib/ai/config.server";
import { AiPerformanceAdvisoryService, projectAiPerformanceInput } from "../../../../../lib/ai/performance-advisory.server";
import { disabledAiProvider } from "../../../../../lib/ai/provider";
import { createMockAiProvider } from "../../../../../lib/ai/providers/mock";
import { parseAiSummaryRequest } from "../../../../../lib/ai/request";
import { getPerformanceReport } from "../../../../../lib/performance-report";

const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache", "Vary": "Cookie" };
const config = loadAiFeatureConfig();
const provider = config.provider === "mock" ? createMockAiProvider() : disabledAiProvider;
const service = new AiPerformanceAdvisoryService({ config, provider });

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status, headers: noStoreHeaders });
}

export async function POST(request: Request) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor", "employee"]);
  if (!("user" in auth)) return errorResponse(auth.error.status === 401 ? "unauthorized" : "forbidden", auth.error.status);
  const sessionUser = auth.user;
  if (!sessionUser) return errorResponse("unauthorized", 401);

  let body: unknown;
  try { body = await request.json(); }
  catch { return errorResponse("invalid_request", 400); }
  const parsed = parseAiSummaryRequest(body);
  if (!parsed) return errorResponse("invalid_request", 400);
  const requestedUserId = parsed.userId ?? sessionUser.id;

  const db = await ensureDatabase();
  const subject = await db.prepare("SELECT id, role, status, supervisor_id AS supervisorId FROM users WHERE id = ?")
    .bind(requestedUserId).first<AdvisorySubject>();
  if (!subject) return errorResponse("not_found", 404);
  if (!canAccessPerformanceInsight(sessionUser, subject)) return errorResponse("forbidden", 403);

  const report = await getPerformanceReport({ id: requestedUserId, role: "employee" }, parsed.period);
  const row = report.rows[0];
  if (!row) return errorResponse("not_found", 404);
  const deterministic = buildPerformanceAdvisory(row);
  const ai = await service.summarize({
    input: projectAiPerformanceInput(row),
    requestId: crypto.randomUUID(),
    scopeKey: `${sessionUser.id}:${requestedUserId}:${parsed.period}`,
    featureAllowed: isAiRoleEnabled(config, sessionUser.role as AppRole),
  });

  return Response.json({
    period: parsed.period,
    range: report.range,
    user: { id: row.id, fullName: row.fullName },
    insights: deterministic,
    ai: { mode: ai.mode, summary: ai.summary, fallbackReason: ai.fallbackReason, audit: ai.audit },
  }, { headers: noStoreHeaders });
}
