import { ensureDatabase } from "../../../../../db/runtime";
import { requireRole } from "../../../../../lib/auth";
import { distanceMeters } from "../../../../../lib/mission-location";

type MissionRow = {
  id: string; title: string; description: string; status: string; result: string | null; report: string | null;
  assignedTo: string; employeeName: string; supervisorId: string | null; createdBy: string;
  startedAt: string | null; completedAt: string | null;
  startLatitudeE6: number | null; startLongitudeE6: number | null; startAccuracyCm: number | null; startLocationRecordedAt: string | null;
  endLatitudeE6: number | null; endLongitudeE6: number | null; endAccuracyCm: number | null; endLocationRecordedAt: string | null;
  scorePending: number; scoreConfirmed: number; scorePenalty: number; scoreNote: string | null;
  workflowType:string;
};

type StoredPoint = { latitudeE6: number; longitudeE6: number; accuracyCm: number; recordedAt: string };
type TracePoint = { latitude: number; longitude: number; accuracy: number; recordedAt: string; source: "captured" | "nearest_gps" };
type Database = Awaited<ReturnType<typeof ensureDatabase>>;

function exactPoint(latitudeE6: number | null, longitudeE6: number | null, accuracyCm: number | null, recordedAt: string | null): TracePoint | null {
  if (latitudeE6 == null || longitudeE6 == null || accuracyCm == null || !recordedAt) return null;
  return { latitude: Number(latitudeE6) / 1_000_000, longitude: Number(longitudeE6) / 1_000_000, accuracy: Number(accuracyCm) / 100, recordedAt, source: "captured" };
}

async function nearestGpsPoint(db: Database, userId: string, actionAt: string | null): Promise<TracePoint | null> {
  if (!actionAt || Number.isNaN(Date.parse(actionAt))) return null;
  const center = Date.parse(actionAt);
  const start = new Date(center - 2 * 60_000).toISOString();
  const end = new Date(center + 2 * 60_000).toISOString();
  const rows = await db.prepare("SELECT latitude_e6 AS latitudeE6, longitude_e6 AS longitudeE6, accuracy_cm AS accuracyCm, recorded_at AS recordedAt FROM location_points WHERE user_id = ? AND recorded_at >= ? AND recorded_at <= ? ORDER BY recorded_at").bind(userId, start, end).all<StoredPoint>();
  const nearest = rows.results.sort((a, b) => Math.abs(Date.parse(a.recordedAt) - center) - Math.abs(Date.parse(b.recordedAt) - center))[0];
  return nearest ? { latitude:Number(nearest.latitudeE6)/1_000_000, longitude:Number(nearest.longitudeE6)/1_000_000, accuracy:Number(nearest.accuracyCm)/100, recordedAt:nearest.recordedAt, source:"nearest_gps" } : null;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor"]);
  if ("error" in auth) return auth.error;
  const { id } = await context.params;
  const db = await ensureDatabase();
  const mission = await db.prepare(`SELECT m.id, m.title, m.description, m.status, m.result, m.report, m.assigned_to AS assignedTo,
    u.full_name AS employeeName, u.supervisor_id AS supervisorId, m.created_by AS createdBy, m.started_at AS startedAt, m.completed_at AS completedAt,
    m.start_latitude_e6 AS startLatitudeE6, m.start_longitude_e6 AS startLongitudeE6, m.start_accuracy_cm AS startAccuracyCm, m.start_location_recorded_at AS startLocationRecordedAt,
    m.end_latitude_e6 AS endLatitudeE6, m.end_longitude_e6 AS endLongitudeE6, m.end_accuracy_cm AS endAccuracyCm, m.end_location_recorded_at AS endLocationRecordedAt,
    m.score_pending AS scorePending, m.score_confirmed AS scoreConfirmed, m.score_penalty AS scorePenalty, m.score_note AS scoreNote,
    m.workflow_type AS workflowType
    FROM missions m JOIN users u ON u.id = m.assigned_to WHERE m.id = ?`).bind(id).first<MissionRow>();
  if (!mission) return Response.json({ error: "مأموریت پیدا نشد." }, { status: 404 });
  if (auth.user.role === "supervisor" && mission.supervisorId !== auth.user.id && mission.createdBy !== auth.user.id) return Response.json({ error: "شما به اطلاعات مکانی این مأموریت دسترسی ندارید." }, { status: 403 });
  if (!mission.completedAt) return Response.json({ error: "این مأموریت هنوز پایان نیافته است." }, { status: 409 });

  const stepRows = mission.workflowType === "multi_stage" ? (await db.prepare(`SELECT id, step_no AS stepNo, title, action_type AS actionType,
    requires_location AS requiresLocation, destination_name AS destinationName, status, result, report, started_at AS startedAt,
    arrived_at AS arrivedAt, completed_at AS completedAt, start_latitude_e6 AS startLatitudeE6, start_longitude_e6 AS startLongitudeE6,
    start_accuracy_cm AS startAccuracyCm, start_location_recorded_at AS startRecordedAt,
    destination_latitude_e6 AS destinationLatitudeE6, destination_longitude_e6 AS destinationLongitudeE6,
    destination_accuracy_cm AS destinationAccuracyCm, destination_recorded_at AS destinationRecordedAt,
    end_latitude_e6 AS endLatitudeE6, end_longitude_e6 AS endLongitudeE6, end_accuracy_cm AS endAccuracyCm,
    end_location_recorded_at AS endRecordedAt FROM mission_steps WHERE mission_id=? ORDER BY step_no`).bind(id).all<{
      id:string;stepNo:number;title:string;actionType:string;requiresLocation:number;destinationName:string|null;status:string;result:string|null;report:string|null;
      startedAt:string|null;arrivedAt:string|null;completedAt:string|null;startLatitudeE6:number|null;startLongitudeE6:number|null;startAccuracyCm:number|null;startRecordedAt:string|null;
      destinationLatitudeE6:number|null;destinationLongitudeE6:number|null;destinationAccuracyCm:number|null;destinationRecordedAt:string|null;
      endLatitudeE6:number|null;endLongitudeE6:number|null;endAccuracyCm:number|null;endRecordedAt:string|null;
    }>()).results : [];
  const stepTraces = [] as Array<Record<string,unknown>>;
  let totalValidDistanceMeters = 0;
  for (let index=0;index<stepRows.length;index+=1) {
    const step=stepRows[index];
    const segments=(await db.prepare("SELECT id, work_session_id AS workSessionId, started_at AS startedAt, ended_at AS endedAt, end_reason AS endReason FROM mission_step_segments WHERE mission_step_id=? AND ended_at IS NOT NULL ORDER BY started_at").bind(step.id).all<{id:string;workSessionId:string;startedAt:string;endedAt:string;endReason:string}>()).results;
    let validDistanceMeters=0;
    for(const segment of segments){
      const points=(await db.prepare("SELECT latitude_e6 AS latitudeE6, longitude_e6 AS longitudeE6 FROM location_points WHERE user_id=? AND work_session_id=? AND recorded_at>=? AND recorded_at<=? AND accuracy_cm<=10000 ORDER BY recorded_at").bind(mission.assignedTo,segment.workSessionId,segment.startedAt,segment.endedAt).all<{latitudeE6:number;longitudeE6:number}>()).results;
      for(let pointIndex=1;pointIndex<points.length;pointIndex+=1) validDistanceMeters+=distanceMeters({latitude:points[pointIndex-1].latitudeE6/1_000_000,longitude:points[pointIndex-1].longitudeE6/1_000_000},{latitude:points[pointIndex].latitudeE6/1_000_000,longitude:points[pointIndex].longitudeE6/1_000_000});
    }
    totalValidDistanceMeters+=validDistanceMeters;
    const next=stepRows[index+1];
    stepTraces.push({...step,requiresLocation:Boolean(step.requiresLocation),start:exactPoint(step.startLatitudeE6,step.startLongitudeE6,step.startAccuracyCm,step.startRecordedAt),destination:exactPoint(step.destinationLatitudeE6,step.destinationLongitudeE6,step.destinationAccuracyCm,step.destinationRecordedAt),end:exactPoint(step.endLatitudeE6,step.endLongitudeE6,step.endAccuracyCm,step.endRecordedAt),validDistanceMeters:Math.round(validDistanceMeters),onSiteMinutes:step.arrivedAt&&step.completedAt?Math.max(0,Math.round((Date.parse(step.completedAt)-Date.parse(step.arrivedAt))/60_000)):null,segments,gapToNextMinutes:step.completedAt&&next?.startedAt?Math.max(0,Math.round((Date.parse(next.startedAt)-Date.parse(step.completedAt))/60_000)):null});
  }

  const destination = await db.prepare("SELECT destination_name AS destinationName, latitude_e6 AS latitudeE6, longitude_e6 AS longitudeE6, accuracy_cm AS accuracyCm, recorded_at AS recordedAt FROM mission_destinations WHERE mission_id = ?").bind(id).first<{ destinationName:string; latitudeE6:number; longitudeE6:number; accuracyCm:number; recordedAt:string }>();
  const exactStart = exactPoint(mission.startLatitudeE6, mission.startLongitudeE6, mission.startAccuracyCm, mission.startLocationRecordedAt);
  const exactEnd = exactPoint(mission.endLatitudeE6, mission.endLongitudeE6, mission.endAccuracyCm, mission.endLocationRecordedAt);
  const [start, end] = await Promise.all([
    exactStart ? Promise.resolve(exactStart) : nearestGpsPoint(db, mission.assignedTo, mission.startedAt),
    exactEnd ? Promise.resolve(exactEnd) : nearestGpsPoint(db, mission.assignedTo, mission.completedAt),
  ]);
  const destinationPoint = destination ? { latitude:Number(destination.latitudeE6)/1_000_000, longitude:Number(destination.longitudeE6)/1_000_000, accuracy:Number(destination.accuracyCm)/100, recordedAt:destination.recordedAt, source:"captured" as const, destinationName:destination.destinationName } : null;
  const startToDestinationMeters = start && destinationPoint ? distanceMeters(start, destinationPoint) : null;
  const destinationToEndMeters = destinationPoint && end ? distanceMeters(destinationPoint, end) : null;
  const flags = {
    missingStart: !start,
    missingDestination: !destinationPoint,
    missingEnd: !end,
    startInferred: start?.source === "nearest_gps",
    endInferred: end?.source === "nearest_gps",
    lowAccuracy: [start?.accuracy, destinationPoint?.accuracy, end?.accuracy].some((accuracy) => accuracy != null && accuracy > 100),
    endFarFromDestination: destinationToEndMeters != null && destinationToEndMeters > 150,
  };
  const issueCount = Object.values(flags).filter(Boolean).length;
  const confidence = !flags.missingStart && !flags.missingDestination && !flags.missingEnd && issueCount === 0 ? "high" : issueCount <= 2 ? "medium" : "low";
  const scoreHints = [
    flags.missingStart ? "نقطه شروع ثبت نشده؛ بررسی کسر امتیاز شروع کار لازم است." : null,
    flags.startInferred || flags.endInferred ? "یک نقطه از نزدیک‌ترین GPS تخمین زده شده و ثبت مستقیم دکمه نیست." : null,
    flags.missingDestination ? "مختصات مقصد ثبت نشده است." : null,
    flags.missingEnd ? "نقطه پایان مأموریت ثبت نشده است." : null,
    flags.lowAccuracy ? "حداقل یکی از نقاط دقت GPS پایین‌تر از حد مطلوب دارد." : null,
    flags.endFarFromDestination ? `پایان مأموریت حدود ${destinationToEndMeters?.toLocaleString("fa-IR")} متر با مقصد فاصله دارد و نیازمند بررسی است.` : null,
  ].filter((value): value is string => Boolean(value));
  if (!scoreHints.length) scoreHints.push("هر سه نقطه مستقیم و با وضعیت قابل‌قبول ثبت شده‌اند؛ داده مکانی برای ارزیابی کامل است.");

  return Response.json({ trace: {
    mission: { id:mission.id, title:mission.title, description:mission.description, employeeName:mission.employeeName, status:mission.status, result:mission.result, report:mission.report, startedAt:mission.startedAt, completedAt:mission.completedAt, scorePending:Number(mission.scorePending), scoreConfirmed:Number(mission.scoreConfirmed), scorePenalty:Number(mission.scorePenalty), scoreNote:mission.scoreNote },
    points: { start, destination:destinationPoint, end },
    metrics: { startToDestinationMeters, destinationToEndMeters, totalElapsedMinutes:mission.startedAt ? Math.max(0, Math.round((Date.parse(mission.completedAt)-Date.parse(mission.startedAt))/60_000)) : null, totalValidDistanceMeters:Math.round(totalValidDistanceMeters) },
    steps:stepTraces,
    evaluation: { confidence, flags, scoreHints },
  } });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor"]);
  if ("error" in auth) return auth.error;
  const { id } = await context.params;
  const body = await request.json().catch(() => ({})) as { score?: number; note?: string };
  const score = Number(body.score);
  const note = body.note?.trim() ?? "";
  if (!Number.isInteger(score) || score < 0 || score > 12) return Response.json({ error: "امتیاز ارزیابی باید عدد صحیح بین صفر تا ۱۲ باشد." }, { status: 400 });
  if (note.length < 3 || note.length > 500) return Response.json({ error: "دلیل ارزیابی را بین ۳ تا ۵۰۰ نویسه وارد کنید." }, { status: 400 });
  const db = await ensureDatabase();
  const mission = await db.prepare("SELECT m.id, m.status, m.completed_at AS completedAt, m.created_by AS createdBy, u.supervisor_id AS supervisorId FROM missions m JOIN users u ON u.id = m.assigned_to WHERE m.id = ?").bind(id).first<{ id:string; status:string; completedAt:string|null; createdBy:string; supervisorId:string|null }>();
  if (!mission) return Response.json({ error: "مأموریت پیدا نشد." }, { status: 404 });
  if (auth.user.role === "supervisor" && mission.supervisorId !== auth.user.id && mission.createdBy !== auth.user.id) return Response.json({ error: "شما اجازه ارزیابی این مأموریت را ندارید." }, { status: 403 });
  if (!mission.completedAt) return Response.json({ error: "فقط مأموریت پایان‌یافته قابل ارزیابی است." }, { status: 409 });
  if (!["pending", "pending_approval", "follow_up_pending", "follow_up", "approved", "completed"].includes(mission.status)) return Response.json({ error: "مأموریت ردشده یا در حال اصلاح از این قسمت امتیاز نمی‌گیرد." }, { status: 409 });
  const pending = ["pending", "pending_approval", "follow_up_pending"].includes(mission.status);
  const now = new Date().toISOString();
  const field = pending ? "score_pending" : "score_confirmed";
  await db.batch([
    db.prepare(`UPDATE missions SET ${field} = ?, score_note = ? WHERE id = ?`).bind(score, note, id),
    db.prepare("UPDATE mission_attempts SET score_awarded = ? WHERE mission_id = ? ORDER BY attempt_no DESC LIMIT 1").bind(score, id),
    db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, 'mission.location_score_reviewed', 'mission', ?, ?, ?)").bind(crypto.randomUUID(), auth.user.id, id, JSON.stringify({ score, note, scoreState:pending ? "pending" : "confirmed" }), now),
  ]);
  return Response.json({ score, note, scoreState:pending ? "pending" : "confirmed", reviewedAt:now });
}
