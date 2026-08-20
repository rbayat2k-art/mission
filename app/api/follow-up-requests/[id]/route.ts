import { ensureDatabase } from "../../../../db/runtime";
import { requireRole } from "../../../../lib/auth";
import { canAccessFollowUp, type FollowUpAccessRow } from "../../../../lib/follow-up";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor", "employee"]);
  if ("error" in auth) return auth.error;
  const { id } = await context.params;
  const db = await ensureDatabase();
  const item = await db.prepare(`SELECT r.id, r.mission_id AS missionId, r.attempt_no AS attemptNo, r.category,
    r.request_text AS requestText, r.status, r.resolution_note AS resolutionNote, r.created_at AS createdAt,
    r.updated_at AS updatedAt, r.resolved_at AS resolvedAt, r.created_by AS createdBy,
    r.supervisor_id AS supervisorId, r.assigned_to AS assignedTo, m.title AS missionTitle,
    m.status AS missionStatus, m.assigned_to AS employeeId, u.full_name AS employeeName,
    s.full_name AS supervisorName, a.full_name AS assignedToName
    FROM mission_follow_up_requests r JOIN missions m ON m.id = r.mission_id
    JOIN users u ON u.id = m.assigned_to JOIN users s ON s.id = r.supervisor_id
    JOIN users a ON a.id = r.assigned_to WHERE r.id = ?`).bind(id).first<FollowUpAccessRow & Record<string, unknown>>();
  if (!item) return Response.json({ error: "درخواست پیگیری پیدا نشد." }, { status:404 });
  if (!canAccessFollowUp(auth.user, item)) return Response.json({ error:"forbidden" }, { status:403 });
  const messages = await db.prepare(`SELECT fm.id, fm.request_id AS requestId, fm.sender_id AS senderId,
    u.full_name AS senderName, u.role AS senderRole, fm.message_type AS messageType, fm.body, fm.created_at AS createdAt
    FROM mission_follow_up_messages fm JOIN users u ON u.id = fm.sender_id
    WHERE fm.request_id = ? ORDER BY fm.created_at ASC`).bind(id).all();
  const attachments = await db.prepare(`SELECT a.id, a.mission_id AS missionId, a.follow_up_message_id AS messageId,
    a.file_name AS fileName, a.content_type AS contentType, a.size_bytes AS sizeBytes, a.created_at AS createdAt,
    u.full_name AS uploadedByName FROM attachments a JOIN users u ON u.id = a.uploaded_by
    WHERE a.mission_id = ? ORDER BY a.created_at ASC`).bind(item.missionId).all();
  return Response.json({ request:item, messages:messages.results, attachments:attachments.results });
}
