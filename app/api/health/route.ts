import { ensureDatabase } from "../../../db/runtime";
import { getDeploymentIdentity } from "../../../lib/deployment-identity";

export const dynamic = "force-dynamic";

export async function GET() {
  const identity = getDeploymentIdentity();
  try {
    const db = await ensureDatabase();
    const result = await db.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    if (Number(result?.ok) !== 1) throw new Error("Database health check failed");
    return Response.json(
      { status: "ok", ...identity },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { status: "unhealthy", ...identity },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
