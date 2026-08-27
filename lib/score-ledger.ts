import { createHash } from "node:crypto";
import type { PreparedStatement } from "./server-database";

export type ScoreLedgerBucket = "confirmed" | "pending" | "penalty";

type ScoreLedgerDatabase = { prepare(query: string): PreparedStatement };

export type ScoreLedgerEntry = {
  userId: string;
  pointsDelta: number;
  bucket: ScoreLedgerBucket;
  reasonCode: string;
  source: string;
  sourceEventId: string;
  occurredAt: string;
  actorId?: string | null;
  missionId?: string | null;
  attemptId?: string | null;
  workSessionId?: string | null;
  reversalOf?: string | null;
  metadata?: Record<string, unknown> | null;
};

export function scoreDelta(current: number, next: number) {
  if (!Number.isInteger(current) || !Number.isInteger(next)) throw new Error("Score values must be integers");
  return next - current;
}

export function scoreLedgerIdempotencyKey(input: Pick<ScoreLedgerEntry, "source" | "sourceEventId" | "bucket" | "reasonCode">) {
  return createHash("sha256")
    .update(["score-ledger-v1", input.source, input.sourceEventId, input.bucket, input.reasonCode].join("\u001f"))
    .digest("hex");
}

export function prepareScoreLedgerEntry(database: ScoreLedgerDatabase, input: ScoreLedgerEntry): PreparedStatement | null {
  if (!Number.isInteger(input.pointsDelta)) throw new Error("pointsDelta must be a signed integer");
  if (input.pointsDelta === 0) return null;
  if (!(["confirmed", "pending", "penalty"] as const).includes(input.bucket)) throw new Error("Invalid score ledger bucket");
  const idempotencyKey = scoreLedgerIdempotencyKey(input);
  return database.prepare(`INSERT INTO score_ledger_entries
    (id, user_id, mission_id, attempt_id, work_session_id, points_delta, bucket, reason_code, source,
      source_event_id, idempotency_key, actor_id, reversal_of, occurred_at, created_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE idempotency_key = VALUES(idempotency_key)`)
    .bind(
      crypto.randomUUID(), input.userId, input.missionId ?? null, input.attemptId ?? null, input.workSessionId ?? null,
      input.pointsDelta, input.bucket, input.reasonCode, input.source, input.sourceEventId, idempotencyKey,
      input.actorId ?? null, input.reversalOf ?? null, input.occurredAt, new Date().toISOString(),
      JSON.stringify({ shadowMode: true, ...(input.metadata ?? {}) }),
    );
}

export function pushScoreLedgerEntry(statements: PreparedStatement[], database: ScoreLedgerDatabase, input: ScoreLedgerEntry) {
  const statement = prepareScoreLedgerEntry(database, input);
  if (statement) statements.push(statement);
}
