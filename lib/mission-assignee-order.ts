export const ASSIGNEE_HISTORY_DAYS = 30;

export type MissionAssignee = {
  id: string;
  fullName: string;
  username: string;
  role: string;
  recentAssignmentCount: number;
  lastAssignedAt: string | null;
};

export type MissionAssigneesResponse = {
  accountId: string;
  assignees: MissionAssignee[];
  historyDays: number;
  orderMode: "recent" | "name";
};

export function sortMissionAssignees(assignees: MissionAssignee[]): MissionAssignee[] {
  // A stable total order also covers equal names and users with no history.
  return [...assignees].sort((left, right) =>
    right.recentAssignmentCount - left.recentAssignmentCount ||
    (right.lastAssignedAt ?? "").localeCompare(left.lastAssignedAt ?? "") ||
    left.fullName.localeCompare(right.fullName, "fa") ||
    left.username.localeCompare(right.username, "fa") || left.id.localeCompare(right.id)
  );
}
