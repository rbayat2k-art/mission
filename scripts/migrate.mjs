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
  console.log(`Applied ${statements.length} MySQL schema statements and verified mission scoring and work-session policy columns, plus follow-up and attachment columns.`);
} finally {
  await connection.end();
}
