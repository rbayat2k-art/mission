import type { AiAuditMetadata } from "./contracts.ts";

// Phase zero deliberately keeps audit events in the response/request lifecycle.
// Persisting even sanitized metadata is a separate additive migration decision.
export type AiAuditSink = (event: Readonly<AiAuditMetadata>) => void;

export const discardAiAudit: AiAuditSink = () => undefined;
