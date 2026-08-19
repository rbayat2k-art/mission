import { ensureDatabase } from "../../../db/runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = await ensureDatabase();
    const result = await db.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    if (Number(result?.ok) !== 1) throw new Error("Database health check failed");
    return Response.json(
      { status: "ok", version: process.env.APP_VERSION || "2.6.1" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { status: "unhealthy" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
