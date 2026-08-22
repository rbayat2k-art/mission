import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { hashPassword } from "../lib/security";
import { database } from "../lib/server-database";

let initialization: Promise<void> | null = null;

async function applySchema() {
  const schemaPath = resolve(process.cwd(), "db/mysql-schema.sql");
  const source = await readFile(schemaPath, "utf8");
  const statements = source
    .split("-- statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await database.prepare(statement).run();

  const scoringColumns = [
    { name: "workflow_type", definition: "VARCHAR(24) NOT NULL DEFAULT 'single' AFTER assigned_to" },
    { name: "current_step_no", definition: "INT NOT NULL DEFAULT 1 AFTER workflow_type" },
    { name: "referrer_name", definition: "VARCHAR(255) NULL AFTER assigned_to" },
    { name: "score_penalty", definition: "INT NOT NULL DEFAULT 0 AFTER score_confirmed" },
    { name: "score_note", definition: "VARCHAR(255) NULL AFTER score_penalty" },
    { name: "start_latitude_e6", definition: "INT NULL AFTER started_at" },
    { name: "start_longitude_e6", definition: "INT NULL AFTER start_latitude_e6" },
    { name: "start_accuracy_cm", definition: "INT NULL AFTER start_longitude_e6" },
    { name: "start_location_recorded_at", definition: "VARCHAR(40) NULL AFTER start_accuracy_cm" },
    { name: "end_latitude_e6", definition: "INT NULL AFTER completed_at" },
    { name: "end_longitude_e6", definition: "INT NULL AFTER end_latitude_e6" },
    { name: "end_accuracy_cm", definition: "INT NULL AFTER end_longitude_e6" },
    { name: "end_location_recorded_at", definition: "VARCHAR(40) NULL AFTER end_accuracy_cm" },
  ];
  for (const column of scoringColumns) {
    const existing = await database.prepare("SELECT COLUMN_NAME AS columnName FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'missions' AND COLUMN_NAME = ?").bind(column.name).first();
    if (!existing) await database.prepare(`ALTER TABLE missions ADD COLUMN ${column.name} ${column.definition}`).run();
  }
  const attemptStepColumn = await database.prepare("SELECT COLUMN_NAME AS columnName FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mission_attempts' AND COLUMN_NAME = 'mission_step_id'").first();
  if (!attemptStepColumn) await database.prepare("ALTER TABLE mission_attempts ADD COLUMN mission_step_id CHAR(36) NULL AFTER mission_id").run();
  const workSessionColumns = [
    { name: "start_source", definition: "VARCHAR(24) NOT NULL DEFAULT 'live' AFTER end_note" },
    { name: "end_source", definition: "VARCHAR(24) NULL AFTER start_source" },
    { name: "work_type", definition: "VARCHAR(24) NOT NULL DEFAULT 'regular' AFTER end_source" },
    { name: "approval_status", definition: "VARCHAR(24) NOT NULL DEFAULT 'approved' AFTER work_type" },
    { name: "score_penalty", definition: "INT NOT NULL DEFAULT 0 AFTER approval_status" },
    { name: "created_at", definition: "VARCHAR(40) NULL AFTER score_penalty" },
  ];
  for (const column of workSessionColumns) {
    const existing = await database.prepare("SELECT COLUMN_NAME AS columnName FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'work_sessions' AND COLUMN_NAME = ?").bind(column.name).first();
    if (!existing) await database.prepare(`ALTER TABLE work_sessions ADD COLUMN ${column.name} ${column.definition}`).run();
  }
  const attachmentMessageColumn = await database.prepare("SELECT COLUMN_NAME AS columnName FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attachments' AND COLUMN_NAME = 'follow_up_message_id'").first();
  if (!attachmentMessageColumn) await database.prepare("ALTER TABLE attachments ADD COLUMN follow_up_message_id CHAR(36) NULL AFTER size_bytes").run();
  const attachmentMessageIndex = await database.prepare("SELECT INDEX_NAME AS indexName FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attachments' AND INDEX_NAME = 'idx_attachments_follow_up_message'").first();
  if (!attachmentMessageIndex) await database.prepare("ALTER TABLE attachments ADD INDEX idx_attachments_follow_up_message (follow_up_message_id, created_at)").run();
  const notificationColumn = await database.prepare("SELECT COLUMN_NAME AS columnName FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'notification_enabled'").first();
  if (!notificationColumn) await database.prepare("ALTER TABLE users ADD COLUMN notification_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER must_change_password").run();
}

async function seedDatabase() {
  const existing = await database.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
  if ((existing?.count ?? 0) > 0) return;

  const now = new Date().toISOString();
  const username = (process.env.INITIAL_ADMIN_USERNAME?.trim() || "admin").toLowerCase();
  const password = process.env.INITIAL_ADMIN_PASSWORD || "123123456";
  const fullName = process.env.INITIAL_ADMIN_NAME?.trim() || "مدیر سیستم";
  const mobile = process.env.INITIAL_ADMIN_MOBILE?.trim() || "09000000000";
  const credential = await hashPassword(password);
  await database.prepare("INSERT INTO users (id, full_name, mobile, username, password_hash, password_salt, role, status, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, 'admin', 'active', 1, ?)")
    .bind(crypto.randomUUID(), fullName, mobile, username, credential.hash, credential.salt, now)
    .run();
}

export async function ensureDatabase() {
  initialization ??= (async () => {
    await database.ping();
    if (process.env.AUTO_MIGRATE !== "false") await applySchema();
    await seedDatabase();
  })().catch((error) => {
    initialization = null;
    throw error;
  });
  await initialization;
  return database;
}
