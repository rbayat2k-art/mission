import { ensureDatabase } from "../../../../db/runtime";
import { requireRole } from "../../../../lib/auth";
import { validTrackingWorkSessionId } from "../../../../lib/tracking-heartbeat";

const noStoreHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "Pragma": "no-cache",
  "Vary": "Cookie",
};

export async function POST(request: Request) {
  const auth = await requireRole(request, ["employee", "supervisor", "admin", "owner"]);
  if ("error" in auth) return auth.error;

  const expectedUserId = request.headers.get("x-tapra-user-id")?.trim();
  if (expectedUserId && expectedUserId !== auth.user.id) {
    return Response.json({ error: "حساب فعال برنامه با نشست سرور یکسان نیست." }, { status: 409, headers: noStoreHeaders });
  }

  const body = await request.json().catch(() => ({})) as { workSessionId?: string };
  const workSessionId = body.workSessionId?.trim() ?? "";
  if (!validTrackingWorkSessionId(workSessionId)) {
    return Response.json({ error: "شناسه فعالیت معتبر نیست." }, { status: 400, headers: noStoreHeaders });
  }

  const db = await ensureDatabase();
  const session = await db.prepare(`SELECT ws.id FROM work_sessions ws JOIN users u ON u.id = ws.user_id
    WHERE ws.id = ? AND ws.user_id = ? AND ws.status = 'active' AND u.status = 'active' LIMIT 1`)
    .bind(workSessionId, auth.user.id).first<{ id: string }>();
  if (!session) {
    return Response.json({ error: "فعالیت جاری پیدا نشد یا پایان یافته است." }, { status: 409, headers: noStoreHeaders });
  }

  const receivedAt = new Date().toISOString();
  const source = request.headers.get("user-agent")?.startsWith("TapraAndroid/") ? "android" : "web";
  await db.prepare(`INSERT INTO tracking_presence
    (work_session_id, user_id, last_contact_at, last_contact_source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), last_contact_at = VALUES(last_contact_at),
      last_contact_source = VALUES(last_contact_source), updated_at = VALUES(updated_at)`)
    .bind(session.id, auth.user.id, receivedAt, source, receivedAt, receivedAt).run();

  return Response.json({ workSessionId: session.id, sessionStatus: "active", receivedAt, source, nextHeartbeatSeconds: 60, scoreImpact: false }, { headers: noStoreHeaders });
}
