import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("defines the Persian RTL login experience", async () => {
  const [layout, page] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /<html lang="fa" dir="rtl">/i);
  assert.match(page, /ورود به پنل کارمند/);
  assert.match(page, /دسترسی را مدیر می‌سازد/);
  assert.doesNotMatch(page, /ali\.rezaei|Demo@1405|داده‌های نمایشی/);
  assert.match(layout, /سامانه مدیریت عملیات میدانی/);
});

test("keeps the critical backend contracts and removes the branch feature", async () => {
  const [schema, security, auth, page, missions] = await Promise.all([
    readFile(new URL("../db/mysql-schema.sql", import.meta.url), "utf8"),
    readFile(new URL("../lib/security.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(schema, /CREATE TABLE IF NOT EXISTS missions/);
  assert.doesNotMatch(schema, /branches|branchId|branch_id/);

  assert.match(security, /PBKDF2/);
  assert.match(security, /210_000/);
  assert.match(auth, /HttpOnly/);
  assert.match(auth, /SameSite=Strict/);
  assert.doesNotMatch(page, /branches|branchName|branchAddress|شعبه/);
  assert.doesNotMatch(missions, /branches|branchId|branch_id/);
});

test("includes phase-two GPS, offline, upload and report capabilities", async () => {
  const [schema, locations, attachments, offline, reports, hosting, page] = await Promise.all([
    readFile(new URL("../db/mysql-schema.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/locations/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/attachments/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/offline-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/reports/export/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(schema, /CREATE TABLE IF NOT EXISTS location_points/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS integrity_events/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS attachments/);
  assert.match(locations, /clientEventId|location_points/);
  assert.match(page, /navigator\.geolocation\.watchPosition/);
  assert.match(page, /enableHighAccuracy: true/);
  assert.match(attachments, /fileStorage\.put/);
  assert.match(offline, /indexedDB\.open/);
  assert.match(offline, /flushOutbox/);
  assert.match(reports, /text\/csv/);
  assert.match(hosting, /DB_NAME=/);
  assert.match(hosting, /UPLOAD_DIR=/);
});

test("keeps employee work start compatible with older Android Chrome", async () => {
  const [page, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(packageJson, /"Chrome >= 80"/);
  assert.match(packageJson, /"ChromeAndroid >= 80"/);
  assert.match(page, /function createClientId\(\)/);
  assert.doesNotMatch(page, /clientEventId: crypto\.randomUUID\(\)/);
  assert.match(page, /navigator\.geolocation\.watchPosition/);
  assert.match(page, /timeout:45_000/);
  assert.match(page, /در حال دریافت موقعیت دقیق/);
});

test("supports role-scoped mission assignment from the management panel", async () => {
  const [page, missions, users] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/users/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /ثبت و تخصیص مأموریت/);
  assert.match(page, /assignedTo:missionAssignee/);
  assert.match(page, /فقط کارکنانی نمایش داده می‌شوند که مستقیماً زیر نظر شما هستند/);
  assert.match(missions, /assignee\.supervisorId !== auth\.user\.id/);
  assert.match(missions, /سرپرست فقط می‌تواند به کاربران زیرمجموعه خودش مأموریت بدهد/);
  assert.match(users, /u\.supervisor_id = \?/);
});

test("records server creation time and validates Jalali mission deadlines", async () => {
  const [page, missions] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /تاریخ شمسی مهلت/);
  assert.match(page, /ساعت مهلت/);
  assert.match(page, /تاریخ و ساعت ثبت/);
  assert.match(page, /formatPersianDateTime\(m\.createdAt\)/);
  assert.match(page, /deadlineDate:missionDeadlineDate/);
  assert.match(missions, /normalizeJalaliDeadline/);
  assert.match(missions, /const now = new Date\(\)\.toISOString\(\)/);
  assert.match(missions, /created_at\) VALUES/);
});

test("allows real edit and delete only before the assignee starts work", async () => {
  const [page, mutationRoute, startRoute] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/[id]/start/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /ویرایش مأموریت/);
  assert.match(page, /حذف مأموریت/);
  assert.match(page, /قفل‌شده پس از شروع/);
  assert.match(page, /\/api\/missions\/\$\{mission\.id\}\/start/);
  assert.match(mutationRoute, /mission\.status !== "open"/);
  assert.match(mutationRoute, /پس از شروع مأموریت، ویرایش آن امکان‌پذیر نیست/);
  assert.match(mutationRoute, /export async function DELETE/);
  assert.match(startRoute, /UPDATE missions SET status = 'in_progress'/);
  assert.match(startRoute, /mission\.assignedTo !== auth\.user\.id/);
});

test("assigns supervisors only to employee accounts", async () => {
  const [page, users] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/users/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /accessRole === "employee" && <label>سرپرست/);
  assert.match(page, /role:accessRole,\s*supervisorId:accessRole === "employee"/);
  assert.match(page, /مدیر · بدون سرپرست/);
  assert.match(users, /if \(role === "employee"\)/);
  assert.match(users, /role = 'supervisor' AND status = 'active'/);
  assert.match(users, /supervisorId = body\.supervisorId/);
  assert.match(users, /\.bind\(id, fullName, mobile, username, credential\.hash, credential\.salt, role, supervisorId, createdAt\)/);
});

test("makes every mission result selectable and persists the selected value", async () => {
  const [page, completeRoute] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/[id]/complete/route.ts", import.meta.url), "utf8"),
  ]);

  for (const result of ["انجام شد", "نیاز به پیگیری", "مسئول نبود", "تعطیل بود", "موکول شد", "سایر"]) {
    assert.match(page, new RegExp(result));
    assert.match(completeRoute, new RegExp(result));
  }
  assert.match(page, /onClick=\{\(\)=>\{setWorkResult\(option\.label\);setWorkReport\(option\.defaultReport\)/);
  assert.match(page, /result: workResult, report: workReport\.trim\(\)/);
  assert.match(page, /aria-pressed=\{workResult === option\.label\}/);
  assert.match(completeRoute, /allowedResults\.includes\(workResult\)/);
  assert.match(completeRoute, /result: workResult/);
});

test("supports multiple receipts and keeps mission expenses off by default", async () => {
  const [page, attachments, attachmentItem, offline, completeRoute] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/attachments/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/attachments/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/offline-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/[id]/complete/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /const \[expenseEnabled, setExpenseEnabled\] = useState\(false\)/);
  assert.match(page, /ثبت هزینه انجام‌شده بابت این مأموریت/);
  assert.match(page, /type="file" multiple/);
  assert.match(page, /Array\.from\(event\.target\.files \?\? \[\]\)/);
  assert.match(page, /attachments\.map\(attachment=>/);
  assert.match(page, /expenseEnabled && <><span>هزینه انجام‌شده<\/span>/);
  assert.match(page, /expenseAmount: expenseEnabled \? parseExpenseAmount\(expenseAmount\) : 0/);
  assert.match(attachments, /fileStorage\.put/);
  assert.match(attachmentItem, /export async function DELETE/);
  assert.match(attachmentItem, /fileStorage\.delete/);
  assert.match(offline, /removeQueuedItem/);
  assert.match(completeRoute, /Number\.isFinite\(rawExpenseAmount\)/);
});

test("shows an employee daily report and requires confirmation with a note before ending work", async () => {
  const [page, summaryRoute, summaryHelper, workSessions, missions, schema, migration] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/employee/daily-summary/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/employee-daily-summary.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/work-sessions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/mysql-schema.sql", import.meta.url), "utf8"),
    readFile(new URL("../db/mysql-schema.sql", import.meta.url), "utf8"),
  ]);

  assert.match(page, /گزارش کامل امروز من/);
  assert.match(page, /مراجعات و نتایج ثبت‌شده امروز/);
  assert.match(page, /کارهای باز یا نیازمند پیگیری/);
  assert.match(page, /مقصدها و حضور امروز/);
  assert.match(page, /فعالیت‌های امروز مورد تأیید من است/);
  assert.match(page, /ثبت توضیحات پایان فعالیت/);
  assert.match(page, /endNote:endWorkNote\.trim\(\)/);
  assert.match(page, /!summaryConfirmed \|\| endWorkNote\.trim\(\)\.length < 3/);
  assert.match(page, /confirmDailySummary:true, confirmedMissionIds:dailySummary\.confirmationMissionIds/);
  assert.match(page, /openMissionDetail\(m/);
  assert.match(summaryRoute, /requireRole\(request, \["employee"\]\)/);
  assert.match(summaryHelper, /confirmationMissionIds/);
  assert.match(summaryHelper, /locationSummary/);
  assert.match(workSessions, /if \(!body\.confirmDailySummary\)/);
  assert.match(workSessions, /work_session\.daily_summary_confirmed/);
  assert.match(workSessions, /ثبت توضیحات پایان فعالیت الزامی است/);
  assert.match(workSessions, /end_note = \?/);
  assert.match(workSessions, /فهرست فعالیت‌ها تغییر کرده است/);
  assert.match(summaryHelper, /end_note AS endNote/);
  assert.match(schema, /end_note TEXT NULL/);
  assert.match(migration, /end_note TEXT NULL/);
  assert.match(missions, /m\.completed_at AS completedAt/);
});

test("locks mission work outside an active shift and reports daily weekly and monthly hours", async () => {
  const [page, startRoute, completeRoute, summaryRoute, summaryHelper, workSessions] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/[id]/start/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/[id]/complete/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/employee/daily-summary/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/employee-daily-summary.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/work-sessions/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /if \(!working\) return notify\("برای شروع کار روی مأموریت/);
  assert.match(page, /disabled=\{!working \|\| destinationSaving\} onClick=\{registerDestination\}/);
  assert.match(page, /formatDurationSeconds\(todayWorkMinutes\*60\+\(working\?Math\.max\(0,\(clockTick-workMinutesSyncedAt\)\/1000\):0\)\)/);
  assert.match(page, /ورود \$\{formatPersianTime\(todayFirstStartAt\)\} · خروج/);
  assert.match(page, /۷ روز اخیر/);
  assert.match(page, /۳۰ روز اخیر/);
  assert.match(page, /ساعت ورود، خروج و کارکرد/);
  assert.match(startRoute, /SELECT id FROM work_sessions WHERE user_id = \? AND status = 'active'/);
  assert.match(startRoute, /ابتدا فعالیت روزانه را شروع کنید/);
  assert.match(completeRoute, /فعالیت روزانه پایان یافته است/);
  assert.match(summaryRoute, /requestedPeriod === "weekly" \|\| requestedPeriod === "monthly"/);
  assert.match(summaryHelper, /period === "weekly" \? 6 : period === "monthly" \? 29/);
  assert.match(summaryHelper, /firstStartAt/);
  assert.match(summaryHelper, /lastEndAt/);
  assert.match(workSessions, /activeMinutes: today\.activeMinutes, firstStartAt: today\.firstStartAt/);
  assert.match(workSessions, /lastEndAt: today\.lastEndAt/);
});

test("provides a complete and safe user account lifecycle", async () => {
  const [page, userCollection, userMutation, auth] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/users/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/users/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/auth.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /ویرایش \/ رمز/);
  assert.match(page, /رمز عبور جدید \(اختیاری\)/);
  assert.match(page, /فعال‌سازی/);
  assert.match(page, /غیرفعال/);
  assert.match(page, /deleteUser/);
  assert.match(page, /method:editing \? "PATCH" : "POST"/);
  assert.match(userCollection, /user\.created/);
  assert.match(userMutation, /export async function PATCH/);
  assert.match(userMutation, /export async function DELETE/);
  assert.match(userMutation, /DELETE FROM sessions WHERE user_id = \?/);
  assert.match(userMutation, /user\.updated/);
  assert.match(userMutation, /user\.deleted/);
  assert.match(userMutation, /سابقه عملیاتی دارد/);
  assert.match(userMutation, /ابتدا کارکنان زیرمجموعه این سرپرست را/);
  assert.match(auth, /AND u\.status = 'active'/);
});

test("delivers scoped daily weekly and monthly performance reports with exports", async () => {
  const [page, reportEngine, reportRoute, exportRoute, employeeRoute, schema, migration] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/performance-report.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/reports/summary/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/reports/export/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/employee/daily-summary/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/mysql-schema.sql", import.meta.url), "utf8"),
    readFile(new URL("../db/mysql-schema.sql", import.meta.url), "utf8"),
  ]);

  assert.match(page, /گزارش عملکرد اعضای تیم/);
  assert.match(page, /خروجی Excel \/ CSV/);
  assert.match(page, /چاپ \/ ذخیره PDF/);
  assert.match(page, /تحلیل عملکرد من/);
  assert.match(page, /زمان دسته‌بندی‌نشده/);
  assert.match(reportEngine, /viewer\.role === "supervisor"/);
  assert.match(reportEngine, /u\.supervisor_id = \?/);
  assert.match(reportEngine, /distanceKm/);
  assert.match(reportEngine, /missionTripMetrics/);
  assert.match(reportEngine, /missionDistanceKm/);
  assert.match(reportEngine, /destinationRecordedAt/);
  assert.match(reportEngine, /movingMinutes/);
  assert.match(reportEngine, /stoppedMinutes/);
  assert.match(reportEngine, /firstByDay\.values\(\)/);
  assert.match(reportEngine, /localMinuteOfDay\(value\) - STANDARD_START_MINUTES/);
  assert.match(reportEngine, /gpsGapMinutes/);
  assert.match(reportEngine, /onTimeRate/);
  assert.match(reportEngine, /firstPassApprovalRate/);
  assert.match(reportRoute, /getPerformanceReport/);
  assert.match(exportRoute, /text\/csv/);
  assert.match(exportRoute, /format"\) === "print"/);
  assert.match(exportRoute, /جزئیات مسیر ماموریت‌ها/);
  assert.match(exportRoute, /زمان در حرکت دقیقه/);
  assert.match(employeeRoute, /performance: performance\.rows\[0\]/);
  assert.match(page, /مسیر هر مأموریتِ/);
  assert.match(page, /زمان واقعاً در حرکت/);
  assert.match(page, /پوشش GPS/);
  assert.match(schema, /deadline_at VARCHAR/);
  assert.match(schema, /started_at VARCHAR/);
  assert.match(migration, /idx_missions_assigned_completed/);
});

test("ships a clean production seed with only the requested administrator", async () => {
  const [page, runtime, schema, layout, localGuide] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/mysql-schema.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../LOCAL_SETUP.md", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(page, /initialMissions|const staff|MockMap|دسترسی نمایشی|داده‌های نمایشی|Demo@1405|Admin@1405/);
  assert.match(page, /هنوز موقعیتی ثبت نشده است/);
  assert.match(page, /اطلاعات واقعی ۷ روز گذشته/);
  assert.match(runtime, /INITIAL_ADMIN_PASSWORD \|\| "123123456"/);
  assert.match(runtime, /"مدیر سیستم"/);
  assert.doesNotMatch(runtime, /Supervisor@1405|Demo@1405|h\.kazemi|ali\.rezaei/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS users/);
  assert.match(runtime, /INITIAL_ADMIN_PASSWORD/);
  assert.doesNotMatch(runtime, /cloudflare:workers|env\.FILES|D1Database/);
  assert.doesNotMatch(layout, /نمونه نمایشی|پروتوتایپ/);
  assert.match(localGuide, /رمز عبور: `123123456`/);
});

test("ships a standard Node.js MySQL and cPanel production target", async () => {
  const [packageJson, database, storage, config, environment, startup, nginx, apache, health] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../lib/server-database.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/file-storage.ts", import.meta.url), "utf8"),
    readFile(new URL("../next.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../app.cjs", import.meta.url), "utf8"),
    readFile(new URL("../deploy/nginx.conf", import.meta.url), "utf8"),
    readFile(new URL("../deploy/apache-proxy.conf", import.meta.url), "utf8"),
    readFile(new URL("../app/api/health/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(packageJson, /"next": "16\.3\.1"/);
  assert.match(packageJson, /"mysql2": "3\.15\.3"/);
  assert.doesNotMatch(packageJson, /vinext|wrangler|cloudflare/);
  assert.match(database, /mysql2\/promise/);
  assert.match(database, /DB_HOST/);
  assert.match(storage, /UPLOAD_DIR/);
  assert.match(config, /output: "standalone"/);
  assert.match(environment, /INITIAL_ADMIN_USERNAME=admin/);
  assert.match(startup, /\.next\/standalone\/server\.js/);
  assert.match(nginx, /taprasystem\.ir/);
  assert.match(apache, /127\.0\.0\.1:3000/);
  assert.match(health, /SELECT 1 AS ok/);
  for (const source of [database, storage, config, startup, health]) {
    assert.doesNotMatch(source, /cloudflare:workers|D1Database|R2Bucket/);
  }
});

test("lets employees inspect open missions and records a transparent no-start score penalty", async () => {
  const [page, completeRoute, startRoute, schema, reportEngine, runtime, migration] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/[id]/complete/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/[id]/start/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/mysql-schema.sql", import.meta.url), "utf8"),
    readFile(new URL("../lib/performance-report.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/migrate.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(page, /onClick=\{\(\) => openMissionDetail\(m\)\}/);
  assert.match(page, /شرح وظیفه را بخوانید و سپس روش ادامه را انتخاب کنید/);
  assert.match(page, /شروع کار روی این مأموریت/);
  assert.match(page, /ثبت مقصد بدون زدن شروع کار/);
  assert.match(page, /انتخاب مأموریت دیگر از فهرست/);
  assert.match(page, /<h2>ثبت مقصد<\/h2>/);
  assert.doesNotMatch(page, /<h2>ثبت مقصد و شروع کار<\/h2>/);
  assert.match(page, /۳ امتیاز کسر شد؛ چون شروع کار روی این مأموریت ثبت نشده بود/);
  assert.match(startRoute, /UPDATE missions SET status = 'in_progress'[\s\S]*started_at = \?/);
  assert.match(completeRoute, /const completedWithoutStart = !mission\.startedAt/);
  assert.match(completeRoute, /const scorePenalty = completedWithoutStart \? 3 : 0/);
  assert.match(completeRoute, /mission_completed_without_start/);
  assert.match(completeRoute, /score_note = \?/);
  assert.doesNotMatch(completeRoute, /started_at = COALESCE/);
  assert.match(schema, /score_penalty INT NOT NULL DEFAULT 0/);
  assert.match(schema, /score_note VARCHAR\(255\) NULL/);
  assert.match(reportEngine, /missedMissionStarts/);
  assert.match(reportEngine, /deductedScore/);
  assert.match(runtime, /INFORMATION_SCHEMA\.COLUMNS/);
  assert.match(migration, /notification_enabled/);
  assert.match(migration, /verified mission scoring and work-session policy columns/);
});

test("stores numbered daily mission destinations and maps them only in management views", async () => {
  const [schema, destinations, completeRoute, page, map, layout] = await Promise.all([
    readFile(new URL("../db/mysql-schema.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/destinations/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/[id]/complete/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/OperationsMap.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(schema, /CREATE TABLE IF NOT EXISTS mission_destinations/);
  assert.match(schema, /mission_id CHAR\(36\) NOT NULL UNIQUE/);
  assert.match(schema, /idx_mission_destinations_user_recorded/);
  assert.match(destinations, /mission\.destination_registered/);
  assert.match(destinations, /ON DUPLICATE KEY UPDATE/);
  assert.match(destinations, /const counterKey = `\$\{row\.userId\}:\$\{dateKey\}`/);
  assert.match(destinations, /sequence = \(counters\.get\(counterKey\) \?\? 0\) \+ 1/);
  assert.match(destinations, /u\.supervisor_id = \?/);
  assert.match(completeRoute, /FROM mission_destinations WHERE mission_id = \?/);
  assert.match(page, /setLatestGps\(\{ latitude:position\.coords\.latitude/);
  assert.match(page, /sendJsonOrQueue\("\/api\/destinations", "POST"/);
  assert.match(page, /نقشه فقط در پنل مدیر نمایش داده می‌شود/);
  assert.match(page, /موقعیت زنده و مقصدهای امروز/);
  assert.match(page, /نقشه مقصدهای \{selected\.fullName\}/);
  assert.match(map, /L\.circleMarker/);
  assert.match(map, /destination\.sequence\.toLocaleString\("fa-IR"\)/);
  assert.match(map, /L\.polyline/);
  assert.match(layout, /leaflet\/dist\/leaflet\.css/);
});

test("captures and audits mission start destination and end points for manager scoring", async () => {
  const [schema, startRoute, completeRoute, traceRoute, locationHelper, page, map, runtime, migration] = await Promise.all([
    readFile(new URL("../db/mysql-schema.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/[id]/start/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/[id]/complete/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/[id]/trace/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/mission-location.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/OperationsMap.tsx", import.meta.url), "utf8"),
    readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/migrate.mjs", import.meta.url), "utf8"),
  ]);

  for (const column of ["start_latitude_e6", "start_longitude_e6", "start_accuracy_cm", "start_location_recorded_at", "end_latitude_e6", "end_longitude_e6", "end_accuracy_cm", "end_location_recorded_at"]) {
    assert.match(schema, new RegExp(column));
    assert.match(runtime, new RegExp(column));
    assert.match(migration, new RegExp(column));
  }
  assert.match(startRoute, /parseMissionLocation\(body\.location\)/);
  assert.match(startRoute, /start_latitude_e6 = \?/);
  assert.match(completeRoute, /parseMissionLocation\(body\.endLocation\)/);
  assert.match(completeRoute, /end_latitude_e6 = \?/);
  assert.match(traceRoute, /requireRole\(request, \["owner", "admin", "supervisor"\]\)/);
  assert.match(traceRoute, /nearestGpsPoint/);
  assert.match(traceRoute, /destinationToEndMeters > 150/);
  assert.match(traceRoute, /mission\.location_score_reviewed/);
  assert.match(traceRoute, /score < 0 \|\| score > 12/);
  assert.match(locationHelper, /distanceMeters/);
  assert.match(page, /بررسی مراجعه ثبت‌شده/);
  assert.match(page, /نقطه شروع کار/);
  assert.match(page, /نقطه پایان کار/);
  assert.match(page, /ثبت نمره مدیر یا سرپرست/);
  assert.match(page, /endLocation:latestGps/);
  assert.match(page, /location:latestGps/);
  assert.match(map, /tracePoints/);
  assert.match(map, /markerLabel/);
});

test("routes every non-success result into follow-up and makes supervisor action optional", async () => {
  const [page, schema, missionsRoute, completeRoute, startRoute, decisionRoute] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../db/mysql-schema.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/[id]/complete/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/[id]/start/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/approvals/[id]/decision/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(schema, /CREATE TABLE IF NOT EXISTS mission_attempts/);
  assert.match(schema, /UNIQUE KEY uq_mission_attempt_no/);
  assert.match(missionsRoute, /attemptCount/);
  assert.match(completeRoute, /const needsFollowUp = workResult !== "انجام شد"/);
  assert.match(completeRoute, /const requestSupervisorAction = needsFollowUp && body\.requestSupervisorAction === true/);
  assert.match(completeRoute, /const status = needsFollowUp \? "follow_up"/);
  assert.match(completeRoute, /INSERT INTO mission_attempts/);
  assert.match(startRoute, /"open", "follow_up", "revision"/);
  assert.match(startRoute, /mission\.follow_up_started/);
  assert.match(decisionRoute, /approval\.missionStatus === "follow_up_pending" \? "follow_up"/);
  assert.match(page, /checked=\{requestSupervisorAction\}/);
  assert.match(page, /label:"پیگیری مجدد"/);
  assert.match(page, /setAdminMissionFilter\(filter\.id\)/);
  assert.match(page, /filteredAdminMissions\.map/);
  assert.match(page, /گزارش ثبت و پیگیری بعدی ساخته شد/);
});

test("shows live tracking only for active online users with fresh GPS", async () => {
  const [locations, destinations, users, page] = await Promise.all([
    readFile(new URL("../app/api/locations/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/destinations/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/users/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(locations, /Date\.now\(\) - 2 \* 60_000/);
  assert.match(locations, /u\.status = 'active'/);
  assert.match(locations, /ws\.status = 'active'/);
  assert.match(locations, /latest_ws\.status = 'active'/);
  assert.match(destinations, /url\.searchParams\.get\("live"\) === "1"/);
  assert.match(destinations, /live_ws\.status = 'active'/);
  assert.match(users, /status = 'ended'[\s\S]*end_source = 'account_disabled'/);
  assert.match(users, /DELETE FROM push_subscriptions WHERE user_id = \?/);
  assert.match(page, /period=daily&live=1/);
  assert.match(page, /setLiveLocations\(current => current\.filter\(location => location\.userId !== user\.id\)\)/);
  assert.match(page, /setInterval\([\s\S]*30_000/);
});

test("keeps the latest accepted GPS point available to managers without presenting it as live", async () => {
  const [locations, page, map] = await Promise.all([
    readFile(new URL("../app/api/locations/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/OperationsMap.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(locations, /url\.searchParams\.get\("mode"\) === "last"/);
  assert.match(locations, /latestAnyPoint/);
  assert.match(locations, /u\.status = 'active'/);
  assert.match(locations, /workSessionStatus === "active"/);
  assert.match(page, /\/api\/locations\?mode=last/);
  assert.match(page, /آخرین موقعیت ثبت‌شده/);
  assert.match(page, /setLastLocations\(current => current\.filter/);
  assert.match(map, /location\.isLive/);
  assert.match(map, /آخرین موقعیت؛ زنده نیست/);
  assert.match(map, /آخرین موقعیت ثبت‌شده/);
});

test("delivers role-scoped in-app and phone notifications with secure account settings", async () => {
  const [schema, runtime, missions, notifications, settings, subscriptions, push, worker, page, account, accountUi, notificationUi, packageJson, environment] = await Promise.all([
    readFile(new URL("../db/mysql-schema.sql", import.meta.url), "utf8"),
    readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/notifications/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/notifications/settings/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/notifications/subscriptions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/push-notifications.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/account/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/AccountSettings.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/NotificationSettings.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /notification_enabled TINYINT\(1\) NOT NULL DEFAULT 1/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS notifications/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS push_subscriptions/);
  assert.match(runtime, /ALTER TABLE users ADD COLUMN notification_enabled/);
  assert.match(missions, /createUserNotification\(assignedTo/);
  assert.match(notifications, /openRequestCount/);
  assert.match(notifications, /'open','in_progress','revision','follow_up'/);
  assert.match(settings, /notification_enabled = \?/);
  assert.match(subscriptions, /sameOrigin/);
  assert.match(subscriptions, /endpoint_hash/);
  assert.match(push, /webpush\.sendNotification/);
  assert.match(push, /\[404, 410\]/);
  assert.match(worker, /self\.addEventListener\("push"/);
  assert.match(worker, /notificationclick/);
  assert.match(page, /اعلان‌ها و درخواست‌های باز/);
  assert.match(page, /notificationCounts\.open/);
  assert.match(account, /verifyPassword/);
  assert.match(account, /rotateSession/);
  assert.match(accountUi, /نام کاربری، رمز و اطلاعات حساب|حساب و امنیت/);
  assert.match(notificationUi, /فعال‌سازی اعلان روی گوشی/);
  assert.match(notificationUi, /Notification\.requestPermission/);
  assert.match(packageJson, /"web-push": "3\.6\.7"/);
  assert.match(environment, /VAPID_PUBLIC_KEY=/);
  assert.match(environment, /VAPID_PRIVATE_KEY=/);
});

test("restores the exact panel after refresh and delivers follow-up messages as native manager notifications", async () => {
  const [page, bootstrap, pushClient, messages, worker, deploy, vapidSetup] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PushNotificationBootstrap.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/push-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/follow-up-requests/[id]/messages/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../deploy.sh", import.meta.url), "utf8"),
    readFile(new URL("../scripts/ensure-vapid.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(page, /PANEL_STORAGE_KEY = "tapra:last-panel"/);
  assert.match(page, /ADMIN_SCREEN_STORAGE_KEY = "tapra:admin-screen"/);
  assert.match(page, /url\.searchParams\.get\("panel"\) === "admin"/);
  assert.match(page, /window\.history\.replaceState/);
  assert.match(page, /\["owner", "admin", "supervisor"\]\.includes/);
  assert.match(page, /<PushNotificationBootstrap active=\{adminSignedIn\}/);
  assert.match(bootstrap, /Notification\.requestPermission/);
  assert.match(bootstrap, /Notification\.permission === "granted"/);
  assert.match(pushClient, /navigator\.serviceWorker\.register\("\/sw\.js"\)/);
  assert.match(pushClient, /\/api\/notifications\/subscriptions/);
  assert.match(messages, /panel=admin&screen=actions/);
  assert.match(worker, /requireInteraction: true/);
  assert.match(worker, /existing\.navigate\(target\)/);
  assert.match(deploy, /node scripts\/ensure-vapid\.mjs \.env/);
  assert.match(vapidSetup, /webpush\.generateVAPIDKeys\(\)/);
  assert.match(vapidSetup, /refusing to replace an existing key/);
  assert.doesNotMatch(vapidSetup, /console\.log\([^\n]*(publicKey|privateKey)/);
});

test("rotates login sessions atomically and supports cached legacy password forms", async () => {
  const [auth, changePassword, account, page] = await Promise.all([
    readFile(new URL("../lib/auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/change-password/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/account/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(auth, /export async function rotateSession/);
  assert.match(auth, /db\.batch\(\[/);
  assert.match(auth, /DELETE FROM sessions WHERE user_id = \?/);
  assert.match(auth, /INSERT INTO sessions/);
  assert.match(changePassword, /rotateSession\(user\.id/);
  assert.match(changePassword, /body\.confirmPassword !== undefined/);
  assert.match(changePassword, /password !== body\.confirmPassword/);
  assert.doesNotMatch(changePassword, /createSession\(user\.id\)/);
  assert.match(account, /rotateSession\(auth\.user\.id/);
  assert.match(page, /autoComplete="new-password"/);
  assert.match(page, /confirmNewPassword/);
  assert.match(page, /setPassword\(""\)/);
});

test("detects new releases without interrupting authenticated field work", async () => {
  const [versionSource, versionRoute, versionGuard, page, styles, worker, health, nextConfig, packageJson, versionFile] = await Promise.all([
    readFile(new URL("../lib/app-version.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/version/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/AppVersionGuard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/health/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../next.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../VERSION", import.meta.url), "utf8"),
  ]);
  const releaseVersion = versionFile.trim();
  assert.equal(JSON.parse(packageJson).version, releaseVersion);
  assert.match(versionSource, new RegExp(`APP_VERSION = ["']${releaseVersion.replaceAll(".", "\\.")}["']`));
  assert.match(versionRoute, /Cache-Control.*no-store/);
  assert.match(versionGuard, /\/api\/version\?loaded=/);
  assert.match(versionGuard, /cache: "no-store"/);
  assert.match(versionGuard, /authResponse\.status === 401/);
  assert.match(versionGuard, /window\.location\.replace/);
  assert.match(versionGuard, /window\.history\.replaceState/);
  assert.match(versionGuard, /setInterval\(checkForUpdate, 5 \* 60_000\)/);
  assert.doesNotMatch(versionGuard, /indexedDB\.deleteDatabase|caches\.delete/);
  assert.match(page, /<AppVersionGuard \/>/);
  assert.match(styles, /\.app-update-banner/);
  assert.match(worker, /self\.skipWaiting\(\)/);
  assert.match(worker, /self\.clients\.claim\(\)/);
  assert.match(health, /APP_VERSION/);
  assert.match(nextConfig, /source: "\/"[\s\S]*Cache-Control[\s\S]*no-store/);
});

test("ends shifts without GPS blocking and deducts only beyond the 30 minute grace", async () => {
  const [policy, workSessions, locations, page, performance, exportRoute] = await Promise.all([
    readFile(new URL("../lib/work-session-policy.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/work-sessions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/locations/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/performance-report.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/reports/export/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(policy, /GPS_GAP_GRACE_MINUTES = 30/);
  assert.match(policy, /coveredFrom \+ graceMilliseconds/);
  assert.doesNotMatch(policy, /MAX_GPS_GAP_MINUTES = 5/);
  assert.match(locations, /work_session_id = \?/);
  assert.match(locations, /> GPS_GAP_GRACE_MINUTES \* 60_000/);
  assert.match(locations, /deductedMinutes: Math\.max\(0, gapMinutes - GPS_GAP_GRACE_MINUTES\)/);
  assert.match(workSessions, /body\.action !== "end"/);
  assert.match(workSessions, /endTime\?: string/);
  assert.match(workSessions, /employee_without_gps/);
  assert.match(workSessions, /gpsWarning: !location/);
  assert.match(workSessions, /deductedMinutes > 0/);
  assert.doesNotMatch(workSessions, /if \(!location\) return Response\.json\(\{ error: "پایان فعالیت فقط با موقعیت GPS/);
  assert.match(page, /currentTehranDayKey/);
  assert.match(page, /nextDayKey === displayDayKey/);
  assert.match(page, /endTime, confirmDailySummary:true/);
  assert.match(page, /latestGps && Date\.now\(\) - Date\.parse\(latestGps\.recordedAt\) <= 2 \* 60_000/);
  assert.match(page, /موقعیت پایان در دسترس نبود و برای بررسی ثبت شد/);
  assert.match(performance, /برای هر قطعی پیوسته GPS، ۳۰ دقیقه مهلت وجود دارد/);
  assert.match(exportRoute, /زمان اضافه بر مهلت ۳۰ دقیقه بدون GPS/);
});

test("supports minimal employee escalation and audited mission follow-up conversations", async () => {
  const [schema, page, component, complete, start, list, messages, decision, attachments, notifications] = await Promise.all([
    readFile(new URL("../db/mysql-schema.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/FollowUpCenter.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/[id]/complete/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/[id]/start/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/follow-up-requests/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/follow-up-requests/[id]/messages/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/follow-up-requests/[id]/decision/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/attachments/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/notifications/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS mission_follow_up_requests/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS mission_follow_up_messages/);
  assert.match(schema, /follow_up_message_id CHAR\(36\) NULL/);
  assert.match(page, /این پیگیری نیاز به اقدام سرپرست دارد/);
  assert.match(page, /پیش‌فرض خاموش است/);
  assert.doesNotMatch(page, /انتخاب گیرنده پیگیری|انتخاب مدیر برای پیگیری/);
  assert.match(page, /checked=\{requestSupervisorAction\}/);
  assert.match(page, /requestSupervisorAction:workResult !== "انجام شد" && requestSupervisorAction/);
  assert.match(complete, /u\.supervisor_id AS supervisorId/);
  assert.match(complete, /const requestSupervisorAction = needsFollowUp && body\.requestSupervisorAction === true/);
  assert.match(complete, /const status = needsFollowUp \? "follow_up"/);
  assert.match(complete, /INSERT INTO mission_follow_up_requests/);
  assert.match(complete, /createUserNotification\(mission\.supervisorId/);
  assert.match(start, /awaiting_supervisor.*awaiting_employee.*escalated/);
  assert.match(component, /عکس، فایل یا ویس/);
  assert.match(component, /درخواست اطلاعات/);
  assert.match(component, /بازگشت به پیگیری/);
  assert.match(component, /ارجاع به مدیر/);
  assert.match(list, /auth\.user\.role === "employee"/);
  assert.match(messages, /follow_up\.message_sent/);
  assert.match(decision, /follow_up\.decision/);
  assert.match(decision, /return_to_employee/);
  assert.match(decision, /resolution_note/);
  assert.match(attachments, /audio\/mpeg/);
  assert.match(attachments, /messageId/);
  assert.match(notifications, /mission_follow_up_requests/);
});

test("limits concurrent mission starts and allows an audited five minute cancellation", async () => {
  const [page, start, policy, database, missions] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/[id]/start/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/mission-start-policy.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/server-database.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(policy, /MAX_CONCURRENT_MISSIONS = 3/);
  assert.match(policy, /MISSION_START_CANCEL_WINDOW_MS = 5 \* 60_000/);
  assert.match(database, /async transaction<T>/);
  assert.match(start, /SELECT id FROM users WHERE id = \? FOR UPDATE/);
  assert.match(start, /status = 'in_progress'/);
  assert.match(start, /activeCount >= MAX_CONCURRENT_MISSIONS/);
  assert.match(start, /مأموریت در حال انجام دارید/);
  assert.match(start, /export async function DELETE/);
  assert.match(start, /missionStartCancellationState\(mission\.startedAt\)/);
  assert.match(start, /mission\.start_cancelled/);
  assert.match(start, /پس از ثبت مقصد، انصراف از شروع مأموریت امکان‌پذیر نیست/);
  assert.match(page, /id:"in_progress",label:"در حال انجام"/);
  assert.match(page, /status:"in_progress"/);
  assert.match(page, /activeMissionCount >= MAX_CONCURRENT_MISSIONS/);
  assert.match(page, /method: "DELETE"/);
  assert.match(page, /علت انصراف از شروع/);
  assert.match(missions, /startCancellationCount/);
  assert.match(missions, /lastStartCancellationReason/);
});

test("stores and displays an optional work referrer for employee-created missions", async () => {
  const [page, missions, schema, runtime, migration, approvals] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/mysql-schema.sql", import.meta.url), "utf8"),
    readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/migrate.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/api/approvals/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /referrer_name VARCHAR\(255\) NULL/);
  assert.match(runtime, /name: "referrer_name"/);
  assert.match(migration, /\["referrer_name", "VARCHAR\(255\) NULL AFTER assigned_to"\]/);
  assert.match(missions, /referrerName\?: string \| null/);
  assert.match(missions, /source === "employee" \? requestedReferrerName \|\| null : null/);
  assert.match(missions, /assigned_to, referrer_name, destination_name/);
  assert.match(missions, /m\.referrer_name AS referrerName/);
  assert.match(missions, /JSON\.stringify\(\{ source, assignedTo, referrerName \}\)/);
  assert.match(page, /const \[newReferrerName, setNewReferrerName\] = useState\(""\)/);
  assert.match(page, /ارجاع‌دهنده کار <small>اختیاری<\/small>/);
  assert.match(page, /referrerName: newReferrerName\.trim\(\) \|\| null/);
  assert.match(page, /selectedMission\.referrerName/);
  assert.match(approvals, /m\.referrer_name AS referrerName/);
});

test("records every mission status with trusted time and a cached reverse-geocoded location timeline", async () => {
  const [schema, helper, eventsRoute, missions, start, destination, complete, migration, page, styles] = await Promise.all([
    readFile(new URL("../db/mysql-schema.sql", import.meta.url), "utf8"),
    readFile(new URL("../lib/mission-status-events.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/[id]/events/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/[id]/start/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/destinations/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/[id]/complete/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/migrate.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/access.css", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS mission_status_events/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS reverse_geocode_cache/);
  assert.match(schema, /server_recorded_at VARCHAR\(40\) NOT NULL/);
  assert.match(helper, /nominatim\.openstreetmap\.org\/reverse/);
  assert.match(helper, /1_100/);
  assert.match(helper, /TapraSystem\/\$\{APP_VERSION\} \(https:\/\/taprasystem\.ir\)/);
  assert.match(helper, /coordinateKey/);
  assert.match(helper, /geocode_status='failed'/);
  assert.match(eventsRoute, /canReadMission/);
  assert.match(eventsRoute, /geocode_status='pending'/);
  assert.match(missions, /eventType:"created"/);
  assert.match(start, /eventType:"started"/);
  assert.match(destination, /eventType:"destination_registered"/);
  assert.match(complete, /eventType:"status_set"/);
  assert.match(migration, /backfilled.*TRUE/);
  assert.match(page, /تاریخچه وضعیت مأموریت/);
  assert.match(page, /MissionStatusTimeline events=\{missionEvents\}/);
  assert.match(page, /MissionStatusTimeline events=\{missionTraceEvents\}/);
  assert.match(styles, /\.mission-status-timeline/);
});
