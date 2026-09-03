import {
  AI_ADVISORY_DISCLAIMER,
  AI_ADVISORY_SCHEMA_VERSION,
  type AiActionId,
  type AiAdvisoryItem,
  type AiAdvisoryOutput,
  type AiFindingId,
  type AiPerformanceInput,
  type AiProviderSelection,
} from "./contracts.ts";

const faNumber = (value: number) => Math.round(value).toLocaleString("fa-IR");
const faDecimal = (value: number) => value.toLocaleString("fa-IR", { maximumFractionDigits: 1 });

function finding(id: AiFindingId, input: AiPerformanceInput): AiAdvisoryItem {
  const templates: Record<AiFindingId, () => AiAdvisoryItem> = {
    "completion-summary": () => ({ id, title: "تکمیل مأموریت‌ها", level: "info", detail: `${faNumber(input.missions.completedCount)} مورد از ${faNumber(input.missions.assignedCount)} مأموریت ثبت‌شده تکمیل شده است.`, evidencePaths: ["missions.completedCount", "missions.assignedCount"] }),
    "coverage-summary": () => ({ id, title: "پوشش موقعیت", level: "info", detail: `پوشش ثبت موقعیت در این بازه ${faNumber(input.integrity.gpsCoverageRate)} درصد بوده است.`, evidencePaths: ["integrity.gpsCoverageRate"] }),
    "connectivity-summary": () => ({ id, title: "وقفه اینترنت", level: "review", detail: `${faNumber(input.integrity.internetGapMinutes)} دقیقه وقفه اینترنت در بازه گزارش ثبت شده است.`, evidencePaths: ["integrity.internetGapMinutes"] }),
    "follow-up-summary": () => ({ id, title: "پیگیری مجدد", level: "review", detail: `${faNumber(input.missions.followUpCount)} مأموریت در وضعیت پیگیری مجدد قرار دارد.`, evidencePaths: ["missions.followUpCount"] }),
    "overdue-summary": () => ({ id, title: "مأموریت‌های عقب‌افتاده", level: "review", detail: `${faNumber(input.missions.overdueCount)} مأموریت عقب‌افتاده در گزارش ثبت شده است.`, evidencePaths: ["missions.overdueCount"] }),
    "work-summary": () => ({ id, title: "کارکرد ثبت‌شده", level: "info", detail: `${faNumber(input.attendance.activeMinutes)} دقیقه کارکرد فعال در این بازه ثبت شده است.`, evidencePaths: ["attendance.activeMinutes"] }),
    "distance-summary": () => ({ id, title: "مسافت مأموریت", level: "info", detail: `${faDecimal(input.movement.missionDistanceKm)} کیلومتر مسافت مأموریت در این بازه ثبت شده است.`, evidencePaths: ["movement.missionDistanceKm"] }),
  };
  return templates[id]();
}

function action(id: AiActionId): AiAdvisoryItem {
  const templates: Record<AiActionId, AiAdvisoryItem> = {
    "human-review": { id, title: "مرور انسانی گزارش", level: "review", detail: "شاخص‌های ثبت‌شده پیش از هر تصمیم توسط مسئول مجاز مرور شوند.", evidencePaths: ["missions.assignedCount"] },
    "review-gps-settings": { id, title: "بررسی ثبت موقعیت", level: "review", detail: "علت وقفه ثبت موقعیت همراه با شواهد سامانه بررسی شود.", evidencePaths: ["integrity.gpsGapMinutes", "integrity.gpsCoverageRate"] },
    "review-connectivity": { id, title: "بررسی اتصال", level: "review", detail: "وقفه‌های اینترنت ثبت‌شده برای این بازه بررسی شوند.", evidencePaths: ["integrity.internetGapMinutes"] },
    "review-follow-ups": { id, title: "مرور پیگیری‌ها", level: "review", detail: "موارد پیگیری مجدد برای برنامه‌ریزی بعدی مرور شوند.", evidencePaths: ["missions.followUpCount"] },
    "review-overdue": { id, title: "مرور موارد عقب‌افتاده", level: "review", detail: "مأموریت‌های عقب‌افتاده و علت ثبت‌شده آن‌ها مرور شوند.", evidencePaths: ["missions.overdueCount"] },
    "review-period": { id, title: "انتخاب بازه دیگر", level: "review", detail: "در صورت ناکافی‌بودن داده، بازه گزارش دیگری نیز مرور شود.", evidencePaths: ["missions.assignedCount", "movement.locationPointCount"] },
  };
  return templates[id];
}

export function renderAiAdvisory(selection: AiProviderSelection, input: AiPerformanceInput): AiAdvisoryOutput {
  const hasData = input.attendance.activeMinutes > 0 || input.missions.assignedCount > 0 || input.movement.locationPointCount > 0;
  return {
    schemaVersion: AI_ADVISORY_SCHEMA_VERSION,
    headline: hasData ? "جمع‌بندی مشورتی عملکرد آماده است" : "داده کافی برای جمع‌بندی وجود ندارد",
    summary: hasData
      ? "این جمع‌بندی از شاخص‌های عددی معتبر سامانه ساخته شده و برای تصمیم‌گیری به مرور انسانی نیاز دارد."
      : "برای این بازه هنوز شاخص عددی کافی ثبت نشده است.",
    findings: selection.findingIds.map(id => finding(id, input)),
    suggestedActions: selection.actionIds.map(action),
    dataSufficiency: hasData ? "sufficient" : "insufficient",
    disclaimer: AI_ADVISORY_DISCLAIMER,
  };
}
