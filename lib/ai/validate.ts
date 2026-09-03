import { AI_ACTION_IDS, AI_FINDING_IDS, AI_PROVIDER_SELECTION_SCHEMA_VERSION, type AiProviderSelection } from "./contracts.ts";

const outputKeys = ["schemaVersion", "findingIds", "actionIds"].sort();
const allowedFindingIds = new Set<string>(AI_FINDING_IDS);
const allowedActionIds = new Set<string>(AI_ACTION_IDS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isUniqueAllowedIds(value: unknown, allowed: ReadonlySet<string>, maxItems: number) {
  return Array.isArray(value) && value.length <= maxItems
    && value.every(item => typeof item === "string" && allowed.has(item))
    && new Set(value).size === value.length;
}

export function validateAiProviderSelection(value: unknown): value is AiProviderSelection {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== outputKeys.length || !keys.every((key, index) => key === outputKeys[index])) return false;
  return value.schemaVersion === AI_PROVIDER_SELECTION_SCHEMA_VERSION
    && isUniqueAllowedIds(value.findingIds, allowedFindingIds, 5)
    && isUniqueAllowedIds(value.actionIds, allowedActionIds, 3);
}
