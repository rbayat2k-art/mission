import { createHash, randomUUID } from "node:crypto";
import mysql from "mysql2/promise";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};
const keyFor = (sourceEventId, bucket) => createHash("sha256")
  .update(["score-ledger-v1", "opening_backfill_v1", sourceEventId, bucket, "opening_balance"].join("\u001f"))
  .digest("hex");
const cutoff = required("SCORE_LEDGER_BACKFILL_CUTOFF");
if (!Number.isFinite(Date.parse(cutoff)) || Date.parse(cutoff) > Date.now()) throw new Error("SCORE_LEDGER_BACKFILL_CUTOFF must be a valid non-future ISO timestamp");
if (process.env.SCORE_LEDGER_BACKFILL_MAINTENANCE?.trim() !== "confirmed") {
  throw new Error("Refusing score-ledger backfill without SCORE_LEDGER_BACKFILL_MAINTENANCE=confirmed");
}
const connection = await mysql.createConnection({
  host: process.env.DB_HOST?.trim() || "127.0.0.1", port: Number(process.env.DB_PORT || 3306),
  user: required("DB_USER"), password: required("DB_PASSWORD"), database: required("DB_NAME"),
  charset: "utf8mb4", timezone: "Z",
});
const pageSize = 250;
const insert = `INSERT INTO score_ledger_entries
  (id, user_id, mission_id, attempt_id, work_session_id, points_delta, bucket, reason_code, source,
    source_event_id, idempotency_key, actor_id, reversal_of, occurred_at, created_at, metadata)
  VALUES (?, ?, ?, NULL, ?, ?, ?, 'opening_balance', 'opening_backfill_v1', ?, ?, NULL, NULL, ?, ?, ?)
  ON DUPLICATE KEY UPDATE idempotency_key = VALUES(idempotency_key)`;

async function backfill(kind, highWatermark) {
  let cursor = "";
  let seen = 0;
  for (;;) {
    const sql = kind === "mission"
      ? `SELECT id, assigned_to AS userId, completed_at AS occurredAt, created_at AS createdAt,
          score_confirmed AS confirmed, score_pending AS pending, score_penalty AS penalty
        FROM missions WHERE id > ? AND id <= ? AND created_at <= ? ORDER BY id LIMIT ?`
      : `SELECT id, user_id AS userId, ended_at AS occurredAt, created_at AS createdAt,
          0 AS confirmed, 0 AS pending, score_penalty AS penalty
        FROM work_sessions WHERE id > ? AND id <= ? AND created_at <= ? ORDER BY id LIMIT ?`;
    const [rows] = await connection.execute(sql, [cursor, highWatermark, cutoff, pageSize]);
    if (!rows.length) break;
    await connection.beginTransaction();
    try {
      for (const row of rows) {
        const sourceEventId = `${kind}:${row.id}`;
        const occurredAt = row.occurredAt || row.createdAt || new Date(0).toISOString();
        const createdAt = new Date().toISOString();
        for (const [bucket, delta] of [["confirmed", Number(row.confirmed || 0)], ["pending", Number(row.pending || 0)], ["penalty", -Number(row.penalty || 0)]]) {
          if (!delta) continue;
          await connection.execute(insert, [randomUUID(), row.userId, kind === "mission" ? row.id : null,
            kind === "session" ? row.id : null, delta, bucket, sourceEventId, keyFor(sourceEventId, bucket),
            occurredAt, createdAt, JSON.stringify({ shadowMode:true, openingBalance:true, entityKind:kind })]);
        }
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
    seen += rows.length;
    cursor = rows.at(-1).id;
  }
  return seen;
}

try {
  const [lockRows] = await connection.execute("SELECT GET_LOCK('tapra:score-ledger-opening-backfill', 0) AS acquired");
  if (Number(lockRows[0]?.acquired) !== 1) throw new Error("Score ledger opening backfill is already running");
  const [[completedRun]] = await connection.execute("SELECT cutoff_at AS cutoffAt FROM score_ledger_backfill_state WHERE id='opening-v1' LIMIT 1");
  if (completedRun) {
    console.log(`Score ledger opening backfill already completed through ${completedRun.cutoffAt}; reconciliation only.`);
  }
  const [[missionWatermark]] = await connection.execute("SELECT COALESCE(MAX(id), '') AS id FROM missions WHERE created_at <= ?", [cutoff]);
  const [[sessionWatermark]] = await connection.execute("SELECT COALESCE(MAX(id), '') AS id FROM work_sessions WHERE created_at <= ?", [cutoff]);
  const missions = completedRun ? 0 : await backfill("mission", missionWatermark.id);
  const sessions = completedRun ? 0 : await backfill("session", sessionWatermark.id);
  const [[current]] = await connection.execute(`SELECT
    COALESCE((SELECT SUM(score_confirmed) FROM missions),0) AS confirmed,
    COALESCE((SELECT SUM(score_pending) FROM missions),0) AS pending,
    COALESCE((SELECT SUM(score_penalty) FROM missions),0)+COALESCE((SELECT SUM(score_penalty) FROM work_sessions),0) AS penalty`);
  const [[ledger]] = await connection.execute(`SELECT
    COALESCE(SUM(CASE WHEN bucket='confirmed' THEN points_delta ELSE 0 END),0) AS confirmed,
    COALESCE(SUM(CASE WHEN bucket='pending' THEN points_delta ELSE 0 END),0) AS pending,
    -COALESCE(SUM(CASE WHEN bucket='penalty' THEN points_delta ELSE 0 END),0) AS penalty
    FROM score_ledger_entries`);
  if (Number(current.confirmed)!==Number(ledger.confirmed)||Number(current.pending)!==Number(ledger.pending)||Number(current.penalty)!==Number(ledger.penalty)) {
    throw new Error("Score ledger reconciliation failed after opening backfill; keep shadow mode and investigate before deployment");
  }
  if (!completedRun) {
    await connection.execute(`INSERT INTO score_ledger_backfill_state
      (id, cutoff_at, mission_high_watermark, session_high_watermark, completed_at)
      VALUES ('opening-v1', ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE id=id`, [cutoff, missionWatermark.id, sessionWatermark.id, new Date().toISOString()]);
  }
  console.log(`Score ledger opening backfill completed through ${cutoff}: ${missions} missions, ${sessions} work sessions scanned; reconciliation passed.`);
} finally {
  await connection.execute("SELECT RELEASE_LOCK('tapra:score-ledger-opening-backfill')").catch(()=>undefined);
  await connection.end();
}
