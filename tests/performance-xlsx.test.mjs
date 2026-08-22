import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

async function loadWorkbookBuilder() {
  const simpleSource = await readFile(new URL("../lib/simple-xlsx.ts", import.meta.url), "utf8");
  const simpleJavaScript = ts.transpileModule(simpleSource, { compilerOptions:{ module:ts.ModuleKind.ESNext, target:ts.ScriptTarget.ES2022 } }).outputText;
  const simpleUrl = `data:text/javascript;base64,${Buffer.from(simpleJavaScript).toString("base64")}`;
  const performanceSource = (await readFile(new URL("../lib/performance-xlsx.ts", import.meta.url), "utf8"))
    .replace('from "./simple-xlsx"', `from "${simpleUrl}"`);
  const performanceJavaScript = ts.transpileModule(performanceSource, { compilerOptions:{ module:ts.ModuleKind.ESNext, target:ts.ScriptTarget.ES2022 } }).outputText;
  return await import(`data:text/javascript;base64,${Buffer.from(performanceJavaScript).toString("base64")}`);
}

function storedZipEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    entries.set(buffer.subarray(nameStart, nameStart + nameLength).toString("utf8"), buffer.subarray(dataStart, dataStart + size).toString("utf8"));
    offset = dataStart + size;
  }
  return entries;
}

function fixtureReport() {
  const point = { date:"2026-08-22T00:00:00Z", activeMinutes:510, completedCount:1, successfulCount:1, travelMinutes:30, onSiteMinutes:90, missionDistanceKm:12, distanceKm:15, measuredMissionCount:1, firstStartAt:"2026-08-22T05:00:00Z", lastEndAt:"2026-08-22T13:30:00Z", hasActiveSession:false, firstDestinationAt:"2026-08-22T06:00:00Z", lastDestinationAt:"2026-08-22T12:00:00Z", gpsGapMinutes:4, internetGapMinutes:2 };
  const mission = { id:"mission-1", title:"پیگیری پرونده", source:"manager", status:"approved", result:"انجام شد", destinationName:"اداره", createdAt:point.date, startedAt:point.firstStartAt, destinationRecordedAt:"2026-08-22T06:00:00Z", completedAt:point.lastEndAt, deadlineAt:null, attemptCount:1, totalMinutes:510, serviceMinutes:90, travelMinutes:30, distanceKm:12, coverageStatus:"complete", expenseAmount:0, confirmedScore:12, pendingScore:0 };
  const row = {
    id:"user-1", fullName:"کارمند تست", username:"test", supervisorName:"مدیر",
    attendance:{ activeMinutes:510, attendanceDays:1, targetMinutes:510, overtimeMinutes:0, shortfallMinutes:0, lateMinutes:0, unverifiedGpsMinutes:0, pendingCorrectionMinutes:0, selfReportedStartCount:0, firstStartAt:point.firstStartAt, lastEndAt:point.lastEndAt, endNotes:[] },
    missions:{ assignedCount:1, completedCount:1, successfulCount:1, firstVisitSuccessfulCount:1, followUpCount:0, openCount:0, pendingCount:0, approvedCount:1, rejectedCount:0, overdueCount:0, selfCreatedCount:0, completionRate:100, successRate:100, firstVisitSuccessRate:100, followUpRate:0, onTimeRate:100, timedMissionCount:1, averageMissionMinutes:510, missionDetails:[mission] },
    movement:{ distanceKm:15, missionDistanceKm:12, travelMinutes:30, movingMinutes:25, stoppedMinutes:5, onSiteMinutes:90, unclassifiedMinutes:390, destinationCount:1, firstDestinationAt:point.firstDestinationAt, lastDestinationAt:point.lastDestinationAt, destinations:["اداره"], locationPointCount:10, missionTrips:[], averageTravelMinutes:30, averageOnSiteMinutes:90, averageMissionDistanceKm:12 },
    integrity:{ eventCount:2, openCount:0, gpsGapMinutes:4, internetGapMinutes:2, gpsCoverageRate:99 },
    quality:{ attachmentCount:0, approvalCount:1, rejectedOrRevisionCount:0, firstPassApprovalRate:100, confirmedScore:12, pendingScore:0, deductedScore:0, missedMissionStarts:0 },
    finance:{ total:0, approved:0, pending:0, rejected:0, averagePerMission:0 }, dailySeries:[point],
  };
  const totals = { userCount:1, activeMinutes:510, assignedCount:1, completedCount:1, successfulCount:1, firstVisitSuccessfulCount:1, followUpCount:0, approvedCount:1, overdueCount:0, confirmedScore:12, pendingScore:0, distanceKm:15, missionDistanceKm:12, travelMinutes:30, movingMinutes:25, onSiteMinutes:90, totalExpenses:0, gpsGapMinutes:4, internetGapMinutes:2, completionRate:100, successRate:100, firstVisitSuccessRate:100, followUpRate:0, averageMissionMinutes:510, averageTravelMinutes:30, averageOnSiteMinutes:90, averageMissionDistanceKm:12, gpsCoverageRate:99 };
  return { period:"daily", range:{ start:point.date, end:"2026-08-22T14:00:00Z", days:1 }, rows:[row], totals, dailySeries:[point], comparison:null, policy:{ standardStart:"۰۸:۳۰", standardDailyMinutes:510, overtimeStartMinutes:540, note:"تست" } };
}

test("builds one valid management workbook containing personnel daily weekly and monthly sheets", async () => {
  const { buildPerformanceXlsx } = await loadWorkbookBuilder();
  const report = fixtureReport();
  const workbook = buildPerformanceXlsx(report, report, new Date("2026-08-22T14:00:00Z"));
  assert.equal(workbook.subarray(0, 4).toString("hex"), "504b0304");
  const entries = storedZipEntries(workbook);
  assert.equal([...entries.keys()].filter(name => name.startsWith("xl/worksheets/sheet")).length, 10);
  const workbookXml = entries.get("xl/workbook.xml") ?? "";
  assert.match(workbookXml, /گزارش روزانه پرسنل/);
  assert.match(workbookXml, /گزارش هفتگی پرسنل/);
  assert.match(workbookXml, /گزارش ماهانه پرسنل/);
  const dailySheet = entries.get("xl/worksheets/sheet2.xml") ?? "";
  assert.match(dailySheet, /اولین ورود/);
  assert.match(dailySheet, /آخرین خروج/);
  assert.match(dailySheet, /اولین ثبت مقصد/);
  assert.match(dailySheet, /آخرین ثبت مقصد/);
  assert.match(dailySheet, /کارمند تست/);
  assert.match(dailySheet, /پیگیری پرونده — انجام شد/);
});
