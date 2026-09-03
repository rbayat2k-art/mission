import type { AiFailureClass, AiPerformanceInput, AiProviderResponse } from "./contracts.ts";

export type AiProviderContext = {
  requestId: string;
  promptVersion: "performance-summary-v1";
  maxCostMicroUsd: number;
  signal: AbortSignal;
};

export interface AiAdvisoryProvider {
  readonly id: string;
  generatePerformanceSummary(input: AiPerformanceInput, context: AiProviderContext): Promise<AiProviderResponse>;
}

export class AiProviderError extends Error {
  readonly failureClass: AiFailureClass;
  readonly retryable: boolean;

  constructor(failureClass: AiFailureClass, retryable: boolean) {
    super(failureClass);
    this.name = "AiProviderError";
    this.failureClass = failureClass;
    this.retryable = retryable;
  }
}

export const disabledAiProvider: AiAdvisoryProvider = {
  id: "disabled",
  async generatePerformanceSummary() {
    throw new AiProviderError("disabled", false);
  },
};
