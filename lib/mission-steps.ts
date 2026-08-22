import { normalizeJalaliDeadline } from "./mission-deadline";

export const MISSION_STEP_ACTIONS = ["visit", "follow_up", "receive", "deliver", "signature", "payment", "purchase", "inspection", "other"] as const;
export const MISSION_EVIDENCE_REQUIREMENTS = ["none", "optional", "photo", "file", "receipt", "any"] as const;
export const MAX_MISSION_STEPS = 10;

export type MissionStepInput = {
  title?: string;
  actionType?: string;
  description?: string;
  requiresLocation?: boolean;
  destinationName?: string | null;
  evidenceRequirement?: string;
  deadlineDate?: string | null;
  deadlineTime?: string | null;
};

export type NormalizedMissionStep = {
  id: string;
  stepNo: number;
  title: string;
  actionType: typeof MISSION_STEP_ACTIONS[number];
  description: string;
  requiresLocation: boolean;
  destinationName: string | null;
  evidenceRequirement: typeof MISSION_EVIDENCE_REQUIREMENTS[number];
  deadline: string | null;
  deadlineAt: string | null;
};

export function normalizeMissionSteps(raw: unknown): { steps: NormalizedMissionStep[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_MISSION_STEPS) {
    return { error: `مأموریت چندمرحله‌ای باید بین ۲ تا ${MAX_MISSION_STEPS} مرحله داشته باشد.` };
  }
  const steps: NormalizedMissionStep[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const value = raw[index] && typeof raw[index] === "object" ? raw[index] as MissionStepInput : {};
    const title = value.title?.trim() ?? "";
    if (title.length < 2 || title.length > 255) return { error: `عنوان مرحله ${index + 1} معتبر نیست.` };
    const requiresLocation = value.requiresLocation !== false;
    const destinationName = requiresLocation ? value.destinationName?.trim() || null : null;
    const actionType = MISSION_STEP_ACTIONS.includes(value.actionType as typeof MISSION_STEP_ACTIONS[number])
      ? value.actionType as typeof MISSION_STEP_ACTIONS[number] : "other";
    const evidenceRequirement = MISSION_EVIDENCE_REQUIREMENTS.includes(value.evidenceRequirement as typeof MISSION_EVIDENCE_REQUIREMENTS[number])
      ? value.evidenceRequirement as typeof MISSION_EVIDENCE_REQUIREMENTS[number] : "none";
    const normalizedDeadline = normalizeJalaliDeadline(value.deadlineDate, value.deadlineTime);
    if ("error" in normalizedDeadline) return { error: `مهلت مرحله ${index + 1}: ${normalizedDeadline.error}` };
    steps.push({
      id: crypto.randomUUID(), stepNo: index + 1, title, actionType,
      description: value.description?.trim().slice(0, 4000) ?? "", requiresLocation, destinationName,
      evidenceRequirement, deadline: normalizedDeadline.deadline ?? null,
      deadlineAt: "deadlineAt" in normalizedDeadline ? normalizedDeadline.deadlineAt ?? null : null,
    });
  }
  return { steps };
}
