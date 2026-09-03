import type { PerformanceEvidencePath } from "./evidence.ts";

export const AI_ADVISORY_SCHEMA_VERSION = "tapra-ai-advisory-v1" as const;
export const AI_PROVIDER_SELECTION_SCHEMA_VERSION = "tapra-ai-selection-v1" as const;
export const AI_ADVISORY_DISCLAIMER = "این متن فقط مشورتی است و هیچ تغییری در امتیاز، کارکرد یا وضعیت مأموریت ایجاد نمی‌کند." as const;
export const AI_FINDING_IDS = ["completion-summary", "coverage-summary", "connectivity-summary", "follow-up-summary", "overdue-summary", "work-summary", "distance-summary"] as const;
export const AI_ACTION_IDS = ["human-review", "review-gps-settings", "review-connectivity", "review-follow-ups", "review-overdue", "review-period"] as const;

export type AiFindingId = typeof AI_FINDING_IDS[number];
export type AiActionId = typeof AI_ACTION_IDS[number];

export type AiPerformanceInput = {
  attendance: { activeMinutes: number; shortfallMinutes: number; pendingCorrectionMinutes: number };
  missions: { assignedCount: number; completedCount: number; successRate: number; followUpCount: number; overdueCount: number };
  movement: { missionDistanceKm: number; locationPointCount: number };
  integrity: { gpsCoverageRate: number; gpsGapMinutes: number; internetGapMinutes: number };
};

// A remote provider may return only allowlisted identifiers. It never authors
// user-visible text or chooses evidence paths; TAPRA renders both server-side.
export type AiProviderSelection = {
  schemaVersion: typeof AI_PROVIDER_SELECTION_SCHEMA_VERSION;
  findingIds: AiFindingId[];
  actionIds: AiActionId[];
};

export type AiAdvisoryItem = {
  id: AiFindingId | AiActionId;
  title: string;
  detail: string;
  level: "info" | "review";
  evidencePaths: PerformanceEvidencePath[];
};

export type AiAdvisoryOutput = {
  schemaVersion: typeof AI_ADVISORY_SCHEMA_VERSION;
  headline: string;
  summary: string;
  findings: AiAdvisoryItem[];
  suggestedActions: AiAdvisoryItem[];
  dataSufficiency: "sufficient" | "insufficient";
  disclaimer: typeof AI_ADVISORY_DISCLAIMER;
};

export type AiFailureClass =
  | "disabled" | "budget_exhausted" | "rate_limited" | "circuit_open"
  | "timeout" | "network" | "provider_auth" | "provider_rate_limited"
  | "provider_unavailable" | "invalid_response" | "unknown";

export type AiAuditMetadata = {
  requestId: string;
  feature: "performance_summary";
  mode: "provider" | "mock" | "fallback";
  failureClass: AiFailureClass | null;
  latencyMs: number;
  attempts: number;
  cacheHit: boolean;
  estimatedCostMicroUsd: number;
};

export type AiAdvisoryResult = {
  mode: "provider" | "mock" | "fallback";
  summary: AiAdvisoryOutput | null;
  fallbackReason: AiFailureClass | null;
  audit: AiAuditMetadata;
};

export type AiProviderUsage = { inputTokens: number; outputTokens: number; estimatedCostMicroUsd: number };
export type AiProviderResponse = { output: unknown; usage: AiProviderUsage };

export const AI_PROVIDER_SELECTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "findingIds", "actionIds"],
  properties: {
    schemaVersion: { const: AI_PROVIDER_SELECTION_SCHEMA_VERSION },
    findingIds: { type: "array", maxItems: 5, uniqueItems: true, items: { enum: AI_FINDING_IDS } },
    actionIds: { type: "array", maxItems: 3, uniqueItems: true, items: { enum: AI_ACTION_IDS } },
  },
} as const;
