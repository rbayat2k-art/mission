import { ensureDatabase } from "../../../../db/runtime";
import { requireRole } from "../../../../lib/auth";
import { getVapidPublicKey } from "../../../../lib/push-notifications";

export async function GET(request: Request) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor", "employee"]);
  if ("error" in auth) return auth.error;
  return Response.json({ enabled: auth.user.notificationEnabled, publicKey: getVapidPublicKey(), configured: Boolean(getVapidPublicKey()) });
}

export async function PATCH(request: Request) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor", "employee"]);
  if ("error" in auth) return auth.error;
  const body = await request.json().catch(() => ({})) as { enabled?:boolean };
  if (typeof body.enabled !== "boolean") return Response.json({ error: "وضعیت اعلان نامعتبر است." }, { status: 400 });
  const db = await ensureDatabase();
  await db.prepare("UPDATE users SET notification_enabled = ? WHERE id = ?").bind(body.enabled ? 1 : 0, auth.user.id).run();
  return Response.json({ enabled: body.enabled });
}
