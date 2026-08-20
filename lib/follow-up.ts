import type { SessionUser } from "./auth";

export const openFollowUpStatuses = ["awaiting_supervisor", "awaiting_employee", "escalated", "ready_for_employee"] as const;

export type FollowUpAccessRow = {
  id: string;
  missionId: string;
  missionTitle: string;
  missionStatus: string;
  employeeId: string;
  employeeName: string;
  supervisorId: string;
  assignedTo: string;
  status: string;
};

export function canAccessFollowUp(user: SessionUser, item: FollowUpAccessRow) {
  if (user.role === "owner" || user.role === "admin") return true;
  if (user.role === "employee") return item.employeeId === user.id;
  return item.supervisorId === user.id || item.assignedTo === user.id;
}

export function isFollowUpOpen(status: string) {
  return (openFollowUpStatuses as readonly string[]).includes(status);
}

export const followUpCategoryValues = ["missing_documents", "coordination", "payment", "administrative", "other"] as const;

export function normalizeFollowUpCategory(value?: string) {
  return (followUpCategoryValues as readonly string[]).includes(value ?? "") ? value! : "other";
}
