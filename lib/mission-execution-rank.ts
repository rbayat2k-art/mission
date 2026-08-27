export const MIN_EXECUTION_RANK = 1;
export const MAX_EXECUTION_RANK = 9;

export const ACTIONABLE_EXECUTION_RANK_STATUSES = [
  "open",
  "in_progress",
  "stage_waiting",
  "follow_up",
  "follow_up_pending",
  "revision",
  "pending",
  "pending_approval",
] as const;

export function normalizeExecutionRank(value: unknown): { executionRank: number } | { error: string } {
  const executionRank = Number(value);
  if (!Number.isInteger(executionRank) || executionRank < MIN_EXECUTION_RANK || executionRank > MAX_EXECUTION_RANK) {
    return { error: "رتبه اجرا باید یک عدد صحیح بین ۱ تا ۹ باشد." };
  }
  return { executionRank };
}

export function executionRankSortValue(value: unknown) {
  const executionRank = Number(value);
  return Number.isInteger(executionRank) && executionRank >= MIN_EXECUTION_RANK && executionRank <= MAX_EXECUTION_RANK
    ? executionRank
    : Number.POSITIVE_INFINITY;
}
