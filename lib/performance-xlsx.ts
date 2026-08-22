import { buildXlsx, type XlsxSheet } from "./simple-xlsx";
import type { getPerformanceReport, PerformanceComparisonMetric } from "./performance-report";

type PerformanceReport = Awaited<ReturnType<typeof getPerformanceReport>>;
type PerformanceRow = PerformanceReport["rows"][number];

function dateTime(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    timeZone: "Asia/Tehran",
  }).format(new Date(value));
}

function dateOnly(value: string) {
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Tehran" }).format(new Date(value));
}

function timeOnly(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("fa-IR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Tehran" }).format(new Date(value));
}

function tehranDateKey(value: string) {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Tehran" }).format(new Date(value));
}

function pointsForLastDays(row: PerformanceRow, days: number) {
  return [...row.dailySeries].sort((a, b) => a.date.localeCompare(b.date)).slice(-days);
}

function missionsForPoints(row: PerformanceRow, points: PerformanceRow["dailySeries"]) {
  const dateKeys = new Set(points.map(point => tehranDateKey(point.date)));
  return row.missions.missionDetails.filter(mission => mission.completedAt && dateKeys.has(tehranDateKey(mission.completedAt)));
}

function personnelPeriodSheet(name: string, report: PerformanceReport, days: number): XlsxSheet {
  const sheet: XlsxSheet = {
    name,
    widths: [24, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 42],
    rows: [["پرسنل", "روز دارای فعالیت", "کارکرد دقیقه", "کار انجام‌شده", "کار موفق", "درصد موفقیت", "مسافت حرکت km", "مسافت مأموریت km", "میانگین مسافت مأموریت km", "حضور در محل دقیقه", "GPS / اینترنت دقیقه", "شرح کارهای تعیین‌وضعیت‌شده"]],
  };
  for (const row of report.rows) {
    const points = pointsForLastDays(row, days);
    const missions = missionsForPoints(row, points);
    const activeMinutes = points.reduce((sum, point) => sum + point.activeMinutes, 0);
    const completedCount = missions.length;
    const successfulCount = missions.filter(mission => mission.result === "انجام شد").length;
    const measuredMissionCount = points.reduce((sum, point) => sum + point.measuredMissionCount, 0);
    const missionDistanceKm = Math.round(points.reduce((sum, point) => sum + point.missionDistanceKm, 0) * 10) / 10;
    const averageMissionDistanceKm = measuredMissionCount ? Math.round(missionDistanceKm / measuredMissionCount * 10) / 10 : 0;
    sheet.rows.push([
      row.fullName,
      points.filter(point => point.activeMinutes > 0).length,
      activeMinutes,
      completedCount,
      successfulCount,
      completedCount ? Math.round(successfulCount / completedCount * 100) : 0,
      Math.round(points.reduce((sum, point) => sum + point.distanceKm, 0) * 10) / 10,
      missionDistanceKm,
      averageMissionDistanceKm,
      points.reduce((sum, point) => sum + point.onSiteMinutes, 0),
      `${points.reduce((sum, point) => sum + point.gpsGapMinutes, 0)} / ${points.reduce((sum, point) => sum + point.internetGapMinutes, 0)}`,
      missions.map(mission => `${mission.title} — ${mission.result ?? "بدون نتیجه"}`).join(" | ") || "بدون کار تعیین‌وضعیت‌شده",
    ]);
  }
  return sheet;
}

function dailyPersonnelSheet(report: PerformanceReport): XlsxSheet {
  const sheet: XlsxSheet = {
    name: "گزارش روزانه پرسنل",
    widths: [18, 24, 18, 20, 18, 18, 18, 18, 18, 18, 18, 18, 46],
    rows: [["تاریخ", "پرسنل", "اولین ورود", "آخرین خروج", "کارکرد دقیقه", "مسافت حرکت km", "حضور در محل دقیقه", "GPS دقیقه", "اینترنت دقیقه", "میانگین مسافت مأموریت km", "تعداد کار", "کار موفق", "شرح کارها و نتیجه"]],
  };
  for (const row of report.rows) {
    const points = pointsForLastDays(row, 1);
    const point = points[0];
    const missions = missionsForPoints(row, points);
    const averageMissionDistanceKm = point?.measuredMissionCount ? Math.round(point.missionDistanceKm / point.measuredMissionCount * 10) / 10 : 0;
    sheet.rows.push([
      point ? dateOnly(point.date) : dateOnly(report.range.end),
      row.fullName,
      timeOnly(point?.firstStartAt),
      point?.hasActiveSession ? "در حال فعالیت" : timeOnly(point?.lastEndAt),
      point?.activeMinutes ?? 0,
      point?.distanceKm ?? 0,
      point?.onSiteMinutes ?? 0,
      point?.gpsGapMinutes ?? 0,
      point?.internetGapMinutes ?? 0,
      averageMissionDistanceKm,
      missions.length,
      missions.filter(mission => mission.result === "انجام شد").length,
      missions.map(mission => `${mission.title} — ${mission.result ?? "بدون نتیجه"}`).join(" | ") || "بدون کار تعیین‌وضعیت‌شده",
    ]);
  }
  return sheet;
}

function periodLabel(period: PerformanceReport["period"]) {
  return period === "daily" ? "روزانه" : period === "weekly" ? "هفتگی" : "ماهانه";
}

function change(metric: PerformanceComparisonMetric | undefined) {
  if (!metric) return "—";
  if (metric.percentChange == null) return metric.current === 0 ? "۰٪" : "دوره قبل بدون داده";
  return `${metric.percentChange > 0 ? "+" : ""}${metric.percentChange}%`;
}

export function buildPerformanceXlsx(report: PerformanceReport, historyReport: PerformanceReport = report, generatedAt = new Date()) {
  const comparison = report.comparison?.metrics;
  const total = report.totals;
  const summary: XlsxSheet = {
    name: "خلاصه مدیریتی",
    widths: [30, 22, 22, 20, 20],
    rows: [
      ["شاخص", "مقدار فعلی", "مقدار دوره قبل", "تغییر", "توضیح"],
      ["بازه گزارش", `${periodLabel(report.period)}؛ ${dateTime(report.range.start)} تا ${dateTime(report.range.end)}`, "", "", report.policy.note],
      ["تعداد کارکنان", total.userCount, report.comparison?.previousTotals.userCount ?? "—", "", "کارکنان فعال در محدوده دسترسی مدیر"],
      ["کارکرد واقعی (دقیقه)", total.activeMinutes, comparison?.activeMinutes.previous ?? "—", change(comparison?.activeMinutes), "زمان دارای پوشش معتبر طبق سیاست کارکرد"],
      ["مأموریت تکمیل‌شده", total.completedCount, comparison?.completedCount.previous ?? "—", change(comparison?.completedCount), "همه نتایج تعیین‌تکلیف‌شده"],
      ["درصد موفقیت مأموریت", total.successRate, comparison?.successRate.previous ?? "—", change(comparison?.successRate), "انجام شد ÷ مأموریت تکمیل‌شده"],
      ["موفقیت در اولین مراجعه", total.firstVisitSuccessRate, comparison?.firstVisitSuccessRate.previous ?? "—", change(comparison?.firstVisitSuccessRate), "انجام موفق بدون مراجعه مجدد"],
      ["میانگین زمان کل مأموریت (دقیقه)", total.averageMissionMinutes, comparison?.averageMissionMinutes.previous ?? "—", change(comparison?.averageMissionMinutes), "شروع مأموریت تا تعیین وضعیت"],
      ["میانگین زمان مسیر (دقیقه)", total.averageTravelMinutes, comparison?.averageTravelMinutes.previous ?? "—", change(comparison?.averageTravelMinutes), "شروع مأموریت تا ثبت مقصد"],
      ["میانگین حضور در مقصد (دقیقه)", total.averageOnSiteMinutes, comparison?.averageOnSiteMinutes.previous ?? "—", change(comparison?.averageOnSiteMinutes), "ثبت مقصد تا تعیین وضعیت"],
      ["میانگین مسافت هر مأموریت (کیلومتر)", total.averageMissionDistanceKm, comparison?.averageMissionDistanceKm.previous ?? "—", change(comparison?.averageMissionDistanceKm), "فقط مسیرهای دارای داده GPS"],
      ["کل مسافت مأموریت‌ها (کیلومتر)", total.missionDistanceKm, comparison?.missionDistanceKm.previous ?? "—", change(comparison?.missionDistanceKm), "مسافت مسیرهای مأموریت"],
      ["پوشش معتبر GPS (درصد)", total.gpsCoverageRate, comparison?.gpsCoverageRate.previous ?? "—", change(comparison?.gpsCoverageRate), "کارکرد معتبر ÷ کل زمان ثبت‌شده"],
      ["وقفه GPS (دقیقه)", total.gpsGapMinutes, comparison?.gpsGapMinutes.previous ?? "—", change(comparison?.gpsGapMinutes), "جمع رویدادهای قطعی GPS"],
      ["وقفه اینترنت (دقیقه)", total.internetGapMinutes, comparison?.internetGapMinutes.previous ?? "—", change(comparison?.internetGapMinutes), "جمع رویدادهای قطع ارتباط ثبت‌شده"],
      ["هزینه ثبت‌شده", total.totalExpenses, comparison?.totalExpenses.previous ?? "—", change(comparison?.totalExpenses), "تومان"],
    ],
  };

  const dailyPersonnel = dailyPersonnelSheet(historyReport);
  const weeklyPersonnel = personnelPeriodSheet("گزارش هفتگی پرسنل", historyReport, 7);
  const monthlyPersonnel = personnelPeriodSheet("گزارش ماهانه پرسنل", historyReport, 30);

  const daily: XlsxSheet = {
    name: "روند روزانه",
    widths: [18, 18, 18, 18, 18, 18, 18, 18, 18],
    rows: [["تاریخ", "کارکرد دقیقه", "تکمیل", "موفق", "زمان مسیر", "حضور مقصد", "مسافت km", "وقفه GPS", "وقفه اینترنت"]],
  };
  for (const point of report.dailySeries) daily.rows.push([dateOnly(point.date), point.activeMinutes, point.completedCount, point.successfulCount, point.travelMinutes, point.onSiteMinutes, point.missionDistanceKm, point.gpsGapMinutes, point.internetGapMinutes]);

  const missions: XlsxSheet = {
    name: "جزئیات مأموریت‌ها",
    widths: [22, 30, 16, 16, 20, 22, 22, 22, 22, 18, 18, 18, 18, 16, 16, 18, 18, 18],
    rows: [["کارمند", "عنوان مأموریت", "منبع", "نتیجه", "مقصد", "تاریخ ثبت", "شروع", "ثبت مقصد", "تعیین وضعیت", "تعداد مراجعه", "زمان کل دقیقه", "زمان مسیر دقیقه", "حضور مقصد دقیقه", "مسافت km", "پوشش GPS", "هزینه", "امتیاز قطعی", "امتیاز در انتظار"]],
  };
  for (const row of report.rows) for (const mission of row.missions.missionDetails) missions.rows.push([
    row.fullName, mission.title, mission.source === "employee" ? "خودساخته" : "مدیریت", mission.result ?? "—",
    mission.destinationName ?? "—", dateTime(mission.createdAt), dateTime(mission.startedAt), dateTime(mission.destinationRecordedAt),
    dateTime(mission.completedAt), mission.attemptCount, mission.totalMinutes, mission.travelMinutes, mission.serviceMinutes,
    mission.distanceKm, mission.coverageStatus === "complete" ? "کامل" : mission.coverageStatus === "partial" ? "ناقص" : "بدون داده",
    mission.expenseAmount, mission.confirmedScore, mission.pendingScore,
  ]);

  const routes: XlsxSheet = {
    name: "مسیر و مسافت",
    widths: [22, 30, 24, 22, 22, 18, 18, 18, 18, 18, 18, 16],
    rows: [["کارمند", "مأموریت", "مقصد", "شروع مسیر", "ثبت مقصد", "زمان مسیر", "حرکت", "توقف", "مسافت km", "سرعت متوسط", "حداکثر سرعت", "پوشش GPS"]],
  };
  for (const row of report.rows) for (const trip of row.movement.missionTrips) routes.rows.push([
    row.fullName, trip.title, trip.destinationName ?? "—", dateTime(trip.startedAt), dateTime(trip.destinationRecordedAt),
    trip.travelMinutes, trip.movingMinutes, trip.stoppedMinutes, trip.distanceKm, trip.averageMovingSpeedKmh,
    trip.maxSpeedKmh, trip.coverageStatus === "complete" ? "کامل" : trip.coverageStatus === "partial" ? "ناقص" : "بدون داده",
  ]);

  const integrity: XlsxSheet = {
    name: "GPS و اینترنت",
    widths: [24, 18, 18, 18, 18, 18, 18],
    rows: [["کارمند", "پوشش GPS درصد", "وقفه GPS دقیقه", "وقفه اینترنت دقیقه", "رویداد باز", "خوداظهاری", "شروع مأموریت ثبت‌نشده"]],
  };
  for (const row of report.rows) integrity.rows.push([row.fullName, row.integrity.gpsCoverageRate, row.integrity.gpsGapMinutes, row.integrity.internetGapMinutes, row.integrity.openCount, row.attendance.selfReportedStartCount, row.quality.missedMissionStarts]);

  const finance: XlsxSheet = {
    name: "هزینه‌ها",
    widths: [24, 20, 20, 20, 20, 20],
    rows: [["کارمند", "کل هزینه", "تأییدشده", "در انتظار", "ردشده", "میانگین هر مأموریت"]],
  };
  for (const row of report.rows) finance.rows.push([row.fullName, row.finance.total, row.finance.approved, row.finance.pending, row.finance.rejected, row.finance.averagePerMission]);

  const scores: XlsxSheet = {
    name: "امتیاز و تأییدها",
    widths: [24, 18, 18, 18, 18, 18, 18],
    rows: [["کارمند", "امتیاز قطعی", "در انتظار", "کسرشده", "تأیید اولین‌بار درصد", "تأییدشده", "رد یا اصلاح"]],
  };
  for (const row of report.rows) scores.rows.push([row.fullName, row.quality.confirmedScore, row.quality.pendingScore, row.quality.deductedScore, row.quality.firstPassApprovalRate, row.quality.approvalCount, row.quality.rejectedOrRevisionCount]);

  return buildXlsx([summary, dailyPersonnel, weeklyPersonnel, monthlyPersonnel, daily, missions, routes, integrity, finance, scores], generatedAt);
}
