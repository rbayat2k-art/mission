import { requireRole } from "../../../../lib/auth";
import { getPerformanceReport, type PerformancePeriod } from "../../../../lib/performance-report";
import { buildPerformanceXlsx } from "../../../../lib/performance-xlsx";

function csv(value: unknown) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
function html(value: unknown) { return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!)); }
function hours(minutes: number) { return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`; }
function localDateTime(value: string | null) { return value ? new Intl.DateTimeFormat("fa-IR-u-ca-persian", { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hour12:false, timeZone:"Asia/Tehran" }).format(new Date(value)) : "—"; }

export async function GET(request: Request) {
  const auth = await requireRole(request, ["owner", "admin", "supervisor"]);
  if ("error" in auth) return auth.error;
  const url = new URL(request.url);
  const requested = url.searchParams.get("period");
  const period: PerformancePeriod = requested === "weekly" || requested === "monthly" ? requested : "daily";
  const format = url.searchParams.get("format");
  const now = new Date();
  const report = await getPerformanceReport(auth.user, period, now, { includeComparison: format === "xlsx" });
  if (format === "xlsx") {
    const historyReport = period === "monthly" ? report : await getPerformanceReport(auth.user, "monthly", now);
    const workbook = buildPerformanceXlsx(report, historyReport, now);
    return new Response(new Uint8Array(workbook), { headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename=tapra-${period}-performance.xlsx`,
      "Cache-Control": "no-store",
    } });
  }
  if (format === "print") {
    const title = period === "daily" ? "گزارش روزانه" : period === "weekly" ? "گزارش هفتگی" : "گزارش ماهانه";
    const rows = report.rows.map(row => `<tr><td>${html(row.fullName)}</td><td>${html(localDateTime(row.movement.firstDestinationAt))}</td><td>${html(localDateTime(row.movement.lastDestinationAt))}</td><td>${hours(row.attendance.activeMinutes)}</td><td>${row.missions.completedCount}</td><td>${row.missions.successfulCount}</td><td>${row.missions.openCount}</td><td>${row.missions.overdueCount}</td><td>${row.missions.completionRate}%</td><td>${row.missions.onTimeRate}%</td><td>${hours(row.movement.travelMinutes)}</td><td>${hours(row.movement.movingMinutes)}</td><td>${row.movement.missionDistanceKm}</td><td>${row.integrity.gpsGapMinutes}</td><td>${row.quality.confirmedScore}</td><td>${row.quality.pendingScore}</td><td>${row.finance.total.toLocaleString("fa-IR")}</td></tr>`).join("");
    const document = `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>${title} راهکار</title><style>body{font-family:Tahoma,Arial,sans-serif;color:#18263a;padding:28px}h1{margin:0 0 6px}p{color:#64748b}table{width:100%;border-collapse:collapse;margin-top:22px;font-size:11px}th,td{border:1px solid #d9e0e8;padding:8px;text-align:center}th{background:#eef3ff}.note{margin-top:18px;padding:10px;background:#fff8e7;border:1px solid #eed79d;font-size:11px}@media print{button{display:none}body{padding:0}@page{size:landscape;margin:12mm}}</style></head><body><button onclick="window.print()">چاپ / ذخیره PDF</button><h1>${title} عملکرد نیروهای میدانی</h1><p>${new Date(report.range.start).toLocaleDateString("fa-IR-u-ca-persian")} تا ${new Date(report.range.end).toLocaleDateString("fa-IR-u-ca-persian")}</p><table><thead><tr><th>کارمند</th><th>اولین ثبت مقصد</th><th>آخرین ثبت مقصد</th><th>کارکرد</th><th>تکمیل</th><th>موفق</th><th>باز</th><th>معوق</th><th>نرخ تکمیل</th><th>به‌موقع</th><th>کل زمان مسیر</th><th>حرکت واقعی با GPS</th><th>مسافت مأموریت km</th><th>وقفه GPS داخل فعالیت</th><th>امتیاز قطعی</th><th>در انتظار</th><th>هزینه</th></tr></thead><tbody>${rows}</tbody></table><div class="note">${html(report.policy.note)} کل زمان مسیر از شروع هر مأموریت تا ثبت مقصد است و حرکت واقعی فقط از نقاط GPS متحرک محاسبه می‌شود. وقفه GPS فقط بین شروع و پایان فعالیت محاسبه می‌شود. مسیر و نقشه فقط در پنل مدیریتی قابل مشاهده است.</div><script>setTimeout(()=>window.print(),400)</script></body></html>`;
    return new Response(document, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  }
  const header = ["نام کارمند", "نام کاربری", "سرپرست", "اولین ثبت مقصد", "آخرین ثبت مقصد", "کارکرد واقعی قابل‌تأیید دقیقه", "روز حضور", "تاخیر دقیقه", "اضافه‌کار پس از ۹ ساعت دقیقه", "کسری نسبت به ۸:۳۰ دقیقه", "زمان اضافه بر مهلت ۳۰ دقیقه بدون GPS", "خوداظهاری در انتظار دقیقه", "تعداد شروع خوداظهاری", "ماموریت تخصیص‌یافته", "تکمیل‌شده", "موفق", "نیازمند پیگیری", "باز", "معوق", "در انتظار تایید", "نرخ تکمیل", "نرخ به‌موقع", "حضور در مقصد دقیقه", "کل زمان مسیر (شروع تا مقصد) دقیقه", "حرکت واقعی با GPS دقیقه", "توقف در مسیر دقیقه", "مسافت ماموریت‌ها کیلومتر", "کل مسافت GPS کیلومتر", "جزئیات مسیر ماموریت‌ها", "مقصدها", "وقفه GPS داخل فعالیت دقیقه", "مدرک", "امتیاز قطعی", "امتیاز در انتظار", "هزینه کل", "هزینه تاییدشده", "هزینه در انتظار"];
  const rows = report.rows.map(row => [row.fullName, row.username, row.supervisorName, localDateTime(row.movement.firstDestinationAt), localDateTime(row.movement.lastDestinationAt), row.attendance.activeMinutes, row.attendance.attendanceDays, row.attendance.lateMinutes, row.attendance.overtimeMinutes, row.attendance.shortfallMinutes, row.attendance.unverifiedGpsMinutes, row.attendance.pendingCorrectionMinutes, row.attendance.selfReportedStartCount, row.missions.assignedCount, row.missions.completedCount, row.missions.successfulCount, row.missions.followUpCount, row.missions.openCount, row.missions.overdueCount, row.missions.pendingCount, `${row.missions.completionRate}%`, `${row.missions.onTimeRate}%`, row.movement.onSiteMinutes, row.movement.travelMinutes, row.movement.movingMinutes, row.movement.stoppedMinutes, row.movement.missionDistanceKm, row.movement.distanceKm, row.movement.missionTrips.map(trip => `${trip.title}: ${trip.travelMinutes} دقیقه مسیر، ${trip.movingMinutes} دقیقه حرکت، ${trip.distanceKm} کیلومتر`).join(" | "), row.movement.destinations.join(" | "), row.integrity.gpsGapMinutes, row.quality.attachmentCount, row.quality.confirmedScore, row.quality.pendingScore, row.finance.total, row.finance.approved, row.finance.pending].map(csv).join(","));
  const content = `\uFEFF${header.map(csv).join(",")}\r\n${rows.join("\r\n")}`;
  return new Response(content, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename=rahkar-${period}-report.csv`, "Cache-Control": "no-store" } });
}
