import { ensureDatabase } from "../../../../db/runtime";
import { requireRole } from "../../../../lib/auth";
import { hashToken } from "../../../../lib/security";

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

export async function POST(request: Request) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor", "employee"]);
  if ("error" in auth) return auth.error;
  if (!sameOrigin(request)) return Response.json({ error: "درخواست نامعتبر است." }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { endpoint?:string; keys?:{p256dh?:string;auth?:string} };
  const endpoint = body.endpoint?.trim() ?? "";
  const p256dh = body.keys?.p256dh?.trim() ?? "";
  const keyAuth = body.keys?.auth?.trim() ?? "";
  if (!endpoint.startsWith("https://") || !p256dh || !keyAuth) return Response.json({ error: "اشتراک اعلان معتبر نیست." }, { status: 400 });
  const db = await ensureDatabase();
  const endpointHash = await hashToken(endpoint);
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO push_subscriptions (id, user_id, endpoint, endpoint_hash, p256dh, auth, user_agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), endpoint = VALUES(endpoint), p256dh = VALUES(p256dh), auth = VALUES(auth), user_agent = VALUES(user_agent), updated_at = VALUES(updated_at)")
    .bind(crypto.randomUUID(), auth.user.id, endpoint, endpointHash, p256dh, keyAuth, request.headers.get("user-agent"), now, now).run();
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor", "employee"]);
  if ("error" in auth) return auth.error;
  if (!sameOrigin(request)) return Response.json({ error: "درخواست نامعتبر است." }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { endpoint?:string };
  const db = await ensureDatabase();
  if (body.endpoint) await db.prepare("DELETE FROM push_subscriptions WHERE endpoint_hash = ? AND user_id = ?").bind(await hashToken(body.endpoint), auth.user.id).run();
  else await db.prepare("DELETE FROM push_subscriptions WHERE user_id = ?").bind(auth.user.id).run();
  return Response.json({ ok: true });
}
