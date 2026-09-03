import type { AppRole } from "../auth";

export type AiFeatureConfig = {
  enabled: boolean;
  performanceSummaryEnabled: boolean;
  provider: string;
  allowedRoles: ReadonlySet<AppRole>;
  timeoutMs: number;
  maxAttempts: 1 | 2;
  cacheTtlMs: number;
  ratePerMinute: number;
  dailyRequestLimit: number;
  dailyCostMicroUsd: number;
  maxCostPerRequestMicroUsd: number;
};

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function parseAllowedRoles(value: string | undefined) {
  const valid = new Set<AppRole>(["owner", "admin", "supervisor", "employee"]);
  const requested = (value ?? "").split(",").map(role => role.trim()).filter(Boolean);
  return new Set(requested.filter((role): role is AppRole => valid.has(role as AppRole)));
}

export function loadAiFeatureConfig(env: NodeJS.ProcessEnv = process.env): AiFeatureConfig {
  const enabled = env.AI_ENABLED === "true";
  const performanceSummaryEnabled = enabled && env.AI_PERFORMANCE_SUMMARY_ENABLED === "true";
  const requestedProvider = env.AI_PROVIDER === "mock" ? "mock" : "disabled";
  const provider = (env.NODE_ENV ?? process.env.NODE_ENV) === "production" ? "disabled" : requestedProvider;
  return {
    enabled,
    performanceSummaryEnabled,
    provider,
    allowedRoles: parseAllowedRoles(env.AI_ALLOWED_ROLES),
    timeoutMs: boundedInteger(env.AI_TIMEOUT_MS, 8_000, 250, 10_000),
    maxAttempts: boundedInteger(env.AI_MAX_ATTEMPTS, 2, 1, 2) as 1 | 2,
    cacheTtlMs: boundedInteger(env.AI_CACHE_TTL_MS, 600_000, 1_000, 900_000),
    ratePerMinute: boundedInteger(env.AI_RATE_PER_MINUTE, 3, 1, 20),
    dailyRequestLimit: boundedInteger(env.AI_DAILY_REQUEST_LIMIT, 100, 1, 10_000),
    dailyCostMicroUsd: boundedInteger(env.AI_DAILY_COST_MICRO_USD, 0, 0, 100_000_000),
    maxCostPerRequestMicroUsd: boundedInteger(env.AI_MAX_COST_PER_REQUEST_MICRO_USD, 0, 0, 10_000_000),
  };
}

export function isAiRoleEnabled(config: AiFeatureConfig, role: AppRole) {
  return config.enabled && config.performanceSummaryEnabled && config.allowedRoles.has(role);
}
