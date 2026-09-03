import { AI_PROVIDER_SELECTION_SCHEMA_VERSION, type AiPerformanceInput, type AiProviderResponse } from "../contracts.ts";
import { AiProviderError, type AiAdvisoryProvider } from "../provider.ts";

export type MockAiMode = "success" | "invalid" | "timeout" | "offline" | "401" | "429" | "5xx";

export function createMockAiProvider(mode: MockAiMode = "success", onInput?: (input: AiPerformanceInput) => void): AiAdvisoryProvider {
  return {
    id: "mock",
    async generatePerformanceSummary(input, context): Promise<AiProviderResponse> {
      onInput?.(structuredClone(input));
      if (mode === "invalid") return { output: { schemaVersion: "wrong", raw: "invalid" }, usage: { inputTokens: 0, outputTokens: 0, estimatedCostMicroUsd: 0 } };
      if (mode === "timeout") {
        await new Promise((_, reject) => {
          const rejectOnAbort = () => reject(new AiProviderError("timeout", true));
          if (context.signal.aborted) rejectOnAbort();
          else context.signal.addEventListener("abort", rejectOnAbort, { once: true });
        });
      }
      if (mode === "offline") throw new AiProviderError("network", true);
      if (mode === "401") throw new AiProviderError("provider_auth", false);
      if (mode === "429") throw new AiProviderError("provider_rate_limited", true);
      if (mode === "5xx") throw new AiProviderError("provider_unavailable", true);

      const result = {
        schemaVersion: AI_PROVIDER_SELECTION_SCHEMA_VERSION,
        findingIds: ["completion-summary", "coverage-summary"],
        actionIds: ["human-review"],
      };
      return { output: result, usage: { inputTokens: 0, outputTokens: 0, estimatedCostMicroUsd: 0 } };
    },
  };
}
