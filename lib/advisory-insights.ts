export const ADVISORY_INSIGHTS_ENGINE = "tapra-deterministic-v1" as const;

export type AdvisoryPerformanceInput = {
  attendance: {
    activeMinutes: number;
    shortfallMinutes: number;
    pendingCorrectionMinutes: number;
  };
  missions: {
    assignedCount: number;
    completedCount: number;
    successRate: number;
    followUpCount: number;
    overdueCount: number;
  };
  movement: {
    missionDistanceKm: number;
    locationPointCount: number;
  };
  integrity: {
    gpsCoverageRate: number;
    gpsGapMinutes: number;
    internetGapMinutes: number;
  };
};

export type AdvisoryFact = {
  id: string;
  label: string;
  value: number;
  unit: "minutes" | "count" | "percent" | "kilometers";
  evidencePath: string;
};

export type AdvisoryNotice = {
  id: string;
  title: string;
  detail: string;
  level: "info" | "review";
  evidencePath: string;
};

export type AdvisoryInsights = {
  engine: typeof ADVISORY_INSIGHTS_ENGINE;
  advisory: true;
  disclaimer: string;
  facts: AdvisoryFact[];
  alerts: AdvisoryNotice[];
  recommendations: AdvisoryNotice[];
};

type AdvisoryRole = "owner" | "admin" | "supervisor" | "employee";
export type AdvisorySubject = { id: string; role: AdvisoryRole; status: string; supervisorId: string | null };

export function canAccessPerformanceInsight(viewer: { id: string; role: AdvisoryRole }, subject: AdvisorySubject) {
  if (viewer.id === subject.id) return true;
  if (viewer.role === "employee") return false;
  if (viewer.role === "supervisor") {
    return subject.role === "employee" && subject.status === "active" && subject.supervisorId === viewer.id;
  }
  return subject.role === "employee" && subject.status === "active";
}

function finiteNonNegative(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function buildPerformanceAdvisory(input: AdvisoryPerformanceInput): AdvisoryInsights {
  const activeMinutes = finiteNonNegative(input.attendance.activeMinutes);
  const completedCount = finiteNonNegative(input.missions.completedCount);
  const assignedCount = finiteNonNegative(input.missions.assignedCount);
  const successRate = finiteNonNegative(input.missions.successRate);
  const gpsCoverageRate = finiteNonNegative(input.integrity.gpsCoverageRate);
  const gpsGapMinutes = finiteNonNegative(input.integrity.gpsGapMinutes);
  const internetGapMinutes = finiteNonNegative(input.integrity.internetGapMinutes);
  const missionDistanceKm = finiteNonNegative(input.movement.missionDistanceKm);
  const locationPointCount = finiteNonNegative(input.movement.locationPointCount);
  const shortfallMinutes = finiteNonNegative(input.attendance.shortfallMinutes);
  const pendingCorrectionMinutes = finiteNonNegative(input.attendance.pendingCorrectionMinutes);
  const overdueCount = finiteNonNegative(input.missions.overdueCount);
  const followUpCount = finiteNonNegative(input.missions.followUpCount);
  const hasNoOperationalData = activeMinutes === 0 && assignedCount === 0 && locationPointCount === 0;

  const facts: AdvisoryFact[] = [
    { id: "active-minutes", label: "کارکرد قابل‌تأیید", value: activeMinutes, unit: "minutes", evidencePath: "attendance.activeMinutes" },
    { id: "completed-missions", label: "مأموریت تکمیل‌شده", value: completedCount, unit: "count", evidencePath: "missions.completedCount" },
    { id: "success-rate", label: "نرخ موفقیت ثبت‌شده", value: successRate, unit: "percent", evidencePath: "missions.successRate" },
    { id: "mission-distance", label: "مسافت مأموریت‌های اندازه‌گیری‌شده", value: missionDistanceKm, unit: "kilometers", evidencePath: "movement.missionDistanceKm" },
    { id: "gps-coverage", label: "پوشش GPS معتبر", value: gpsCoverageRate, unit: "percent", evidencePath: "integrity.gpsCoverageRate" },
  ];

  const alerts: AdvisoryNotice[] = [];
  const recommendations: AdvisoryNotice[] = [];

  if (hasNoOperationalData) {
    alerts.push({
      id: "insufficient-data", title: "داده کافی برای تحلیل وجود ندارد",
      detail: "این بازه هنوز کارکرد، مأموریت یا نقطه موقعیت ثبت‌شده‌ای ندارد و نیازمند بررسی بازه انتخابی است.",
      level: "info", evidencePath: "attendance.activeMinutes",
    });
    recommendations.push({
      id: "verify-period", title: "بازه گزارش را بررسی کنید",
      detail: "بازه زمانی و کاربر انتخاب‌شده را بررسی کنید و پس از ثبت داده دوباره تحلیل را ببینید.",
      level: "info", evidencePath: "movement.locationPointCount",
    });
  }
  if (gpsGapMinutes > 0) {
    alerts.push({
      id: "gps-gap-review", title: "پوشش GPS نیازمند بررسی است",
      detail: `${Math.round(gpsGapMinutes).toLocaleString("fa-IR")} دقیقه وقفه GPS داخل زمان فعالیت ثبت شده است.`,
      level: "review", evidencePath: "integrity.gpsGapMinutes",
    });
    recommendations.push({
      id: "review-gps-settings", title: "تنظیمات موقعیت دستگاه بررسی شود",
      detail: "مجوز موقعیت، حالت دقیق و محدودیت باتری دستگاه بررسی شود؛ این پیشنهاد به‌تنهایی اثبات‌کننده علت وقفه نیست.",
      level: "review", evidencePath: "integrity.gpsGapMinutes",
    });
  }
  if (internetGapMinutes > 0) {
    alerts.push({
      id: "contact-gap-review", title: "ارتباط دستگاه نیازمند بررسی است",
      detail: `${Math.round(internetGapMinutes).toLocaleString("fa-IR")} دقیقه وقفه ارتباط ثبت شده است.`,
      level: "review", evidencePath: "integrity.internetGapMinutes",
    });
  }
  if (overdueCount > 0) {
    alerts.push({
      id: "overdue-review", title: "مأموریت معوق نیازمند بررسی است",
      detail: `${Math.round(overdueCount).toLocaleString("fa-IR")} مأموریت از مهلت ثبت‌شده عبور کرده است.`,
      level: "review", evidencePath: "missions.overdueCount",
    });
    recommendations.push({
      id: "review-overdue", title: "وضعیت مأموریت‌های معوق مرور شود",
      detail: "مهلت و وضعیت مأموریت‌های باز بررسی و در صورت نیاز برنامه پیگیری روشن شود.",
      level: "review", evidencePath: "missions.overdueCount",
    });
  }
  if (followUpCount > 0) {
    recommendations.push({
      id: "review-follow-ups", title: "دلایل پیگیری مجدد مرور شود",
      detail: `${Math.round(followUpCount).toLocaleString("fa-IR")} نتیجه نیازمند پیگیری مجدد ثبت شده است؛ الگوی دلایل آن نیازمند بررسی انسانی است.`,
      level: "review", evidencePath: "missions.followUpCount",
    });
  }
  if (shortfallMinutes > 0) {
    recommendations.push({
      id: "review-shortfall", title: "کسری کارکرد نیازمند بررسی است",
      detail: `${Math.round(shortfallMinutes).toLocaleString("fa-IR")} دقیقه نسبت به هدف بازه ثبت شده است؛ پیش از هر تصمیم، وقفه‌ها و ثبت‌های ناقص بررسی شوند.`,
      level: "review", evidencePath: "attendance.shortfallMinutes",
    });
  }
  if (pendingCorrectionMinutes > 0) {
    recommendations.push({
      id: "review-corrections", title: "خوداظهاری‌های در انتظار بررسی شوند",
      detail: `${Math.round(pendingCorrectionMinutes).toLocaleString("fa-IR")} دقیقه اصلاح زمانی هنوز در انتظار بررسی است.`,
      level: "review", evidencePath: "attendance.pendingCorrectionMinutes",
    });
  }
  if (!hasNoOperationalData && alerts.length === 0 && recommendations.length === 0) {
    recommendations.push({
      id: "continue-monitoring", title: "روند فعلی پایش شود",
      detail: "در داده‌های ساختاریافته این بازه مورد برجسته‌ای شناسایی نشد؛ بررسی انسانی گزارش‌ها همچنان لازم است.",
      level: "info", evidencePath: "missions.completedCount",
    });
  }

  return {
    engine: ADVISORY_INSIGHTS_ENGINE,
    advisory: true,
    disclaimer: "این تحلیل قطعی نیست، فقط مشورتی است و هیچ اثر خودکاری بر امتیاز، وضعیت مأموریت یا کارکرد ندارد.",
    facts,
    alerts,
    recommendations,
  };
}
