export const PERFORMANCE_EVIDENCE_PATHS = [
  "attendance.activeMinutes",
  "attendance.shortfallMinutes",
  "attendance.pendingCorrectionMinutes",
  "missions.assignedCount",
  "missions.completedCount",
  "missions.successRate",
  "missions.followUpCount",
  "missions.overdueCount",
  "movement.missionDistanceKm",
  "movement.locationPointCount",
  "integrity.gpsCoverageRate",
  "integrity.gpsGapMinutes",
  "integrity.internetGapMinutes",
] as const;

export type PerformanceEvidencePath = typeof PERFORMANCE_EVIDENCE_PATHS[number];

const evidencePathSet = new Set<string>(PERFORMANCE_EVIDENCE_PATHS);

export function isPerformanceEvidencePath(value: unknown): value is PerformanceEvidencePath {
  return typeof value === "string" && evidencePathSet.has(value);
}
