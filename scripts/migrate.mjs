import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import mysql from "mysql2/promise";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const connection = await mysql.createConnection({
  host: process.env.DB_HOST?.trim() || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: required("DB_USER"),
  password: required("DB_PASSWORD"),
  database: required("DB_NAME"),
  charset: "utf8mb4",
  timezone: "Z",
});

try {
  const schema = await readFile(resolve(process.cwd(), "db/mysql-schema.sql"), "utf8");
  const statements = schema.split("-- statement-breakpoint").map((value) => value.trim()).filter(Boolean);
  for (const statement of statements) await connection.execute(statement);
  const userColumns = [
    ["notification_enabled", "TINYINT(1) NOT NULL DEFAULT 1 AFTER must_change_password"],
  ];
  for (const [name, definition] of userColumns) {
    const [rows] = await connection.execute("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = ?", [name]);
    if (!rows.length) await connection.execute(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
  }
  const scoringColumns = [
    ["referrer_name", "VARCHAR(255) NULL AFTER assigned_to"],
    ["score_penalty", "INT NOT NULL DEFAULT 0 AFTER score_confirmed"],
    ["score_note", "VARCHAR(255) NULL AFTER score_penalty"],
    ["start_latitude_e6", "INT NULL AFTER started_at"],
    ["start_longitude_e6", "INT NULL AFTER start_latitude_e6"],
    ["start_accuracy_cm", "INT NULL AFTER start_longitude_e6"],
    ["start_location_recorded_at", "VARCHAR(40) NULL AFTER start_accuracy_cm"],
    ["end_latitude_e6", "INT NULL AFTER completed_at"],
    ["end_longitude_e6", "INT NULL AFTER end_latitude_e6"],
    ["end_accuracy_cm", "INT NULL AFTER end_longitude_e6"],
    ["end_location_recorded_at", "VARCHAR(40) NULL AFTER end_accuracy_cm"],
  ];
  for (const [name, definition] of scoringColumns) {
    const [rows] = await connection.execute("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'missions' AND COLUMN_NAME = ?", [name]);
    if (!rows.length) await connection.execute(`ALTER TABLE missions ADD COLUMN ${name} ${definition}`);
  }
  const workSessionColumns = [
    ["start_source", "VARCHAR(24) NOT NULL DEFAULT 'live' AFTER end_note"],
    ["end_source", "VARCHAR(24) NULL AFTER start_source"],
    ["work_type", "VARCHAR(24) NOT NULL DEFAULT 'regular' AFTER end_source"],
    ["approval_status", "VARCHAR(24) NOT NULL DEFAULT 'approved' AFTER work_type"],
    ["score_penalty", "INT NOT NULL DEFAULT 0 AFTER approval_status"],
    ["created_at", "VARCHAR(40) NULL AFTER score_penalty"],
  ];
  for (const [name, definition] of workSessionColumns) {
    const [rows] = await connection.execute("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'work_sessions' AND COLUMN_NAME = ?", [name]);
    if (!rows.length) await connection.execute(`ALTER TABLE work_sessions ADD COLUMN ${name} ${definition}`);
  }
  const attachmentColumns = [
    ["follow_up_message_id", "CHAR(36) NULL AFTER size_bytes"],
  ];
  for (const [name, definition] of attachmentColumns) {
    const [rows] = await connection.execute("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attachments' AND COLUMN_NAME = ?", [name]);
    if (!rows.length) await connection.execute(`ALTER TABLE attachments ADD COLUMN ${name} ${definition}`);
  }
  const [attachmentIndexes] = await connection.execute("SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attachments' AND INDEX_NAME = 'idx_attachments_follow_up_message'");
  if (!attachmentIndexes.length) await connection.execute("ALTER TABLE attachments ADD INDEX idx_attachments_follow_up_message (follow_up_message_id, created_at)");

  await connection.execute(`INSERT INTO mission_status_events (id, mission_id, actor_id, actor_role, event_type, to_status,
    server_recorded_at, geocode_status, metadata, created_at)
    SELECT UUID(), m.id, m.created_by, creator.role, 'created', 'open', m.created_at, 'not_requested', JSON_OBJECT('backfilled', TRUE), m.created_at
    FROM missions m JOIN users creator ON creator.id=m.created_by
    WHERE NOT EXISTS (SELECT 1 FROM mission_status_events e WHERE e.mission_id=m.id AND e.event_type='created')`);
  await connection.execute(`INSERT INTO mission_status_events (id, mission_id, attempt_no, actor_id, actor_role, event_type, to_status,
    server_recorded_at, device_recorded_at, latitude_e6, longitude_e6, accuracy_cm, geocode_status, metadata, created_at)
    SELECT UUID(), ma.mission_id, ma.attempt_no, m.assigned_to, employee.role, 'started', 'in_progress', ma.started_at,
      ma.start_location_recorded_at, ma.start_latitude_e6, ma.start_longitude_e6, ma.start_accuracy_cm,
      IF(ma.start_latitude_e6 IS NULL, 'not_requested', 'pending'), JSON_OBJECT('backfilled', TRUE), ma.started_at
    FROM mission_attempts ma JOIN missions m ON m.id=ma.mission_id JOIN users employee ON employee.id=m.assigned_to
    WHERE ma.started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM mission_status_events e WHERE e.mission_id=ma.mission_id AND e.attempt_no=ma.attempt_no AND e.event_type='started')`);
  await connection.execute(`INSERT INTO mission_status_events (id, mission_id, attempt_no, actor_id, actor_role, event_type, to_status,
    server_recorded_at, device_recorded_at, latitude_e6, longitude_e6, accuracy_cm, geocode_status, metadata, created_at)
    SELECT UUID(), ma.mission_id, ma.attempt_no, m.assigned_to, employee.role, 'destination_registered', 'in_progress', ma.destination_recorded_at,
      ma.destination_recorded_at, ma.destination_latitude_e6, ma.destination_longitude_e6, ma.destination_accuracy_cm,
      IF(ma.destination_latitude_e6 IS NULL, 'not_requested', 'pending'), JSON_OBJECT('backfilled', TRUE, 'destinationName', ma.destination_name), ma.destination_recorded_at
    FROM mission_attempts ma JOIN missions m ON m.id=ma.mission_id JOIN users employee ON employee.id=m.assigned_to
    WHERE ma.destination_recorded_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM mission_status_events e WHERE e.mission_id=ma.mission_id AND e.attempt_no=ma.attempt_no AND e.event_type='destination_registered')`);
  await connection.execute(`INSERT INTO mission_status_events (id, mission_id, attempt_no, actor_id, actor_role, event_type, from_status, to_status, result,
    server_recorded_at, device_recorded_at, latitude_e6, longitude_e6, accuracy_cm, geocode_status, metadata, created_at)
    SELECT UUID(), ma.mission_id, ma.attempt_no, m.assigned_to, employee.role, 'status_set', 'in_progress',
      IF(ma.result='انجام شد', IF(ma.approval_status='pending', 'pending', 'approved'), 'follow_up'), ma.result, ma.completed_at,
      ma.end_location_recorded_at, ma.end_latitude_e6, ma.end_longitude_e6, ma.end_accuracy_cm,
      IF(ma.end_latitude_e6 IS NULL, 'not_requested', 'pending'), JSON_OBJECT('backfilled', TRUE, 'report', ma.report), ma.completed_at
    FROM mission_attempts ma JOIN missions m ON m.id=ma.mission_id JOIN users employee ON employee.id=m.assigned_to
    WHERE NOT EXISTS (SELECT 1 FROM mission_status_events e WHERE e.mission_id=ma.mission_id AND e.attempt_no=ma.attempt_no AND e.event_type='status_set')`);
  await connection.execute(`INSERT INTO mission_status_events (id, mission_id, actor_id, actor_role, event_type, to_status,
    server_recorded_at, device_recorded_at, latitude_e6, longitude_e6, accuracy_cm, geocode_status, metadata, created_at)
    SELECT UUID(), m.id, m.assigned_to, employee.role, 'started', 'in_progress', m.started_at, m.start_location_recorded_at,
      m.start_latitude_e6, m.start_longitude_e6, m.start_accuracy_cm, IF(m.start_latitude_e6 IS NULL, 'not_requested', 'pending'),
      JSON_OBJECT('backfilled', TRUE, 'currentMission', TRUE), m.started_at
    FROM missions m JOIN users employee ON employee.id=m.assigned_to
    WHERE m.started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM mission_status_events e WHERE e.mission_id=m.id AND e.event_type='started')`);
  console.log(`Applied ${statements.length} MySQL schema statements, verified mission scoring and work-session policy columns, and backfilled the mission status timeline.`);
} finally {
  await connection.end();
}
