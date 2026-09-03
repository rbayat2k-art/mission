import type { AdvisoryPerformanceInput } from "../advisory-insights.ts";
import type { AiAuditSink } from "./audit.server.ts";
import { discardAiAudit } from "./audit.server.ts";
import type { AiAdvisoryOutput, AiAdvisoryResult, AiFailureClass, AiPerformanceInput } from "./contracts.ts";
import type { AiFeatureConfig } from "./config.server.ts";
import { AiProviderError, type AiAdvisoryProvider } from "./provider.ts";
import { renderAiAdvisory } from "./render.server.ts";
import { validateAiProviderSelection } from "./validate.ts";

const MAX_METRIC_VALUE = 1_000_000_000;

function safeMetric(value: number) {
  return Number.isFinite(value) ? Math.min(MAX_METRIC_VALUE, Math.max(0, value)) : 0;
}

function safePercent(value: number) {
  return Math.min(100, safeMetric(value));
}

export function projectAiPerformanceInput(input: AdvisoryPerformanceInput): AiPerformanceInput {
  return {
    attendance: {
      activeMinutes: safeMetric(input.attendance.activeMinutes),
      shortfallMinutes: safeMetric(input.attendance.shortfallMinutes),
      pendingCorrectionMinutes: safeMetric(input.attendance.pendingCorrectionMinutes),
    },
    missions: {
      assignedCount: safeMetric(input.missions.assignedCount),
      completedCount: safeMetric(input.missions.completedCount),
      successRate: safePercent(input.missions.successRate),
      followUpCount: safeMetric(input.missions.followUpCount),
      overdueCount: safeMetric(input.missions.overdueCount),
    },
    movement: {
      missionDistanceKm: safeMetric(input.movement.missionDistanceKm),
      locationPointCount: safeMetric(input.movement.locationPointCount),
    },
    integrity: {
      gpsCoverageRate: safePercent(input.integrity.gpsCoverageRate),
      gpsGapMinutes: safeMetric(input.integrity.gpsGapMinutes),
      internetGapMinutes: safeMetric(input.integrity.internetGapMinutes),
    },
  };
}

type RuntimeOptions = {
  config: AiFeatureConfig;
  provider: AiAdvisoryProvider;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  audit?: AiAuditSink;
};

type RunOptions = { input: AiPerformanceInput; requestId: string; scopeKey: string; featureAllowed: boolean };

function failureClass(error: unknown): AiFailureClass {
  return error instanceof AiProviderError ? error.failureClass : "unknown";
}

function isRetryable(error: unknown) {
  return error instanceof AiProviderError && error.retryable;
}

export class AiPerformanceAdvisoryService {
  private readonly options: RuntimeOptions;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly audit: AiAuditSink;
  private readonly cache = new Map<string, { expiresAt: number; value: AiAdvisoryOutput }>();
  private readonly rateWindows = new Map<string, number[]>();
  private dailyKey = "";
  private dailyRequests = 0;
  private dailyCostSpentMicroUsd = 0;
  private dailyCostReservedMicroUsd = 0;
  private circuitFailures: number[] = [];
  private circuitOpenUntil = 0;
  private lastCleanupAt = 0;

  constructor(options: RuntimeOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.audit = options.audit ?? discardAiAudit;
  }

  private fallback(requestId: string, startedAt: number, reason: AiFailureClass, attempts: number, estimatedCostMicroUsd = 0): AiAdvisoryResult {
    const audit = {
      requestId, feature: "performance_summary" as const, mode: "fallback" as const,
      failureClass: reason, latencyMs: Math.max(0, this.now() - startedAt), attempts,
      cacheHit: false, estimatedCostMicroUsd,
    };
    this.audit(audit);
    return { mode: "fallback", summary: null, fallbackReason: reason, audit };
  }

  private refreshDailyState(now: number) {
    const currentDay = new Date(now).toISOString().slice(0, 10);
    if (this.dailyKey !== currentDay) {
      this.dailyKey = currentDay;
      this.dailyRequests = 0;
      this.dailyCostSpentMicroUsd = 0;
      this.dailyCostReservedMicroUsd = 0;
    }
  }

  private cleanupState(now: number) {
    if (now - this.lastCleanupAt < 60_000) return;
    this.lastCleanupAt = now;
    for (const [key, cached] of this.cache) if (cached.expiresAt <= now) this.cache.delete(key);
    for (const [key, timestamps] of this.rateWindows) {
      const recent = timestamps.filter(timestamp => timestamp > now - 60_000);
      if (recent.length) this.rateWindows.set(key, recent); else this.rateWindows.delete(key);
    }
    while (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value as string);
    while (this.rateWindows.size > 1_000) this.rateWindows.delete(this.rateWindows.keys().next().value as string);
  }

  private allowRequest(scopeKey: string, now: number) {
    this.refreshDailyState(now);
    if (this.dailyRequests >= this.options.config.dailyRequestLimit) return false;
    const recent = (this.rateWindows.get(scopeKey) ?? []).filter(timestamp => timestamp > now - 60_000);
    if (recent.length >= this.options.config.ratePerMinute) { this.rateWindows.set(scopeKey, recent); return false; }
    recent.push(now);
    this.rateWindows.set(scopeKey, recent);
    this.dailyRequests += 1;
    return true;
  }

  private async callWithDeadline(input: AiPerformanceInput, requestId: string, maxCostMicroUsd: number) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AiProviderError("timeout", true));
      }, this.options.config.timeoutMs);
    });
    try {
      return await Promise.race([
        this.options.provider.generatePerformanceSummary(input, { requestId, promptVersion: "performance-summary-v1", maxCostMicroUsd, signal: controller.signal }),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async summarize({ input, requestId, scopeKey, featureAllowed }: RunOptions): Promise<AiAdvisoryResult> {
    const startedAt = this.now();
    this.cleanupState(startedAt);
    this.refreshDailyState(startedAt);
    const config = this.options.config;
    if (!featureAllowed || !config.enabled || !config.performanceSummaryEnabled || config.provider === "disabled") {
      return this.fallback(requestId, startedAt, "disabled", 0);
    }
    if (this.options.provider.id !== config.provider || (process.env.NODE_ENV === "production" && this.options.provider.id === "mock")) {
      return this.fallback(requestId, startedAt, "disabled", 0);
    }
    if ((config.dailyCostMicroUsd <= 0 || config.maxCostPerRequestMicroUsd <= 0) && this.options.provider.id !== "mock") {
      return this.fallback(requestId, startedAt, "budget_exhausted", 0);
    }
    if (this.circuitOpenUntil > startedAt) return this.fallback(requestId, startedAt, "circuit_open", 0);

    const cacheKey = `${scopeKey}|performance-summary-v1|${JSON.stringify(input)}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > startedAt) {
      const mode = this.options.provider.id === "mock" ? "mock" as const : "provider" as const;
      const audit = {
        requestId, feature: "performance_summary" as const, mode,
        failureClass: null, latencyMs: 0, attempts: 0, cacheHit: true, estimatedCostMicroUsd: 0,
      };
      this.audit(audit);
      return { mode, summary: structuredClone(cached.value), fallbackReason: null, audit };
    }
    if (!this.allowRequest(scopeKey, startedAt)) return this.fallback(requestId, startedAt, "rate_limited", 0);

    const reservation = this.options.provider.id === "mock" ? 0 : config.maxCostPerRequestMicroUsd * config.maxAttempts;
    if (this.dailyCostSpentMicroUsd + this.dailyCostReservedMicroUsd + reservation > config.dailyCostMicroUsd) {
      return this.fallback(requestId, startedAt, "budget_exhausted", 0);
    }
    this.dailyCostReservedMicroUsd += reservation;

    let attempts = 0;
    let lastFailure: AiFailureClass = "unknown";
    let requestCostMicroUsd = 0;
    try {
      while (attempts < config.maxAttempts) {
        attempts += 1;
        try {
          const response = await this.callWithDeadline(input, requestId, config.maxCostPerRequestMicroUsd);
          const usage = response.usage;
          const validUsage = Number.isInteger(usage.inputTokens) && usage.inputTokens >= 0
            && Number.isInteger(usage.outputTokens) && usage.outputTokens >= 0
            && Number.isInteger(usage.estimatedCostMicroUsd) && usage.estimatedCostMicroUsd >= 0
            && (this.options.provider.id === "mock" || usage.estimatedCostMicroUsd <= config.maxCostPerRequestMicroUsd);
          if (!validUsage) {
            if (this.options.provider.id !== "mock") {
              this.dailyCostSpentMicroUsd += config.maxCostPerRequestMicroUsd;
              requestCostMicroUsd += config.maxCostPerRequestMicroUsd;
            }
            throw new AiProviderError("invalid_response", false);
          }
          this.dailyCostSpentMicroUsd += usage.estimatedCostMicroUsd;
          requestCostMicroUsd += usage.estimatedCostMicroUsd;
          if (!validateAiProviderSelection(response.output)) throw new AiProviderError("invalid_response", false);
          const candidate = renderAiAdvisory(response.output, input);
          this.circuitFailures = [];
          this.circuitOpenUntil = 0;
          if (this.cache.size >= 500) this.cache.delete(this.cache.keys().next().value as string);
          this.cache.set(cacheKey, { expiresAt: this.now() + config.cacheTtlMs, value: structuredClone(candidate) });
          const mode = this.options.provider.id === "mock" ? "mock" as const : "provider" as const;
          const audit = {
            requestId, feature: "performance_summary" as const, mode,
            failureClass: null, latencyMs: Math.max(0, this.now() - startedAt), attempts,
            cacheHit: false, estimatedCostMicroUsd: requestCostMicroUsd,
          };
          this.audit(audit);
          return { mode, summary: candidate, fallbackReason: null, audit };
        } catch (error) {
          lastFailure = failureClass(error);
          if (this.options.provider.id !== "mock" && ["timeout", "network", "provider_unavailable", "unknown"].includes(lastFailure)) {
            this.dailyCostSpentMicroUsd += config.maxCostPerRequestMicroUsd;
            requestCostMicroUsd += config.maxCostPerRequestMicroUsd;
          }
          const timestamp = this.now();
          this.circuitFailures = this.circuitFailures.filter(failureAt => failureAt > timestamp - 60_000);
          this.circuitFailures.push(timestamp);
          if (this.circuitFailures.length >= 5) this.circuitOpenUntil = timestamp + 120_000;
          if (!isRetryable(error) || attempts >= config.maxAttempts) break;
          await this.sleep(10);
        }
      }
    } finally {
      this.dailyCostReservedMicroUsd = Math.max(0, this.dailyCostReservedMicroUsd - reservation);
    }
    return this.fallback(requestId, startedAt, lastFailure, attempts, requestCostMicroUsd);
  }
}
