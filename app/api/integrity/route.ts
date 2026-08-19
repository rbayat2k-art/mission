import { ensureDatabase } from "../../../db/runtime";
import { requireRole } from "../../../lib/auth";

const employeeEventTypes = new Set(["gps_permission_denied", "device_offline"]);

export async function POST(request: Request) {
  const auth = await requireRole(request, ["employee", "supervisor", "admin", "owner"]);
  if ("error" in auth) return auth.error;
  const body = await request.json().catch(() => ({})) as { type?: string; details?: Record<string, unknown>; occurredAt?: string };
  if (!body.type || !employeeEventTypes.has(body.type)) return Response.json({ error: "نوع رویداد نامعتبر است." }, { status: 400 });
  const db = await ensureDatabase();
  const session = await db.prepare("SELECT id FROM work_sessions WHERE user_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1").bind(auth.user.id).first<{ id: string }>();
  const now = new Date().toISOString();
  const occurredAt = body.occurredAt && !Number.isNaN(Date.parse(body.occurredAt)) ? new Date(body.occurredAt).toISOString() : now;
  await db.prepare("INSERT INTO integrity_events (id, user_id, work_session_id, type, severity, details, occurred_at, created_at) VALUES (?, ?, ?, ?, 'high', ?, ?, ?)").bind(
    crypto.randomUUID(), auth.user.id, session?.id ?? null, body.type, JSON.stringify(body.details ?? {}), occurredAt, now,
  ).run();
  return Response.json({ saved: true }, { status: 201 });
}

export async function GET(request: Request) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor"]);
  if ("error" in auth) return auth.error;
  const db = await ensureDatabase();
  const select = "SELECT ie.id, ie.type, ie.severity, ie.status, ie.details, ie.occurred_at AS occurredAt, ie.review_note AS reviewNote, u.full_name AS employeeName FROM integrity_events ie JOIN users u ON u.id = ie.user_id";
  const result = auth.user.role === "supervisor"
    ? await db.prepare(`${select} WHERE u.supervisor_id = ? OR u.id = ? ORDER BY CASE ie.status WHEN 'open' THEN 0 ELSE 1 END, ie.occurred_at DESC LIMIT 100`).bind(auth.user.id, auth.user.id).all<Record<string, string>>()
    : await db.prepare(`${select} ORDER BY CASE ie.status WHEN 'open' THEN 0 ELSE 1 END, ie.occurred_at DESC LIMIT 100`).all<Record<string, string>>();
  return Response.json({ events: result.results.map((event) => ({ ...event, details: JSON.parse(event.details || "{}") })) });
}

export async function PATCH(request: Request) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor"]);
  if ("error" in auth) return auth.error;
  const body = await request.json().catch(() => ({})) as { id?: string; status?: "resolved" | "dismissed"; note?: string };
  if (!body.id || !body.status || !["resolved", "dismissed"].includes(body.status)) return Response.json({ error: "تصمیم نامعتبر است." }, { status: 400 });
  const db = await ensureDatabase();
  if (auth.user.role === "supervisor") {
    const allowed = await db.prepare("SELECT ie.id FROM integrity_events ie JOIN users u ON u.id = ie.user_id WHERE ie.id = ? AND (u.supervisor_id = ? OR u.id = ?)").bind(body.id, auth.user.id, auth.user.id).first();
    if (!allowed) return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const now = new Date().toISOString();
  const event = await db.prepare("SELECT type, details, work_session_id AS workSessionId FROM integrity_events WHERE id = ?").bind(body.id).first<{ type: string; details: string; workSessionId: string | null }>();
  if (!event) return Response.json({ error: "رویداد پیدا نشد." }, { status: 404 });
  const statements = [
    db.prepare("UPDATE integrity_events SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?").bind(body.status, auth.user.id, now, body.note?.trim() ?? null, body.id),
    db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'integrity.reviewed', 'integrity_event', ?, ?, ?)").bind(crypto.randomUUID(), auth.user.id, body.id, JSON.stringify({ status: body.status, note: body.note ?? null }), now),
  ];
  if (event.type === "self_reported_work_start" && event.workSessionId) {
    const approvalStatus = body.status === "resolved" ? "approved" : "rejected";
    statements.push(
      db.prepare("UPDATE work_sessions SET approval_status = ? WHERE id = ? AND start_source = 'self_reported'").bind(approvalStatus, event.workSessionId),
      db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'work_session.self_report_reviewed', 'work_session', ?, ?, ?)").bind(crypto.randomUUID(), auth.user.id, event.workSessionId, JSON.stringify({ approvalStatus, integrityEventId: body.id, note: body.note ?? null }), now),
    );
  }
  await db.batch(statements);
  return Response.json({ saved: true, correctionStatus: event.type === "self_reported_work_start" ? body.status === "resolved" ? "approved" : "rejected" : null });
}
