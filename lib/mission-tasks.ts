export const MIN_MISSION_TASKS = 2;
export const MAX_MISSION_TASKS = 10;
export const MISSION_TASK_RESULTS = ["انجام شد", "انجام نشد", "نیاز به پیگیری"] as const;

export type MissionTaskResult = typeof MISSION_TASK_RESULTS[number];

export type MissionTaskInput = {
  title?: string;
  description?: string;
};

export type NormalizedMissionTask = {
  id: string;
  taskNo: number;
  title: string;
  description: string;
};

export function normalizeMissionTasks(raw: unknown): { tasks: NormalizedMissionTask[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length < MIN_MISSION_TASKS || raw.length > MAX_MISSION_TASKS) {
    return { error: `مأموریت «یک مقصد + چند کار» باید بین ${MIN_MISSION_TASKS} تا ${MAX_MISSION_TASKS} کار داشته باشد.` };
  }
  const tasks: NormalizedMissionTask[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const value = raw[index] && typeof raw[index] === "object" ? raw[index] as MissionTaskInput : {};
    if ((value.title != null && typeof value.title !== "string") || (value.description != null && typeof value.description !== "string")) return {error:`اطلاعات کار ${index + 1} معتبر نیست.`};
    const title = value.title?.trim() ?? "";
    if (title.length < 2 || title.length > 255) return { error: `عنوان کار ${index + 1} معتبر نیست.` };
    tasks.push({
      id: crypto.randomUUID(),
      taskNo: index + 1,
      title,
      description: value.description?.trim().slice(0, 4000) ?? "",
    });
  }
  return { tasks };
}

export function normalizeMissionTaskResult(result: unknown, report: unknown) {
  const normalizedResult = typeof result === "string" ? result.trim() as MissionTaskResult : "" as MissionTaskResult;
  if (!MISSION_TASK_RESULTS.includes(normalizedResult)) return { error: "نتیجه انتخاب‌شده برای این کار معتبر نیست." } as const;
  const normalizedReport = typeof report === "string" ? report.trim().slice(0, 4000) : "";
  if (normalizedResult !== "انجام شد" && normalizedReport.length < 3) {
    return { error: "برای کار انجام‌نشده یا نیازمند پیگیری، توضیح حداقل ۳ کاراکتری لازم است." } as const;
  }
  return { result: normalizedResult, report: normalizedReport } as const;
}

export function deriveMissionTaskOutcome(tasks: Array<{ status: string; result?: string | null }>) {
  if (tasks.length < MIN_MISSION_TASKS || tasks.length > MAX_MISSION_TASKS) {
    return { error: "فهرست کارهای این مأموریت معتبر نیست." } as const;
  }
  const unresolvedCount = tasks.filter(task => task.status !== "completed" && task.status !== "follow_up").length;
  if (unresolvedCount > 0) {
    return { error: `ابتدا وضعیت ${unresolvedCount.toLocaleString("fa-IR")} کار باقیمانده را مشخص کنید.`, unresolvedCount } as const;
  }
  const result = tasks.every(task => task.status === "completed")
    ? "انجام شد"
    : tasks.some(task => task.result === "نیاز به پیگیری")
      ? "نیاز به پیگیری"
      : "انجام نشد";
  return { result } as const;
}
