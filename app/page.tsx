"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { flushOutbox, getOutboxCount, removeQueuedItem, sendFileOrQueue, sendJsonOrQueue } from "../lib/offline-client";
import OperationsMap, { type MapTracePoint } from "./components/OperationsMap";
import AccountSettings from "./components/AccountSettings";
import NotificationCenter from "./components/NotificationCenter";
import NotificationSettings from "./components/NotificationSettings";
import AppVersionGuard from "./components/AppVersionGuard";
import PushNotificationBootstrap from "./components/PushNotificationBootstrap";
import { EmployeeFollowUpPanel, FollowUpActionCenter } from "./components/FollowUpCenter";

type EmployeeScreen = "home" | "missions" | "new" | "work" | "report" | "mission-detail" | "end-review" | "profile" | "notifications" | "notification-settings" | "account-settings";
type AdminScreen = "dashboard" | "live" | "missions" | "actions" | "access" | "approvals" | "integrity" | "reports" | "notifications" | "account";
type PanelMode = "employee" | "admin";

const employeeScreens: EmployeeScreen[] = ["home", "missions", "new", "report", "profile", "notifications", "notification-settings", "account-settings"];
const adminScreens: AdminScreen[] = ["dashboard", "live", "missions", "actions", "access", "approvals", "integrity", "reports", "notifications", "account"];
const PANEL_STORAGE_KEY = "tapra:last-panel";
const EMPLOYEE_SCREEN_STORAGE_KEY = "tapra:employee-screen";
const ADMIN_SCREEN_STORAGE_KEY = "tapra:admin-screen";

type TapraAndroidBridge = {
  setTrackingActive: (active: boolean) => void;
  isNativeApp: () => boolean;
  isLocationPermissionGranted: () => boolean;
  openLocationSettings: () => void;
};

function androidBridge() {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { TapraAndroid?: TapraAndroidBridge }).TapraAndroid;
}

function isNativeAndroidApp() {
  try { return androidBridge()?.isNativeApp() === true; }
  catch { return false; }
}

function syncNativeTracking(active: boolean) {
  try { androidBridge()?.setTrackingActive(active); }
  catch { /* The browser version intentionally has no native bridge. */ }
}

function isEmployeeScreen(value: string | null): value is EmployeeScreen { return Boolean(value && employeeScreens.includes(value as EmployeeScreen)); }
function isAdminScreen(value: string | null): value is AdminScreen { return Boolean(value && adminScreens.includes(value as AdminScreen)); }
function isPanelMode(value: string | null): value is PanelMode { return value === "employee" || value === "admin"; }

function restoreEmployeeScreen(): EmployeeScreen {
  if (typeof window === "undefined") return "home";
  const url = new URL(window.location.href);
  const requested = url.searchParams.get("panel") === "employee" ? url.searchParams.get("screen") : null;
  const stored = sessionStorage.getItem(EMPLOYEE_SCREEN_STORAGE_KEY);
  return isEmployeeScreen(requested) ? requested : isEmployeeScreen(stored) ? stored : "home";
}

function restoreAdminScreen(): AdminScreen {
  if (typeof window === "undefined") return "dashboard";
  const url = new URL(window.location.href);
  const requested = url.searchParams.get("panel") === "admin" ? url.searchParams.get("screen") : null;
  const stored = sessionStorage.getItem(ADMIN_SCREEN_STORAGE_KEY);
  return isAdminScreen(requested) ? requested : isAdminScreen(stored) ? stored : "dashboard";
}

function persistNavigation(panel: PanelMode, screen?: EmployeeScreen | AdminScreen) {
  sessionStorage.setItem(PANEL_STORAGE_KEY, panel);
  if (screen) sessionStorage.setItem(panel === "admin" ? ADMIN_SCREEN_STORAGE_KEY : EMPLOYEE_SCREEN_STORAGE_KEY, screen);
  const url = new URL(window.location.href);
  url.searchParams.set("panel", panel);
  if (screen) url.searchParams.set("screen", screen);
  window.history.replaceState(window.history.state, "", url.toString());
}

type ApiMission = { id: string; title: string; description: string; source: "manager" | "employee"; status: string; priority: string; assignedTo?: string; destinationName?: string | null; result?: string | null; report?: string | null; expenseAmount?: number; deadline?: string | null; scorePending: number; scoreConfirmed: number; scorePenalty?: number; scoreNote?: string | null; startedAt?: string | null; employeeName?: string; completedAt?: string | null; createdAt?: string; attemptCount?: number; followUpRequestStatus?:string|null };
type ApiUser = { id: string; fullName: string; mobile: string; username: string; role: string; status: string; supervisorId?: string | null; supervisorName?: string | null; lastLoginAt?: string | null };
type ApiApproval = { id: string; missionId: string; title: string; employeeName: string; result: string; report: string; destinationName: string; expenseAmount: number; scorePending: number };
type UiMission = Omit<Partial<ApiMission>, "id"> & { id: string | number; title: string; meta: string; type: string; priority: string; status: string; backendStatus?: string };
type ApiLocation = { id: string; userId: string; fullName: string; latitude: number; longitude: number; accuracy: number; speed: number | null; recordedAt: string };
type ApiDestination = { id: string; missionId: string; missionTitle: string; userId: string; fullName: string; destinationName: string; latitude: number; longitude: number; accuracy: number; recordedAt: string; dateKey: string; sequence: number };
type ApiMissionTrace = {
  mission:{id:string;title:string;description:string;employeeName:string;status:string;result:string|null;report:string|null;startedAt:string|null;completedAt:string;scorePending:number;scoreConfirmed:number;scorePenalty:number;scoreNote:string|null};
  points:{start:(Omit<MapTracePoint,"kind"|"title">)|null;destination:(Omit<MapTracePoint,"kind"|"title">&{destinationName:string})|null;end:(Omit<MapTracePoint,"kind"|"title">)|null};
  metrics:{startToDestinationMeters:number|null;destinationToEndMeters:number|null;totalElapsedMinutes:number|null};
  evaluation:{confidence:"high"|"medium"|"low";flags:Record<string,boolean>;scoreHints:string[]};
};
type ApiIntegrityEvent = { id: string; type: string; severity: string; status: string; employeeName: string; occurredAt: string; details: Record<string, unknown>; reviewNote?: string | null };
type ApiReportRow = {
  id:string; fullName:string; username:string; supervisorName:string|null;
  attendance:{activeMinutes:number;attendanceDays:number;targetMinutes:number;overtimeMinutes:number;shortfallMinutes:number;lateMinutes:number;unverifiedGpsMinutes:number;pendingCorrectionMinutes:number;selfReportedStartCount:number;firstStartAt:string|null;lastEndAt:string|null;endNotes:{at:string;note:string}[]};
  missions:{assignedCount:number;completedCount:number;successfulCount:number;followUpCount:number;openCount:number;pendingCount:number;approvedCount:number;rejectedCount:number;overdueCount:number;selfCreatedCount:number;completionRate:number;onTimeRate:number;averageMissionMinutes:number};
  movement:{distanceKm:number;missionDistanceKm:number;travelMinutes:number;movingMinutes:number;stoppedMinutes:number;onSiteMinutes:number;unclassifiedMinutes:number;destinationCount:number;destinations:string[];locationPointCount:number;missionTrips:{missionId:string;title:string;status:string;destinationName:string|null;startedAt:string|null;destinationRecordedAt:string|null;travelMinutes:number;movingMinutes:number;stoppedMinutes:number;distanceKm:number;averageMovingSpeedKmh:number;maxSpeedKmh:number;pointCount:number;coverageStatus:"complete"|"partial"|"missing"}[]};
  integrity:{eventCount:number;openCount:number;gpsGapMinutes:number};
  quality:{attachmentCount:number;approvalCount:number;rejectedOrRevisionCount:number;firstPassApprovalRate:number;confirmedScore:number;pendingScore:number;deductedScore:number;missedMissionStarts:number};
  finance:{total:number;approved:number;pending:number;rejected:number;averagePerMission:number};
};
type UiAttachment = { localId: string; name: string; state: "uploading" | "uploaded" | "queued" | "error"; serverId?: string; queueId?: number };
type EmployeeDailySummary = { period: "daily" | "weekly" | "monthly"; date: string; completed: ApiMission[]; incomplete: ApiMission[]; destinations: string[]; locationSummary: { pointCount: number; firstAt: string | null; lastAt: string | null }; sessions: { id: string; status: string; startedAt: string; endedAt: string | null; endNote?: string | null; startSource?:string;endSource?:string|null;workType?:string;approvalStatus?:string;scorePenalty?:number;durationMinutes: number }[]; firstStartAt: string | null; lastEndAt: string | null; activeMinutes: number; rawSessionMinutes:number;unverifiedGpsMinutes:number;pendingCorrectionMinutes:number;requiredMinutes:number;overtimeStartsAtMinutes:number;overtimeMinutes:number;confirmedScore: number; pendingScore: number; confirmationMissionIds: string[]; performance?:ApiReportRow|null; policy?:{standardStart:string;standardDailyMinutes:number;overtimeStartMinutes?:number;note:string} };
type ApiWorkState = { current:{id:string;startedAt:string;endedAt:string|null;workType?:string}|null;autoEnded?:boolean;today:{activeMinutes:number;firstStartAt:string|null;lastEndAt:string|null;requiredMinutes:number;overtimeStartsAtMinutes:number;overtimeMinutes:number;unverifiedGpsMinutes:number;pendingCorrectionMinutes:number} };

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) } });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "خطا در ارتباط با سرور");
  return body;
}

function formatPersianDateTime(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

function formatPersianTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("fa-IR", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function currentPersianDate() {
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", { weekday:"long", year:"numeric", month:"long", day:"numeric" }).format(new Date());
}

function currentTehranDayKey(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}

function createClientId() {
  const browserCrypto = globalThis.crypto;
  if (typeof browserCrypto?.randomUUID === "function") return browserCrypto.randomUUID();
  if (typeof browserCrypto?.getRandomValues === "function") {
    const bytes = browserCrypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0"));
    return `${hex.slice(0,4).join("")}-${hex.slice(4,6).join("")}-${hex.slice(6,8).join("")}-${hex.slice(8,10).join("")}-${hex.slice(10).join("")}`;
  }
  return `legacy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatDurationSeconds(totalSeconds: number) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return [hours, minutes, seconds].map(value => value.toLocaleString("fa-IR", { minimumIntegerDigits: 2, useGrouping: false })).join(":");
}

function formatMinutes(totalMinutes: number) {
  const safe = Math.max(0, Math.round(Number(totalMinutes) || 0));
  return `${Math.floor(safe / 60).toLocaleString("fa-IR")} ساعت و ${(safe % 60).toLocaleString("fa-IR")} دقیقه`;
}

function splitStoredDeadline(value?: string | null) {
  const date = value?.match(/[۰-۹0-9]{4}\/[۰-۹0-9]{1,2}\/[۰-۹0-9]{1,2}/)?.[0] ?? "";
  const time = value?.match(/[۰-۹0-9]{1,2}:[۰-۹0-9]{2}/)?.[0] ?? "";
  return { date, time };
}

function parseExpenseAmount(value: string) {
  const latinDigits = value.replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit))).replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
  const amount = Number(latinDigits.replace(/[^0-9]/g, ""));
  return Number.isFinite(amount) ? amount : 0;
}

const Icon = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => (
  <span aria-hidden="true" className={`icon ${className}`}>{children}</span>
);

const emptyMission: UiMission = { id:"", title:"", meta:"", type:"", priority:"normal", status:"open" };

const workResultOptions = [
  { label: "انجام شد", icon: "✓", defaultReport: "کار با موفقیت انجام شد و نتیجه یا رسید دریافت گردید." },
  { label: "نیاز به پیگیری", icon: "↻", defaultReport: "بخشی از کار انجام شد و ادامه آن نیاز به پیگیری دارد." },
  { label: "مسئول نبود", icon: "♙", defaultReport: "مسئول مربوطه در زمان مراجعه در محل حضور نداشت." },
  { label: "تعطیل بود", icon: "▰", defaultReport: "محل مراجعه در زمان حضور تعطیل بود." },
  { label: "موکول شد", icon: "••", defaultReport: "انجام کار با هماهنگی انجام‌شده به زمان دیگری موکول شد." },
  { label: "سایر", icon: "••", defaultReport: "" },
] as const;

function TopSwitcher({ mode, setMode }: { mode: "employee" | "admin"; setMode: (m: "employee" | "admin") => void }) {
  return (
    <div className="prototype-bar" dir="rtl">
      <div className="brand-mini"><span className="brand-mark">ر</span><span><b>راهکار</b><small>مدیریت عملیات میدانی</small></span></div>
      <div className="mode-switch" role="tablist" aria-label="انتخاب پنل سامانه">
        <button role="tab" aria-selected={mode === "employee"} className={mode === "employee" ? "active" : ""} onClick={() => setMode("employee")}><Icon>▣</Icon> اپ کارمند</button>
        <button role="tab" aria-selected={mode === "admin"} className={mode === "admin" ? "active" : ""} onClick={() => setMode("admin")}><Icon>▥</Icon> پنل مدیر</button>
      </div>
      <span className="demo-pill"><i /> سامانه عملیاتی</span>
    </div>
  );
}

function EmployeeDailySummaryView({ summary, onOpenMission }: { summary: EmployeeDailySummary; onOpenMission?: (mission: ApiMission) => void }) {
  const hours = Math.floor(summary.activeMinutes / 60);
  const minutes = summary.activeMinutes % 60;
  return <div className="daily-summary-view">
    <div className="daily-summary-metrics"><span><small>کارکرد واقعی قابل‌تأیید</small><b>{hours.toLocaleString("fa-IR")} ساعت و {minutes.toLocaleString("fa-IR")} دقیقه</b></span><span><small>انجام‌شده واقعی</small><b>{summary.completed.filter(mission=>mission.result==="انجام شد").length.toLocaleString("fa-IR")}</b></span><span><small>باز / پیگیری مجدد</small><b>{summary.incomplete.length.toLocaleString("fa-IR")}</b></span></div>
    <section className="work-session-summary"><div className="summary-section-title"><span>◷</span><div><h3>ساعت ورود، خروج و کارکرد</h3><p>{summary.period === "daily" ? "کارکرد امروز" : summary.period === "weekly" ? "کارکرد ۷ روز اخیر" : "کارکرد ۳۰ روز اخیر"}</p></div></div><div className="shift-times"><span><small>اولین ورود</small><b>{formatPersianTime(summary.firstStartAt)}</b></span><span><small>آخرین خروج</small><b>{summary.lastEndAt ? formatPersianTime(summary.lastEndAt) : summary.sessions.some(session=>session.status==="active") ? "در حال فعالیت" : "—"}</b></span><span><small>کارکرد واقعی</small><b>{hours.toLocaleString("fa-IR")}:{minutes.toLocaleString("fa-IR",{minimumIntegerDigits:2,useGrouping:false})}</b></span></div><div className="work-policy-breakdown"><span><small>حداقل روزانه</small><b>۸ ساعت و ۳۰ دقیقه</b></span><span><small>اضافه‌کاری</small><b>{formatMinutes(summary.overtimeMinutes)}</b></span><span className={summary.unverifiedGpsMinutes?"danger":""}><small>بیش از مهلت ۳۰ دقیقه بدون GPS</small><b>{formatMinutes(summary.unverifiedGpsMinutes)}</b></span><span className={summary.pendingCorrectionMinutes?"pending":""}><small>خوداظهاری در انتظار</small><b>{formatMinutes(summary.pendingCorrectionMinutes)}</b></span></div>{summary.sessions.length > 0 && <div className="session-history">{summary.sessions.map(session=><div key={session.id}><span>{formatPersianDateTime(session.startedAt)}</span><b>{formatPersianTime(session.startedAt)} تا {session.endedAt ? formatPersianTime(session.endedAt) : "اکنون"}</b><small>{session.durationMinutes.toLocaleString("fa-IR")} دقیقه {session.workType==="overtime"?"· اضافه‌کاری":session.startSource==="self_reported"?`· خوداظهاری ${session.approvalStatus==="pending"?"در انتظار":""}`:""}</small>{session.endNote && <p><strong>{session.startSource==="self_reported"?"دلیل خوداظهاری":"توضیحات پایان فعالیت"}:</strong> {session.endNote}</p>}</div>)}</div>}</section>
    {summary.performance && <section className="employee-performance-card"><div className="summary-section-title"><span>▤</span><div><h3>تحلیل عملکرد من</h3><p>بر پایه اطلاعات واقعی ثبت‌شده</p></div></div><div className="employee-performance-grid"><span><small>زمان مأموریت</small><b>{formatMinutes(summary.performance.movement.onSiteMinutes)}</b></span><span><small>زمان در مسیر</small><b>{formatMinutes(summary.performance.movement.travelMinutes)}</b></span><span><small>زمان در حرکت</small><b>{formatMinutes(summary.performance.movement.movingMinutes)}</b></span><span><small>مسافت مأموریت‌ها</small><b>{summary.performance.movement.missionDistanceKm.toLocaleString("fa-IR")} کیلومتر</b></span><span><small>زمان دسته‌بندی‌نشده</small><b>{formatMinutes(summary.performance.movement.unclassifiedMinutes)}</b></span><span><small>نرخ تکمیل</small><b>{summary.performance.missions.completionRate.toLocaleString("fa-IR")}٪</b></span><span><small>انجام به‌موقع</small><b>{summary.performance.missions.onTimeRate.toLocaleString("fa-IR")}٪</b></span><span><small>کارهای نیازمند پیگیری</small><b>{summary.performance.missions.followUpCount.toLocaleString("fa-IR")}</b></span><span><small>وقفه GPS/اینترنت</small><b>{summary.performance.integrity.gpsGapMinutes.toLocaleString("fa-IR")} دقیقه</b></span><span><small>هزینه ثبت‌شده</small><b>{summary.performance.finance.total.toLocaleString("fa-IR")} تومان</b></span></div><p className="performance-policy">{summary.policy?.note}</p></section>}
    <section className="today-places"><div className="summary-section-title"><span>⌖</span><div><h3>مقصدها و حضور امروز</h3><p>بدون نمایش نقشه مسیر</p></div></div><div className="location-window"><span><small>اولین ثبت موقعیت</small><b>{formatPersianTime(summary.locationSummary.firstAt)}</b></span><span><small>آخرین ثبت موقعیت</small><b>{formatPersianTime(summary.locationSummary.lastAt)}</b></span><span><small>نقاط ثبت‌شده</small><b>{summary.locationSummary.pointCount.toLocaleString("fa-IR")}</b></span></div>{summary.destinations.length ? <div className="destination-chips">{summary.destinations.map(destination=><span key={destination}>⌖ {destination}</span>)}</div> : <p className="summary-empty">امروز هنوز مقصدی در گزارش مأموریت ثبت نشده است.</p>}</section>
    <section className="daily-mission-section"><div className="summary-section-title"><span>✓</span><div><h3>مراجعات و نتایج ثبت‌شده امروز</h3><p>هر نتیجه ثبت‌شده؛ چه انجام‌شده و چه نیازمند پیگیری</p></div></div>{summary.completed.length ? <div className="daily-mission-items">{summary.completed.map(mission=>{const content=<><span className={mission.result === "انجام شد" ? "summary-result success" : "summary-result warning"}>{mission.result === "انجام شد" ? "✓" : "◷"} {mission.result ?? "گزارش ثبت‌شده"}</span><b>{mission.title}</b><small>{mission.destinationName ?? "بدون مقصد"} · {formatPersianTime(mission.completedAt)}</small><p>{mission.report ?? "بدون توضیح"}</p></>;return onOpenMission?<button key={mission.id} onClick={()=>onOpenMission(mission)}>{content}<i>مشاهده کامل ←</i></button>:<div key={mission.id}>{content}</div>})}</div>:<p className="summary-empty">امروز هنوز نتیجه مأموریتی ثبت نشده است.</p>}</section>
    <section className="daily-mission-section incomplete"><div className="summary-section-title"><span>◷</span><div><h3>کارهای باز یا نیازمند پیگیری</h3><p>این موارد با پایان فعالیت حذف نمی‌شوند</p></div></div>{summary.incomplete.length ? <div className="daily-mission-items">{summary.incomplete.map(mission=><div key={mission.id}><span className="summary-result open">{mission.status === "in_progress" ? "در حال انجام" : mission.status === "revision" ? "نیازمند اصلاح" : ["follow_up","follow_up_pending"].includes(mission.status) ? "پیگیری مجدد" : "باز"}</span><b>{mission.title}</b><small>{mission.destinationName ?? "مقصد ثبت نشده"} · {mission.deadline ?? "بدون مهلت"}</small></div>)}</div>:<p className="summary-empty success-text">همه مأموریت‌های امروز تعیین‌تکلیف شده‌اند.</p>}</section>
  </div>;
}

function EmployeeApp() {
  const [signedIn, setSignedIn] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [needsPasswordChange, setNeedsPasswordChange] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [employeeDisplayName, setEmployeeDisplayName] = useState("کاربر");
  const [employeeNotificationEnabled,setEmployeeNotificationEnabled]=useState(true);
  const [notificationCounts,setNotificationCounts]=useState({unread:0,open:0});
  const [screen, setScreen] = useState<EmployeeScreen>(restoreEmployeeScreen);
  const [working, setWorking] = useState(false);
  const [workToggleBusy, setWorkToggleBusy] = useState(false);
  const [workSessionStartAt, setWorkSessionStartAt] = useState<string | null>(null);
  const [todayWorkMinutes, setTodayWorkMinutes] = useState(0);
  const [workMinutesSyncedAt, setWorkMinutesSyncedAt] = useState(() => Date.now());
  const [todayFirstStartAt, setTodayFirstStartAt] = useState<string | null>(null);
  const [todayLastEndAt, setTodayLastEndAt] = useState<string | null>(null);
  const [todayUnverifiedGpsMinutes, setTodayUnverifiedGpsMinutes] = useState(0);
  const [todayPendingCorrectionMinutes, setTodayPendingCorrectionMinutes] = useState(0);
  const [missedStartOpen, setMissedStartOpen] = useState(false);
  const [missedStartTime, setMissedStartTime] = useState("");
  const [missedStartReason, setMissedStartReason] = useState("");
  const [missedStartSaving, setMissedStartSaving] = useState(false);
  const [clockTick, setClockTick] = useState(() => Date.now());
  const [displayDayKey, setDisplayDayKey] = useState(() => currentTehranDayKey());
  const [missionTab, setMissionTab] = useState("open");
  const [workStep, setWorkStep] = useState(0);
  const [toast, setToast] = useState("");
  const [offline, setOffline] = useState(false);
  const [pendingSync, setPendingSync] = useState(0);
  const [gpsStatus, setGpsStatus] = useState<"idle" | "requesting" | "active" | "denied" | "error">("idle");
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [latestGps, setLatestGps] = useState<{ latitude:number; longitude:number; accuracy:number; recordedAt:string } | null>(null);
  const [destinationName, setDestinationName] = useState("");
  const [destinationSaving, setDestinationSaving] = useState(false);
  const [attachments, setAttachments] = useState<UiAttachment[]>([]);
  const [expenseEnabled, setExpenseEnabled] = useState(false);
  const [expenseAmount, setExpenseAmount] = useState("");
  const [workResult, setWorkResult] = useState("انجام شد");
  const [workReport, setWorkReport] = useState<string>(workResultOptions[0].defaultReport);
  const [followUpCategory, setFollowUpCategory] = useState("missing_documents");
  const [completionScore, setCompletionScore] = useState(12);
  const [completionPenalty, setCompletionPenalty] = useState(0);
  const [completionScoreNote, setCompletionScoreNote] = useState<string | null>(null);
  const [dailySummary, setDailySummary] = useState<EmployeeDailySummary | null>(null);
  const [summaryConfirmed, setSummaryConfirmed] = useState(false);
  const [endWorkNote, setEndWorkNote] = useState("");
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [reportPeriod, setReportPeriod] = useState<"daily" | "weekly" | "monthly">("daily");
  const [detailReturnScreen, setDetailReturnScreen] = useState<"missions" | "report">("missions");
  const lastGpsSentAt = useRef(0);
  const gpsProblemReported = useRef(false);
  const [missions, setMissions] = useState<UiMission[]>([]);
  const [selectedMission, setSelectedMission] = useState<UiMission>(emptyMission);
  const [newTitle, setNewTitle] = useState("");

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  useEffect(() => {
    persistNavigation("employee", screen);
  }, [screen]);

  const syncQueued = useCallback(async () => {
    const result = await flushOutbox();
    setPendingSync(result.remaining);
    if (result.sent > 0) {
      setToast(`${result.sent.toLocaleString("fa-IR")} مورد با سرور همگام شد`);
      window.setTimeout(() => setToast(""), 2600);
    }
  }, []);

  const loadEmployeeData = useCallback(async () => {
    const [missionData, workData, notificationData] = await Promise.all([
      api<{ missions: ApiMission[] }>("/api/missions"),
      api<ApiWorkState>("/api/work-sessions"),
      api<{unreadCount:number;openRequestCount:number}>("/api/notifications"),
    ]);
    setNotificationCounts({unread:notificationData.unreadCount,open:notificationData.openRequestCount});
    setWorking(Boolean(workData.current));
    syncNativeTracking(Boolean(workData.current));
    setWorkSessionStartAt(workData.current?.startedAt ?? null);
    setTodayWorkMinutes(workData.today.activeMinutes);
    setWorkMinutesSyncedAt(Date.now());
    setTodayFirstStartAt(workData.today.firstStartAt);
    setTodayLastEndAt(workData.today.lastEndAt);
    setTodayUnverifiedGpsMinutes(workData.today.unverifiedGpsMinutes);
    setTodayPendingCorrectionMinutes(workData.today.pendingCorrectionMinutes);
    if (workData.autoEnded) notify("۹ ساعت کار دارای GPS تکمیل شد و فعالیت به‌صورت سیستمی پایان یافت؛ برای اضافه‌کاری دوباره شروع فعالیت را بزنید");
    setMissions(missionData.missions.map((mission) => ({
      ...mission,
      meta: `${mission.destinationName ?? "مقصد هنگام انجام ثبت می‌شود"} · ${mission.deadline ?? "بدون مهلت"} · ثبت ${formatPersianDateTime(mission.createdAt)}`,
      type: mission.source === "employee" ? "خودم" : "مدیر",
      priority: mission.priority === "urgent" ? "فوری" : "عادی",
      backendStatus: mission.status,
      status: ["follow_up", "follow_up_pending"].includes(mission.status) ? "follow_up" : ["approved", "completed", "rejected"].includes(mission.status) ? "done" : ["in_progress", "revision"].includes(mission.status) ? "open" : mission.status,
    })));
  }, [notify]);

  const loadDailySummary = async (period: "daily" | "weekly" | "monthly" = reportPeriod) => {
    setSummaryLoading(true);
    try {
      const result = await api<{summary:EmployeeDailySummary}>(`/api/employee/daily-summary?period=${period}`);
      setDailySummary(result.summary);
      setReportPeriod(period);
      return result.summary;
    } finally { setSummaryLoading(false); }
  };

  useEffect(() => {
    if (!signedIn) return;
    const timer = window.setTimeout(() => loadEmployeeData().catch((error) => notify(error.message)), 0);
    return () => window.clearTimeout(timer);
  }, [signedIn, loadEmployeeData, notify]);

  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => setClockTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [working]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const nextDayKey = currentTehranDayKey();
      if (nextDayKey === displayDayKey) return;
      setDisplayDayKey(nextDayKey);
      setTodayWorkMinutes(0);
      setTodayUnverifiedGpsMinutes(0);
      setTodayPendingCorrectionMinutes(0);
      setTodayFirstStartAt(working ? new Date().toISOString() : null);
      setTodayLastEndAt(null);
      setWorkMinutesSyncedAt(Date.now());
      if (signedIn) loadEmployeeData().catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [displayDayKey, loadEmployeeData, signedIn, working]);

  useEffect(() => {
    if (!signedIn || !working) return;
    const timer = window.setInterval(() => loadEmployeeData().catch(() => undefined), 60_000);
    return () => window.clearInterval(timer);
  }, [signedIn, working, loadEmployeeData]);

  useEffect(() => {
    api<{user:{role:string;mustChangePassword:boolean;fullName:string;username:string;notificationEnabled:boolean}}>("/api/auth/me").then(({user})=>{
      if (user.role === "employee") { setSignedIn(true); setNeedsPasswordChange(user.mustChangePassword); setEmployeeDisplayName(user.fullName); setUsername(user.username); setEmployeeNotificationEnabled(user.notificationEnabled); }
    }).catch(()=>undefined);
  }, []);

  useEffect(() => {
    const updateConnection = () => {
      const isOffline = !navigator.onLine;
      setOffline(isOffline);
      getOutboxCount().then(setPendingSync).catch(() => undefined);
      if (!isOffline) syncQueued().catch(() => undefined);
    };
    const timer = window.setTimeout(updateConnection, 0);
    window.addEventListener("online", updateConnection);
    window.addEventListener("offline", updateConnection);
    return () => { window.clearTimeout(timer); window.removeEventListener("online", updateConnection); window.removeEventListener("offline", updateConnection); };
  }, [syncQueued]);

  useEffect(() => {
    if (!signedIn || !working) { const idleTimer = window.setTimeout(() => setGpsStatus("idle"), 0); return () => window.clearTimeout(idleTimer); }
    if (!navigator.geolocation) { const errorTimer = window.setTimeout(() => setGpsStatus("error"), 0); return () => window.clearTimeout(errorTimer); }
    const timer = window.setTimeout(() => setGpsStatus("requesting"), 0);
    const watchId = navigator.geolocation.watchPosition(async (position) => {
      setGpsStatus("active");
      setGpsAccuracy(Math.round(position.coords.accuracy));
      const recordedAt = new Date(position.timestamp).toISOString();
      setLatestGps({ latitude:position.coords.latitude, longitude:position.coords.longitude, accuracy:position.coords.accuracy, recordedAt });
      gpsProblemReported.current = false;
      if (isNativeAndroidApp()) return;
      if (Date.now() - lastGpsSentAt.current < 15_000) return;
      lastGpsSentAt.current = Date.now();
      const point = {
        clientEventId: createClientId(), latitude: position.coords.latitude, longitude: position.coords.longitude,
        accuracy: position.coords.accuracy, altitude: position.coords.altitude, speed: position.coords.speed,
        heading: position.coords.heading, recordedAt,
      };
      const result = await sendJsonOrQueue<{autoEnded:boolean;endedAt:string|null}>("/api/locations", "POST", { points: [point] }).catch(() => ({ queued: true as const, data: undefined }));
      if (result.queued) setPendingSync(await getOutboxCount().catch(() => 1));
      if (result.data?.autoEnded) {
        setWorking(false); setWorkSessionStartAt(null); setTodayLastEndAt(result.data.endedAt ?? new Date().toISOString());
        syncNativeTracking(false);
        notify("۹ ساعت کار دارای GPS تکمیل شد؛ پایان فعالیت به‌صورت خودکار ثبت شد. برای اضافه‌کاری دوباره شروع کنید");
        await loadEmployeeData().catch(() => undefined);
      }
    }, async (error) => {
      const denied = error.code === error.PERMISSION_DENIED;
      setGpsStatus(denied ? "denied" : "error");
      if (!gpsProblemReported.current) {
        gpsProblemReported.current = true;
        await sendJsonOrQueue("/api/integrity", "POST", { type: denied ? "gps_permission_denied" : "device_offline", details: { code: error.code, message: error.message }, occurredAt: new Date().toISOString() }).catch(() => undefined);
        setPendingSync(await getOutboxCount().catch(() => 0));
      }
    }, { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 });
    return () => { window.clearTimeout(timer); navigator.geolocation.clearWatch(watchId); };
  }, [signedIn, working, loadEmployeeData, notify]);

  const addMission = async (e: FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    try {
      await api("/api/missions", { method: "POST", body: JSON.stringify({ title: newTitle, priority: "normal" }) });
      setNewTitle("");
      await loadEmployeeData();
      setScreen("missions");
      notify("مأموریت جدید در سرور ثبت شد");
    } catch (error) { notify(error instanceof Error ? error.message : "ثبت مأموریت ناموفق بود"); }
  };

  const prepareMissionWork = (mission: UiMission) => {
    setSelectedMission(mission);
    setWorkResult("انجام شد");
    setWorkReport(workResultOptions[0].defaultReport);
    setFollowUpCategory("missing_documents");
    setAttachments([]);
    setExpenseEnabled(false);
    setExpenseAmount("");
    setCompletionScore(12);
    setCompletionPenalty(0);
    setCompletionScoreNote(null);
    setDestinationName(mission.destinationName?.trim() || mission.title);
    setScreen("work");
    setWorkStep(0);
  };

  const registerDestination = async () => {
    if (!working) return notify("برای ثبت مقصد، ابتدا فعالیت روزانه را شروع کنید");
    if (!latestGps || Date.now() - Date.parse(latestGps.recordedAt) > 2 * 60_000) return notify("موقعیت GPS تازه دریافت نشده؛ چند لحظه در فضای باز منتظر بمانید و دوباره بزنید");
    if (destinationName.trim().length < 2) return notify("نام یا آدرس مقصد را وارد کنید");
    setDestinationSaving(true);
    try {
      const result = await sendJsonOrQueue("/api/destinations", "POST", { missionId:String(selectedMission.id), destinationName:destinationName.trim(), ...latestGps });
      const updatedMission = { ...selectedMission, destinationName:destinationName.trim() };
      setSelectedMission(updatedMission);
      setMissions(current=>current.map(mission=>mission.id===selectedMission.id ? { ...mission, destinationName:destinationName.trim() } : mission));
      setWorkStep(1);
      if (result.queued) {
        setPendingSync(await getOutboxCount());
        notify("مقصد روی گوشی ذخیره شد و پس از اتصال روی نقشه مدیر پین می‌شود");
      } else notify("مقصد ثبت شد و با شماره روزانه روی نقشه مدیر قرار گرفت");
    } catch (error) { notify(error instanceof Error ? error.message : "ثبت مقصد ناموفق بود"); }
    finally { setDestinationSaving(false); }
  };

  const startMission = async (mission: UiMission) => {
    if (!working) return notify("برای شروع کار روی مأموریت، ابتدا فعالیت روزانه را شروع کنید");
    if (mission.backendStatus !== "in_progress" && (!latestGps || Date.now() - Date.parse(latestGps.recordedAt) > 2 * 60_000)) return notify("برای ثبت نقطه شروع، منتظر موقعیت تازه GPS بمانید و دوباره بزنید");
    try {
      const result = mission.backendStatus !== "in_progress"
        ? await api<{mission:{startedAt:string}}> (`/api/missions/${mission.id}/start`, { method:"POST", body:JSON.stringify({location:latestGps}) })
        : null;
      const startedMission = { ...mission, backendStatus:"in_progress", status:"open", startedAt: result?.mission.startedAt ?? mission.startedAt ?? new Date().toISOString(), completedAt:null };
      setMissions(current => current.map(item => item.id === mission.id ? startedMission : item));
      prepareMissionWork(startedMission);
      notify(mission.backendStatus === "in_progress" ? "ادامه مأموریت" : "مأموریت شروع شد و ویرایش آن قفل شد");
    } catch (error) { notify(error instanceof Error ? error.message : "شروع مأموریت ناموفق بود"); }
  };

  const reportMissionWithoutStart = (mission: UiMission) => {
    if (!working) return notify("برای ثبت مقصد و نتیجه، ابتدا فعالیت روزانه را شروع کنید");
    prepareMissionWork(mission);
    if (!mission.startedAt && mission.backendStatus !== "in_progress") {
      notify("هشدار: اگر این مأموریت را بدون ثبت «شروع کار» پایان دهید، ۳ امتیاز کسر می‌شود");
    }
  };

  const finishWork = async () => {
    if (!workResult || !workReport.trim()) return notify("انتخاب نتیجه و نوشتن توضیح الزامی است");
    if (!latestGps || Date.now() - Date.parse(latestGps.recordedAt) > 2 * 60_000) return notify("برای ثبت نقطه پایان، منتظر موقعیت تازه GPS بمانید و دوباره بزنید");
    try {
      const predictedPenalty = selectedMission.startedAt || selectedMission.backendStatus === "in_progress" ? 0 : 3;
      const result = await sendJsonOrQueue<{mission:{status:string;needsFollowUp:boolean;followUpRequestId?:string|null;scorePending:number;scoreConfirmed:number;scorePenalty:number;scoreNote:string|null;completedWithoutStart:boolean}}>(`/api/missions/${selectedMission.id}/complete`, "POST", { destinationName: destinationName.trim() || selectedMission.destinationName || "مقصد ثبت‌شده", result: workResult, report: workReport.trim(), expenseAmount: expenseEnabled ? parseExpenseAmount(expenseAmount) : 0, endLocation:latestGps, requestSupervisorAction:workResult !== "انجام شد", followUpCategory });
      const penalty = Number(result.data?.mission.scorePenalty ?? predictedPenalty);
      const score = Number(result.data?.mission.scorePending || result.data?.mission.scoreConfirmed || Math.max(0, 12 - penalty));
      const scoreNote = result.data?.mission.scoreNote ?? (penalty ? "۳ امتیاز کسر شد؛ شروع کار روی مأموریت ثبت نشده بود." : null);
      setCompletionPenalty(penalty);
      setCompletionScore(score);
      setCompletionScoreNote(scoreNote);
      setWorkStep(4);
      if (result.queued) {
        setPendingSync(await getOutboxCount());
        notify(penalty ? "گزارش ذخیره شد؛ به علت نزدن شروع کار، ۳ امتیاز کسر خواهد شد" : "گزارش روی گوشی ذخیره شد و پس از اتصال ارسال می‌شود");
      } else {
        await loadEmployeeData();
        notify(penalty ? "۳ امتیاز کسر شد؛ چون شروع کار روی این مأموریت ثبت نشده بود" : workResult !== "انجام شد" ? "نتیجه ثبت شد و مأموریت وارد پیگیری مجدد شد" : selectedMission.source === "employee" || selectedMission.type === "خودم" ? "گزارش برای تأیید سرپرست ارسال شد" : "مأموریت با موفقیت انجام شد");
      }
    } catch (error) { notify(error instanceof Error ? error.message : "ارسال گزارش ناموفق بود"); }
  };

  const uploadAttachments = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!selectedFiles.length) return;
    const validFiles = selectedFiles.filter(file => ["image/jpeg", "image/png", "application/pdf"].includes(file.type) && file.size > 0 && file.size <= 10 * 1024 * 1024);
    if (validFiles.length !== selectedFiles.length) notify("فایل‌های نامعتبر حذف شدند؛ فقط JPG، PNG یا PDF تا ۱۰ مگابایت مجاز است");
    const pendingFiles = validFiles.map(file => ({ file, item: { localId: createClientId(), name: file.name, state: "uploading" as const } }));
    setAttachments(current => [...current, ...pendingFiles.map(entry => entry.item)]);
    for (const entry of pendingFiles) {
      try {
        const result = await sendFileOrQueue<{attachment:{id:string}}>("/api/attachments", { missionId: String(selectedMission.id) }, entry.file);
        setAttachments(current => current.map(item => item.localId === entry.item.localId ? { ...item, state: result.queued ? "queued" : "uploaded", serverId: result.data?.attachment.id, queueId: result.queueId } : item));
      } catch {
        setAttachments(current => current.map(item => item.localId === entry.item.localId ? { ...item, state: "error" } : item));
      }
    }
    setPendingSync(await getOutboxCount().catch(() => 0));
    notify(validFiles.length > 1 ? `${validFiles.length.toLocaleString("fa-IR")} مدرک اضافه شد` : validFiles.length === 1 ? "مدرک اضافه شد" : "مدرک معتبری انتخاب نشد");
  };

  const removeAttachment = async (attachment: UiAttachment) => {
    if (attachment.state === "uploading") return notify("تا پایان بارگذاری این فایل صبر کنید");
    try {
      if (attachment.state === "queued" && attachment.queueId) await removeQueuedItem(attachment.queueId);
      if (attachment.state === "uploaded" && attachment.serverId) await api(`/api/attachments/${attachment.serverId}`, { method:"DELETE" });
      setAttachments(current => current.filter(item => item.localId !== attachment.localId));
      setPendingSync(await getOutboxCount().catch(() => 0));
      notify("مدرک حذف شد");
    } catch (error) { notify(error instanceof Error ? error.message : "حذف مدرک ناموفق بود"); }
  };

  const signIn = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const result = await api<{ user: { role: string; mustChangePassword: boolean; fullName: string; username:string;notificationEnabled:boolean } }>("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
      if (result.user.role !== "employee") throw new Error("این حساب برای پنل کارمند نیست.");
      setSignedIn(true);
      setNeedsPasswordChange(result.user.mustChangePassword);
      setEmployeeDisplayName(result.user.fullName);
      setUsername(result.user.username);
      setEmployeeNotificationEnabled(result.user.notificationEnabled);
      setPassword("");
      setScreen("home");
      setLoginError("");
    } catch (error) { setLoginError(error instanceof Error ? error.message : "ورود ناموفق بود"); }
  };

  const openMissionDetail = (mission: UiMission | ApiMission, returnScreen: "missions" | "report" = "missions") => {
    setSelectedMission(mission as UiMission);
    setDetailReturnScreen(returnScreen);
    setScreen("mission-detail");
  };

  const openMyReport = async () => {
    setScreen("report");
    await loadDailySummary().catch(error => notify(error instanceof Error ? error.message : "دریافت گزارش امروز ناموفق بود"));
  };

  const openEndReview = async () => {
    setSummaryConfirmed(false);
    setEndWorkNote("");
    setScreen("end-review");
    await loadDailySummary("daily").catch(error => { setScreen("home"); notify(error instanceof Error ? error.message : "دریافت گزارش پایان کار ناموفق بود"); });
  };

  const captureFreshGps = async () => {
    if (latestGps && Date.now() - Date.parse(latestGps.recordedAt) <= 60_000 && latestGps.accuracy <= 100) return latestGps;
    if (!navigator.geolocation) throw new Error("GPS در این دستگاه در دسترس نیست");
    if (!window.isSecureContext) throw new Error("برای دریافت GPS باید سامانه با اتصال امن HTTPS باز شود");
    setGpsStatus("requesting");
    return await new Promise<{latitude:number;longitude:number;accuracy:number;recordedAt:string}>((resolve, reject) => {
      let settled = false;
      let bestAccuracy: number | null = null;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(waitTimer);
        navigator.geolocation.clearWatch(watchId);
        action();
      };
      const watchId = navigator.geolocation.watchPosition(position => {
        const location = { latitude:position.coords.latitude, longitude:position.coords.longitude, accuracy:position.coords.accuracy, recordedAt:new Date(position.timestamp).toISOString() };
        bestAccuracy = bestAccuracy === null ? location.accuracy : Math.min(bestAccuracy, location.accuracy);
        setGpsAccuracy(Math.round(bestAccuracy));
        if (location.accuracy > 100) return;
        setLatestGps(location); setGpsStatus("active");
        finish(() => resolve(location));
      }, error => {
        if (error.code !== error.PERMISSION_DENIED) return;
        setGpsStatus("denied");
        finish(() => reject(new Error("مجوز GPS مسدود است؛ دسترسی Location را روی Allow و Precise قرار دهید")));
      }, { enableHighAccuracy:true, maximumAge:30_000, timeout:45_000 });
      const waitTimer = window.setTimeout(() => {
        setGpsStatus("error");
        finish(() => reject(new Error(bestAccuracy !== null
          ? `بهترین دقت GPS ${Math.round(bestAccuracy).toLocaleString("fa-IR")} متر بود؛ برای شروع باید دقت به ۱۰۰ متر یا کمتر برسد`
          : "تا ۴۵ ثانیه موقعیت GPS دریافت نشد؛ Location و حالت دقت بالا را بررسی کنید")));
      }, 46_000);
    });
  };

  const toggleWork = async () => {
    if (working) return openEndReview();
    if (workToggleBusy) return;
    setWorkToggleBusy(true);
    try {
      const location = await captureFreshGps();
      const result = await sendJsonOrQueue<{session:{startedAt:string;workType?:string}}>("/api/work-sessions", "POST", { action: "start", location });
      const startedAt = result.data?.session.startedAt ?? new Date().toISOString();
      setWorking(true); setWorkSessionStartAt(startedAt); setTodayFirstStartAt(current=>current ?? startedAt); setTodayLastEndAt(null); setClockTick(Date.now()); setWorkMinutesSyncedAt(Date.now());
      syncNativeTracking(true);
      setPendingSync(await getOutboxCount().catch(() => 0));
      notify(result.queued ? "شروع فعالیت همراه GPS روی گوشی ذخیره شد" : result.data?.session.workType === "overtime" ? "اضافه‌کاری و ثبت GPS آغاز شد" : "فعالیت و ثبت GPS آغاز شد");
    } catch (error) { notify(error instanceof Error ? error.message : "عملیات ناموفق بود"); }
    finally { setWorkToggleBusy(false); }
  };

  const submitMissedStart = async (event: FormEvent) => {
    event.preventDefault();
    if (!missedStartTime) return notify("ساعت شروع فراموش‌شده را انتخاب کنید");
    if (missedStartReason.trim().length < 10) return notify("دلیل خوداظهاری را کامل‌تر بنویسید");
    setMissedStartSaving(true);
    try {
      const location = await captureFreshGps();
      const result = await api<{correction:{claimedMinutes:number;scorePenalty:number};session:{startedAt:string;workType:string}}>("/api/work-sessions", { method:"POST", body:JSON.stringify({ action:"self_report_start", startTime:missedStartTime, reason:missedStartReason.trim(), location }) });
      setWorking(true); setWorkSessionStartAt(result.session.startedAt); setWorkMinutesSyncedAt(Date.now()); setTodayFirstStartAt(current=>current ?? result.session.startedAt); setTodayLastEndAt(null);
      syncNativeTracking(true);
      setMissedStartOpen(false); setMissedStartTime(""); setMissedStartReason("");
      await loadEmployeeData();
      notify(`${result.correction.claimedMinutes.toLocaleString("fa-IR")} دقیقه خوداظهاری با کسر ${result.correction.scorePenalty.toLocaleString("fa-IR")} امتیاز، در انتظار تأیید سرپرست ثبت شد`);
    } catch (error) { notify(error instanceof Error ? error.message : "ثبت خوداظهاری ناموفق بود"); }
    finally { setMissedStartSaving(false); }
  };

  const confirmEndWork = async () => {
    if (!dailySummary || !summaryConfirmed) return notify("ابتدا تأیید کنید که فهرست فعالیت‌های امروز را بررسی کرده‌اید");
    if (endWorkNote.trim().length < 3) return notify("ثبت توضیحات پایان فعالیت الزامی است");
    try {
      const endTime = new Date().toISOString();
      const location = latestGps && Date.now() - Date.parse(latestGps.recordedAt) <= 2 * 60_000 && latestGps.accuracy <= 100 ? latestGps : null;
      const result = await sendJsonOrQueue<{session:{endedAt:string};today?:{activeMinutes:number;unverifiedGpsMinutes:number};gpsWarning?:boolean;deductedMinutes?:number}>("/api/work-sessions", "POST", { action:"end", endTime, confirmDailySummary:true, confirmedMissionIds:dailySummary.confirmationMissionIds, endNote:endWorkNote.trim(), location });
      setWorking(false); setWorkSessionStartAt(null); setTodayLastEndAt(result.data?.session.endedAt ?? endTime); setTodayWorkMinutes(result.data?.today?.activeMinutes ?? dailySummary.activeMinutes); setTodayUnverifiedGpsMinutes(result.data?.today?.unverifiedGpsMinutes ?? dailySummary.unverifiedGpsMinutes); setWorkMinutesSyncedAt(Date.now()); setSummaryConfirmed(false); setEndWorkNote(""); setScreen("home");
      syncNativeTracking(false);
      setPendingSync(await getOutboxCount());
      if (!result.queued) await loadEmployeeData();
      notify(result.queued ? "زمان پایان فعالیت روی گوشی ذخیره شد و پس از اتصال همگام می‌شود" : result.data?.gpsWarning ? "فعالیت پایان یافت؛ موقعیت پایان در دسترس نبود و برای بررسی ثبت شد" : "گزارش امروز تأیید و فعالیت پایان یافت");
    } catch (error) {
      if (error instanceof Error && error.message.includes("تغییر کرده")) await loadDailySummary().catch(() => undefined);
      notify(error instanceof Error ? error.message : "پایان فعالیت ناموفق بود");
    }
  };

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmNewPassword) { setLoginError("تکرار رمز جدید یکسان نیست."); return; }
    try {
      await api("/api/auth/change-password", {method:"POST",body:JSON.stringify({newPassword,confirmPassword:confirmNewPassword})});
      setNeedsPasswordChange(false);setNewPassword("");setConfirmNewPassword("");setLoginError("");notify("رمز شما با موفقیت تغییر کرد و ورود شما حفظ شد");
    } catch (error) { setLoginError(error instanceof Error ? error.message : "تغییر رمز ناموفق بود"); }
  };

  if (!signedIn) {
    return (
      <main className="employee-stage login-stage" dir="rtl">
        <div className="employee-context context-right login-context">
          <span className="eyebrow">ورود امن کارمند</span>
          <h2>دسترسی را مدیر می‌سازد؛ کارمند فقط وارد می‌شود</h2>
          <p>نام کاربری و رمز موقت توسط مدیر تحویل می‌شود. در نسخه نهایی، کارمند هنگام اولین ورود رمز خود را تغییر می‌دهد.</p>
        </div>
        <section className="phone-shell login-shell" aria-label="ورود کارمند">
          <div className="phone-status"><span>۹:۴۱</span><span className="phone-island" /><span>▂ ▅ ◉</span></div>
          <div className="login-screen">
            <div className="login-brand"><span className="brand-mark">ر</span><b>راهکار</b><small>مدیریت عملیات میدانی</small></div>
            <div className="login-copy"><h1>ورود به پنل کارمند</h1><p>اطلاعاتی که مدیر برای شما ساخته است وارد کنید.</p></div>
            <form onSubmit={signIn}>
              <label>نام کاربری<input aria-label="نام کاربری" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" /></label>
              <label>رمز عبور<input aria-label="رمز عبور" value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" /></label>
              <div className="login-options"><label><input type="checkbox" defaultChecked /> مرا به خاطر بسپار</label><button type="button">رمز را فراموش کرده‌ام</button></div>
              {loginError && <div className="login-error" role="alert">! {loginError}</div>}
              <button className="primary-wide" type="submit">ورود به پنل</button>
            </form>
            <p className="login-help">برای دریافت دسترسی با سرپرست خود تماس بگیرید.</p>
          </div>
        </section>
        <div className="employee-context context-left login-context"><span className="eyebrow">قاعده دسترسی</span><div className="access-rules"><span><i>۱</i>ساخت حساب توسط مدیر</span><span><i>۲</i>تحویل رمز موقت</span><span><i>۳</i>ورود و تغییر رمز</span></div></div>
      </main>
    );
  }

  if (needsPasswordChange) return <main className="employee-stage login-stage" dir="rtl"><section className="phone-shell login-shell"><div className="phone-status"><span>۹:۴۱</span><span className="phone-island" /><span>▂ ▅ ◉</span></div><div className="login-screen"><div className="login-brand"><span className="brand-mark">ر</span><b>راهکار</b><small>امنیت حساب</small></div><div className="login-copy"><h1>رمز موقت را تغییر دهید</h1><p>برای ادامه، یک رمز شخصی و جدید انتخاب کنید.</p></div><form onSubmit={changePassword}><label>رمز جدید<input type="password" value={newPassword} onChange={e=>setNewPassword(e.target.value)} autoComplete="new-password" placeholder="حداقل ۱۰ کاراکتر، شامل حرف و عدد" /></label><label>تکرار رمز جدید<input type="password" value={confirmNewPassword} onChange={e=>setConfirmNewPassword(e.target.value)} autoComplete="new-password" placeholder="رمز جدید را دوباره وارد کنید" /></label>{loginError&&<div className="login-error">! {loginError}</div>}<button className="primary-wide" type="submit">ثبت رمز جدید و ادامه</button></form><div className="security-note"><Icon>◇</Icon><p><b>رمز در پایگاه داده به‌صورت هش‌شده ذخیره می‌شود</b><small>مدیر بعداً رمز شخصی شما را نمی‌بیند.</small></p></div></div></section></main>;

  return (
    <main className="employee-stage" dir="rtl">
      <div className="employee-context context-right">
        <span className="eyebrow">اپ میدانی</span>
        <h2>سریع، روشن و بدون حواس‌پرتی</h2>
        <p>کارمند فقط عملیات روزمره را می‌بیند. مسیر و سابقه مکان روی نقشه فقط برای مدیر قابل مشاهده است.</p>
        <div className="context-note"><Icon>⌖</Icon><span><b>حریم تجربه کارمند</b><small>نقشه مسیر در اپ نمایش داده نمی‌شود</small></span></div>
      </div>

      <section className="phone-shell" aria-label="نمونه اپلیکیشن کارمند">
        <div className="phone-status"><span>۹:۴۱</span><span className="phone-island" /><span>▂ ▅ ◉</span></div>
        <header className="app-header">
          <button className="avatar small" onClick={() => setScreen("profile")} aria-label="پروفایل">{employeeDisplayName.slice(0,2)}</button>
          <div><small>{currentPersianDate()}</small><h1>{screen === "home" ? `سلام ${employeeDisplayName.split(" ")[0]}، روز بخیر` : screen === "missions" ? "مأموریت‌های من" : screen === "new" ? "مأموریت جدید" : screen === "work" ? "ثبت کار میدانی" : screen === "report" ? "گزارش امروز من" : screen === "mission-detail" ? "جزئیات مأموریت" : screen === "end-review" ? "تأیید پایان کار" : screen === "notifications" ? "اعلان‌ها و درخواست‌های باز" : screen === "notification-settings" ? "تنظیمات اعلان‌ها" : screen === "account-settings" ? "حساب و امنیت" : "حساب کاربری"}</h1></div>
          <button className="notification" onClick={() => setScreen("notifications")} aria-label={`اعلان‌ها؛ ${notificationCounts.unread.toLocaleString("fa-IR")} خوانده‌نشده`}>♧{notificationCounts.unread>0&&<i/>}{notificationCounts.open>0&&<b>{notificationCounts.open.toLocaleString("fa-IR")}</b>}</button>
        </header>

        <div className="app-content">
          {screen === "home" && (
            <>
              {(offline || pendingSync > 0) && <div className="offline-banner"><Icon>⌁</Icon><span><b>{offline ? "اتصال اینترنت قطع است" : "در حال همگام‌سازی"}</b><small>{pendingSync.toLocaleString("fa-IR")} تغییر روی دستگاه در انتظار ارسال است</small></span><button onClick={() => syncQueued().catch(() => notify("همگام‌سازی هنوز ممکن نیست"))}>تلاش مجدد</button></div>}
              <div className="connection-row">
                <span className={gpsStatus === "active" ? "good" : gpsStatus === "denied" || gpsStatus === "error" ? "bad" : "soft"}><Icon>⌖</Icon>{gpsStatus === "active" ? `GPS · دقت ${gpsAccuracy ?? "—"} متر` : gpsStatus === "requesting" ? "در حال دریافت GPS" : gpsStatus === "denied" ? "GPS مسدود" : gpsStatus === "error" ? "خطای GPS" : "GPS آماده"}</span>
                <span className={offline ? "bad" : "good"}><Icon>{offline ? "○" : "●"}</Icon>{offline ? "آفلاین" : "آنلاین"}</span>
                <span className={pendingSync ? "bad" : "soft"}><Icon>↻</Icon>{pendingSync ? `${pendingSync.toLocaleString("fa-IR")} در انتظار` : "همگام"}</span>
              </div>
              <section className={`work-card ${working ? "active" : ""}`}>
                <div className="work-card-top"><span className="live-dot"><i />{working ? gpsStatus === "active" ? "فعالیت و GPS در حال ثبت" : "فعالیت در حال ثبت" : "آماده شروع"}</span><button onClick={() => syncQueued().catch(() => undefined)}>↻</button></div>
                <div className="timer">{formatDurationSeconds(todayWorkMinutes*60+(working?Math.max(0,(clockTick-workMinutesSyncedAt)/1000):0))}</div>
                <p>{working ? `شروع این نوبت، ${formatPersianTime(workSessionStartAt)} · کارکرد واقعی امروز` : todayLastEndAt ? `ورود ${formatPersianTime(todayFirstStartAt)} · خروج ${formatPersianTime(todayLastEndAt)} · کارکرد واقعی امروز` : "حداقل روزانه ۸:۳۰ · اضافه‌کاری فقط پس از ۹:۰۰"}</p>
                <button className={`work-toggle ${working ? "stop" : "start"}`} onClick={toggleWork} disabled={workToggleBusy}><span>{working ? "■" : workToggleBusy ? "⌖" : "▶"}</span>{working ? "پایان فعالیت" : workToggleBusy ? "در حال دریافت موقعیت دقیق..." : "شروع فعالیت"}</button>
              </section>
              {!working&&<button className="missed-start-trigger" onClick={()=>setMissedStartOpen(current=>!current)}>◷ شروع فعالیت را فراموش کرده‌ام</button>}
              {!working&&missedStartOpen&&<form className="missed-start-form" onSubmit={submitMissedStart}><div><b>خوداظهاری شروع ثبت‌نشده</b><small>ساعت فقط برای امروز ثبت می‌شود، ۳ امتیاز کسر می‌گردد و تأیید سرپرست لازم است.</small></div><label>ساعت شروع واقعی<input type="time" value={missedStartTime} onChange={event=>setMissedStartTime(event.target.value)} required /></label><label>علت فراموشی<textarea value={missedStartReason} onChange={event=>setMissedStartReason(event.target.value)} maxLength={500} rows={3} placeholder="علت ثبت‌نشدن شروع فعالیت را کامل بنویسید..." required /></label><button className="primary-wide" type="submit" disabled={missedStartSaving}>{missedStartSaving?"در حال ثبت...":"ثبت خوداظهاری و شروع فعالیت فعلی"}</button></form>}
              {(todayUnverifiedGpsMinutes>0||todayPendingCorrectionMinutes>0)&&<div className="work-integrity-summary">{todayUnverifiedGpsMinutes>0&&<span>⌖ {todayUnverifiedGpsMinutes.toLocaleString("fa-IR")} دقیقه اضافه بر مهلت ۳۰ دقیقه بدون GPS و خارج از کارکرد واقعی</span>}{todayPendingCorrectionMinutes>0&&<span>◷ {todayPendingCorrectionMinutes.toLocaleString("fa-IR")} دقیقه خوداظهاری در انتظار تأیید</span>}</div>}

              <div className="section-title"><div><h3>نمای امروز</h3><p>خلاصه عملکرد تا این لحظه</p></div></div>
              <div className="metric-grid">
                <div><span className="metric-icon blue">✓</span><b>{missions.filter(m=>m.status==="done").length.toLocaleString("fa-IR")}</b><small>انجام‌شده</small></div>
                <div><span className="metric-icon amber">◷</span><b>{missions.filter(m=>m.status==="pending").length.toLocaleString("fa-IR")}</b><small>منتظر تأیید</small></div>
                <div><span className="metric-icon violet">◆</span><b>{missions.reduce((sum,m)=>sum+Number(m.scoreConfirmed??0),0).toLocaleString("fa-IR")}</b><small>امتیاز قطعی</small></div>
              </div>
              <div className="pending-score"><Icon>◈</Icon><div><b>{missions.reduce((sum,m)=>sum+Number(m.scorePending??0),0).toLocaleString("fa-IR")} امتیاز در انتظار تأیید</b><small>پس از تأیید سرپرست به امتیاز قطعی افزوده می‌شود</small></div><span>Pending</span></div>

              <div className="section-title spaced"><div><h3>مأموریت بعدی</h3><p>اولویت امروز</p></div><button onClick={() => {setScreen("missions"); setMissionTab("open");}}>همه مأموریت‌ها ←</button></div>
              <div className="next-mission" role="button" onClick={() => {const mission=missions.find(m => ["open","follow_up"].includes(m.status) && m.backendStatus!=="follow_up_pending") ?? missions[0];if(mission)openMissionDetail(mission)}} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); const mission=missions.find(m => ["open","follow_up"].includes(m.status) && m.backendStatus!=="follow_up_pending") ?? missions[0];if(mission)openMissionDetail(mission); } }} tabIndex={0}>
                <div className="mission-accent" />
                <div className="mission-head"><span className="priority">{missions.find(m=>["open","follow_up"].includes(m.status) && m.backendStatus!=="follow_up_pending")?.priority ?? "عادی"}</span><span className="source">{missions.find(m=>["open","follow_up"].includes(m.status) && m.backendStatus!=="follow_up_pending")?.type === "خودم" ? "ایجادشده توسط من" : "توسط مدیر"}</span></div>
                <h3>{missions.find(m=>["open","follow_up"].includes(m.status) && m.backendStatus!=="follow_up_pending")?.title ?? "مأموریت بازی وجود ندارد"}</h3>
                <p><Icon>⌖</Icon> {missions.find(m=>["open","follow_up"].includes(m.status) && m.backendStatus!=="follow_up_pending")?.destinationName ?? "مقصد هنگام انجام ثبت می‌شود"}</p>
                <div className="mission-foot"><span><Icon>◷</Icon> {missions.find(m=>["open","follow_up"].includes(m.status) && m.backendStatus!=="follow_up_pending")?.deadline ?? "بدون مهلت"}</span><button onClick={(event)=>{event.stopPropagation();setScreen("missions")}}>ثبت مقصد</button></div>
              </div>
            </>
          )}

          {screen === "missions" && (
            <>
              <div className="mission-tabs">
                {[{id:"open",label:"باز"},{id:"follow_up",label:"پیگیری مجدد"},{id:"pending",label:"منتظر تأیید"},{id:"done",label:"انجام‌شده"}].map(t => <button key={t.id} className={missionTab === t.id ? "active" : ""} onClick={() => setMissionTab(t.id)}>{t.label}<span>{missions.filter(m=>m.status===t.id).length}</span></button>)}
              </div>
              <div className="mission-list">
                {missions.filter(m => m.status === missionTab).map(m => (
                  <div className="mission-list-card" role="button" key={m.id} onClick={() => openMissionDetail(m)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openMissionDetail(m); } }} tabIndex={0}>
                    <div className="list-card-top"><span className={m.priority === "فوری" ? "priority" : "normal"}>{m.priority}</span><span className="source">{m.type === "خودم" ? "ایجادشده توسط من" : "توسط مدیر"}</span></div>
                    <h3>{m.title}</h3><p><Icon>◷</Icon>{m.meta}{Number(m.attemptCount ?? 0) > 0 ? ` · مراجعه ${Number(m.attemptCount).toLocaleString("fa-IR")}` : ""}</p>{["open","follow_up"].includes(m.status) && <small className="mission-description-preview">{m.description?.trim() || "برای دیدن شرح کامل این مأموریت روی کارت بزنید."}</small>}
                    {m.status === "pending" ? <div className="approval-strip"><Icon>◌</Icon><span><b>{m.result ?? "در انتظار بررسی سرپرست"}</b><small>مشاهده گزارش ثبت‌شده ←</small></span></div> : m.status === "follow_up" ? <div className="follow-up-strip"><Icon>↻</Icon><span><b>{m.result ?? "نیازمند مراجعه و پیگیری دوباره"}</b><small>{m.backendStatus === "follow_up_pending" ? "گزارش قبلی در انتظار بررسی سرپرست است" : "مشاهده سابقه و شروع پیگیری بعدی ←"}</small></span></div> : m.status === "done" ? <div className={`done-strip ${m.result && m.result !== "انجام شد" ? "not-completed" : ""}`}>{m.result === "انجام شد" ? "✓" : "◷"} {m.result ?? "گزارش ثبت‌شده"} <b>مشاهده جزئیات ←</b></div> : <button className="card-arrow" aria-label="مشاهده شرح وظیفه">{m.backendStatus === "in_progress" ? "مشاهده و ادامه" : "مشاهده شرح وظیفه"} ←</button>}
                  </div>
                ))}
              </div>
              <button className="fab" onClick={() => setScreen("new")}><Icon>＋</Icon> ثبت مأموریت جدید</button>
            </>
          )}

          {screen === "new" && (
            <form className="mobile-form" onSubmit={addMission}>
              <button type="button" className="back-link" onClick={() => setScreen("missions")}>→ بازگشت</button>
              <div className="form-intro"><span>＋</span><h2>چه کاری باید انجام شود؟</h2><p>می‌توانید بلافاصله مأموریت خودساخته را شروع کنید.</p></div>
              <label>عنوان مأموریت <b>*</b><input value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="مثلاً: پیگیری بیمه خودرو" required /></label>
              <label>توضیحات <small>اختیاری</small><textarea placeholder="جزئیات لازم برای انجام کار..." /></label>
              <div className="two-fields"><label>اولویت<select><option>عادی</option><option>فوری</option><option>کم</option></select></label><label>مهلت <small>اختیاری</small><input type="text" placeholder="انتخاب تاریخ" /></label></div>
              <div className="field-label">دسته‌بندی <small>اختیاری</small><div className="chips"><button type="button" className="selected">اداری</button><button type="button">مالی</button><button type="button">تحویل</button><button type="button">سایر</button></div></div>
              <div className="info-box"><Icon>i</Icon><p>این مأموریت نیاز به تأیید اولیه ندارد؛ پس از انجام برای سرپرست ارسال می‌شود.</p></div>
              <button className="primary-wide" type="submit">ثبت و ادامه</button>
            </form>
          )}

          {screen === "work" && (
            <div className="work-flow">
              <button className="back-link" onClick={() => setScreen("missions")}>→ مأموریت‌ها</button>
              <div className="stepper">{[0,1,2,3].map((s) => <span key={s} className={workStep >= s ? "active" : ""}><i>{workStep > s ? "✓" : s + 1}</i></span>)}</div>
              {workStep === 0 && <section className="flow-panel">
                <span className="flow-icon">⌖</span><h2>ثبت مقصد</h2><p>موقعیت واقعی دستگاه جداگانه و امن ثبت می‌شود.</p>
                {!working && <div className="mission-start-lock"><Icon>▣</Icon><span><b>فعالیت روزانه شروع نشده است</b><small>برای ثبت مقصد و شروع این مأموریت، ابتدا از صفحه خانه «شروع فعالیت» را بزنید.</small></span></div>}
                {!selectedMission.startedAt && selectedMission.backendStatus !== "in_progress" && <div className="mission-score-warning"><Icon>!</Icon><span><b>شروع کار این مأموریت ثبت نشده است</b><small>می‌توانید گزارش را ثبت کنید؛ اما هنگام پایان مأموریت ۳ امتیاز به‌صورت خودکار کسر می‌شود.</small></span></div>}
                <div className={`location-option selected ${latestGps ? "gps-ready" : "gps-waiting"}`}><Icon>◎</Icon><span><b>{latestGps ? "موقعیت فعلی آماده ثبت است" : "در انتظار موقعیت فعلی"}</b><small>{latestGps ? `دقت ${Math.round(latestGps.accuracy).toLocaleString("fa-IR")} متر · ${formatPersianTime(latestGps.recordedAt)}` : "GPS گوشی باید روشن و مجاز باشد"}</small></span><i>{latestGps ? "✓" : "…"}</i></div>
                <label>نام یا آدرس مقصد <b>*</b><input value={destinationName} onChange={event=>setDestinationName(event.target.value)} placeholder="مثلاً: بانک رفاه، خیابان مرکزی" required /></label>
                <div className="employee-map-privacy"><Icon>▣</Icon><span><b>نقشه فقط در پنل مدیر نمایش داده می‌شود</b><small>با ثبت این مقصد، یک پین شماره‌دار برای مأموریت امروز ساخته می‌شود.</small></span></div>
                <button className="primary-wide" disabled={!working || destinationSaving} onClick={registerDestination}>{destinationSaving ? "در حال ثبت مقصد..." : "ثبت مقصد و ادامه"}</button>
              </section>}
              {workStep === 1 && <section className="flow-panel">
                <span className="flow-icon">✓</span><h2>نتیجه کار چه بود؟</h2><p>یکی از گزینه‌ها را برای ثبت گزارش انتخاب کنید.</p>
                <div className="result-grid">{workResultOptions.map((option) => <button type="button" aria-pressed={workResult === option.label} className={workResult === option.label ? "selected" : ""} key={option.label} onClick={()=>{setWorkResult(option.label);setWorkReport(option.defaultReport)}}><Icon>{option.icon}</Icon>{option.label}</button>)}</div>
                <label>توضیح نتیجه <b>*</b><textarea value={workReport} onChange={event=>setWorkReport(event.target.value)} placeholder={workResult === "سایر" ? "نتیجه کار را کامل توضیح دهید..." : "جزئیات نتیجه را بنویسید..."} required /></label>
                {workResult !== "انجام شد" && <div className="compact-follow-up-field"><label htmlFor="follow-up-category"><b>علت پیگیری</b><small>همین توضیح بالا خودکار برای سرپرست ارسال می‌شود.</small></label><select id="follow-up-category" value={followUpCategory} onChange={event=>setFollowUpCategory(event.target.value)}><option value="missing_documents">کسری مدارک</option><option value="coordination">تأیید یا هماهنگی</option><option value="payment">پرداخت</option><option value="administrative">اقدام اداری</option><option value="other">سایر</option></select></div>}
                <button className="primary-wide" onClick={() => workReport.trim() ? setWorkStep(2) : notify("توضیح نتیجه را وارد کنید")}>ادامه</button>
              </section>}
              {workStep === 2 && <section className="flow-panel">
                <span className="flow-icon">⊕</span><h2>مدارک و هزینه</h2><p>افزودن ضمیمه اختیاری است اما به اعتبار گزارش کمک می‌کند.</p>
                <label className="upload-box" htmlFor="mission-attachment"><Icon>＋</Icon><b>{attachments.some(item=>item.state==="uploading") ? "در حال بارگذاری مدارک..." : "افزودن چند عکس، رسید یا فایل"}</b><small>انتخاب هم‌زمان چند فایل · JPG، PNG یا PDF تا ۱۰ مگابایت برای هر فایل</small><input id="mission-attachment" className="file-input-hidden" type="file" multiple accept="image/jpeg,image/png,application/pdf" onChange={uploadAttachments} /></label>
                {attachments.length > 0 && <div className="receipt-list">{attachments.map(attachment=><div className={`receipt ${attachment.state}`} key={attachment.localId}><span>▧</span><div><b>{attachment.name}</b><small>{attachment.state === "queued" ? "ذخیره روی گوشی · در انتظار همگام‌سازی" : attachment.state === "uploaded" ? "بارگذاری‌شده و ثبت در سرور" : attachment.state === "error" ? "بارگذاری ناموفق · حذف و دوباره انتخاب کنید" : "در حال بارگذاری..."}</small></div><button type="button" aria-label={`حذف ${attachment.name}`} onClick={()=>removeAttachment(attachment)}>×</button></div>)}</div>}
                <div className="toggle-label"><span><b>ثبت هزینه انجام‌شده بابت این مأموریت</b><small>در صورت وجود هزینه، این گزینه را فعال کنید</small></span><input id="mission-expense" aria-label="ثبت هزینه انجام‌شده بابت این مأموریت" type="checkbox" checked={expenseEnabled} onChange={event=>{setExpenseEnabled(event.target.checked);if(!event.target.checked)setExpenseAmount("")}} /></div>
                {expenseEnabled && <div className="cost-field"><label>مبلغ هزینه <b>*</b><input value={expenseAmount} onChange={event=>setExpenseAmount(event.target.value)} inputMode="numeric" placeholder="مثلاً ۲۵۰٬۰۰۰" /></label><span>تومان</span></div>}
                <button className="primary-wide" onClick={() => expenseEnabled && parseExpenseAmount(expenseAmount) <= 0 ? notify("مبلغ هزینه را وارد کنید") : setWorkStep(3)}>مرور نهایی</button>
              </section>}
              {workStep === 3 && <section className="flow-panel review-panel">
                <span className="flow-icon">◈</span><h2>مرور و ارسال گزارش</h2><p>اطلاعات زیر برای سرپرست ارسال خواهد شد.</p>
                <div className="review-card"><span>مأموریت</span><b>{selectedMission?.title}</b><span>مقصد</span><b>{selectedMission?.destinationName ?? "مقصد ثبت‌شده"}</b><span>نتیجه</span><b className={workResult === "انجام شد" ? "green" : "amber"}>{workResult === "انجام شد" ? "✓" : "◷"} {workResult}</b><span>توضیحات</span><b>{workReport}</b><span>مدارک</span><b>{attachments.length ? `${attachments.length.toLocaleString("fa-IR")} فایل` : "بدون فایل"}</b>{expenseEnabled && <><span>هزینه انجام‌شده</span><b>{parseExpenseAmount(expenseAmount).toLocaleString("fa-IR")} تومان</b></>}</div>
                <div className="pending-callout"><Icon>◷</Icon><p><b>امتیاز در وضعیت Pending می‌ماند</b><small>پس از تأیید سرپرست، امتیاز قطعی خواهد شد.</small></p></div>
                <button className="primary-wide" onClick={finishWork}>پایان مأموریت و ارسال</button>
              </section>}
              {workStep === 4 && <section className="success-panel"><span>{completionPenalty ? "!" : workResult !== "انجام شد" ? "↻" : "✓"}</span><h2>{workResult !== "انجام شد" ? "گزارش ثبت و پیگیری بعدی ساخته شد" : "گزارش با موفقیت ارسال شد"}</h2><p>{completionPenalty ? completionScoreNote : workResult !== "انجام شد" ? selectedMission.source === "employee" || selectedMission.type === "خودم" ? "این مأموریت در پیگیری مجدد است؛ پس از بررسی گزارش فعلی توسط سرپرست، مراجعه بعدی را شروع کنید." : "این مأموریت مختومه نشده و برای مراجعه یا پیگیری بعدی دوباره وارد روال کار شد." : selectedMission.source === "employee" || selectedMission.type === "خودم" ? "سرپرست گزارش را بررسی می‌کند. تا آن زمان امتیاز این مأموریت در انتظار است." : "مأموریت انجام شد و امتیاز آن قطعی است."}</p><div className={completionPenalty ? "score-with-penalty" : ""}><b>+{completionScore.toLocaleString("fa-IR")}</b><small>{completionPenalty ? `امتیاز نهایی · ${completionPenalty.toLocaleString("fa-IR")} امتیاز کسر شد` : selectedMission.source === "employee" || selectedMission.type === "خودم" ? "امتیاز Pending" : "امتیاز ثبت‌شده"}</small></div><button className="primary-wide" onClick={() => {setScreen("missions"); setMissionTab(workResult !== "انجام شد" ? "follow_up" : selectedMission.source === "employee" || selectedMission.type === "خودم" ? "pending" : "done");}}>مشاهده وضعیت مأموریت</button></section>}
            </div>
          )}

          {screen === "report" && <div className="employee-report-screen">
            <div className="report-screen-head"><button className="back-link" onClick={()=>setScreen("home")}>→ خانه</button><button type="button" onClick={()=>loadDailySummary().catch(error=>notify(error.message))}>↻ به‌روزرسانی</button></div>
            <div className="report-intro"><span>▤</span><div><h2>{reportPeriod === "daily" ? "گزارش کامل امروز من" : reportPeriod === "weekly" ? "گزارش ۷ روز اخیر من" : "گزارش ۳۰ روز اخیر من"}</h2><p>کارکرد، مأموریت‌ها و مقصدهای ثبت‌شده در بازه انتخابی</p></div></div>
            <div className="employee-report-periods">{[{id:"daily",label:"امروز"},{id:"weekly",label:"۷ روز اخیر"},{id:"monthly",label:"۳۰ روز اخیر"}].map(period=><button key={period.id} className={reportPeriod===period.id?"active":""} onClick={()=>loadDailySummary(period.id as "daily"|"weekly"|"monthly").catch(error=>notify(error.message))}>{period.label}</button>)}</div>
            {summaryLoading && !dailySummary ? <div className="summary-loading">در حال آماده‌سازی گزارش امروز...</div> : dailySummary ? <EmployeeDailySummaryView summary={dailySummary} onOpenMission={mission=>openMissionDetail(mission,"report")} /> : <div className="summary-loading">گزارش امروز در دسترس نیست.</div>}
          </div>}

          {screen === "mission-detail" && <div className="mission-detail-screen">
            <button className="back-link" onClick={()=>setScreen(detailReturnScreen)}>→ بازگشت</button>
            <div className="mission-detail-hero"><span className={selectedMission.result === "انجام شد" ? "success" : "warning"}>{selectedMission.result === "انجام شد" ? "✓" : selectedMission.result ? "◷" : "▣"}</span><div><small>{selectedMission.type === "خودم" || selectedMission.source === "employee" ? "مأموریت خودساخته" : "مأموریت مدیر"}</small><h2>{selectedMission.title}</h2><p>{selectedMission.status === "follow_up" ? `نتیجه مراجعه قبلی: ${selectedMission.result ?? "نیازمند پیگیری"}` : selectedMission.completedAt ? `ثبت نتیجه در ${formatPersianDateTime(selectedMission.completedAt)}` : selectedMission.backendStatus === "in_progress" ? "شروع کار ثبت شده و مأموریت در حال انجام است" : "شرح وظیفه را بخوانید و سپس روش ادامه را انتخاب کنید"}</p></div></div>
            {(!selectedMission.completedAt || selectedMission.status === "follow_up") && <section className="mission-task-description"><span>شرح وظیفه</span><p>{selectedMission.description?.trim() || "برای این مأموریت توضیح جداگانه‌ای ثبت نشده است؛ در صورت ابهام با مدیر یا سرپرست هماهنگ کنید."}</p><div><small>تاریخ ثبت</small><b>{formatPersianDateTime(selectedMission.createdAt)}</b><small>مهلت</small><b>{selectedMission.deadline ?? "بدون مهلت"}</b><small>اولویت</small><b>{selectedMission.priority ?? "عادی"}</b>{Number(selectedMission.attemptCount ?? 0) > 0 && <><small>تعداد مراجعات ثبت‌شده</small><b>{Number(selectedMission.attemptCount).toLocaleString("fa-IR")}</b></>}</div></section>}
            <div className="mission-detail-card"><span>نتیجه آخرین مراجعه</span><b className={selectedMission.result === "انجام شد" ? "green" : "amber"}>{selectedMission.result ?? "هنوز نتیجه‌ای ثبت نشده"}</b><span>گزارش من</span><b>{selectedMission.report ?? "هنوز گزارشی ثبت نشده است."}</b><span>مقصد</span><b>{selectedMission.destinationName ?? "مقصد ثبت نشده"}</b>{Number(selectedMission.expenseAmount ?? 0) > 0 && <><span>هزینه انجام‌شده</span><b>{Number(selectedMission.expenseAmount).toLocaleString("fa-IR")} تومان</b></>}{Number(selectedMission.scorePenalty ?? 0) > 0 && <><span>کسر امتیاز</span><b className="score-penalty">−{Number(selectedMission.scorePenalty).toLocaleString("fa-IR")} · {selectedMission.scoreNote}</b></>}<span>وضعیت</span><b>{selectedMission.backendStatus === "follow_up_pending" ? "پیگیری مجدد · منتظر بررسی گزارش قبلی" : selectedMission.backendStatus === "follow_up" ? "آماده پیگیری مجدد" : selectedMission.backendStatus === "pending" || selectedMission.status === "pending" ? "در انتظار تأیید سرپرست" : selectedMission.backendStatus === "rejected" ? "ردشده" : selectedMission.backendStatus === "revision" ? "نیازمند اصلاح" : selectedMission.backendStatus === "in_progress" ? "در حال انجام" : selectedMission.completedAt ? "ثبت و تکمیل‌شده" : "باز"}</b></div>
            {selectedMission.id && selectedMission.result && selectedMission.result !== "انجام شد" && <EmployeeFollowUpPanel missionId={String(selectedMission.id)} onMessage={notify}/>}
            {!["awaiting_supervisor","awaiting_employee","escalated"].includes(selectedMission.followUpRequestStatus??"") && <>
            {["open","follow_up"].includes(selectedMission.status) && selectedMission.backendStatus !== "follow_up_pending" && <section className="mission-detail-actions">{!working && <div className="mission-start-lock"><Icon>▣</Icon><span><b>فعالیت روزانه شروع نشده است</b><small>برای شروع یا پایان این مأموریت ابتدا از خانه «شروع فعالیت» را بزنید.</small></span></div>}<button className="primary-wide" disabled={!working} onClick={()=>startMission(selectedMission)}>{selectedMission.backendStatus === "in_progress" ? "ادامه کار روی این مأموریت" : selectedMission.backendStatus === "follow_up" ? "شروع پیگیری مجدد این مأموریت" : "شروع کار روی این مأموریت"}</button><button className="mission-report-direct" disabled={!working} onClick={()=>reportMissionWithoutStart(selectedMission)}>{selectedMission.backendStatus === "in_progress" ? "ثبت مقصد و نتیجه کار" : selectedMission.backendStatus === "follow_up" ? "ثبت نتیجه پیگیری بدون زدن شروع کار" : "ثبت مقصد بدون زدن شروع کار"}</button>{selectedMission.backendStatus !== "in_progress" && <small className="direct-score-note">در صورت پایان مأموریت از این مسیر، ۳ امتیاز کسر و دلیل آن در گزارش شما ثبت می‌شود.</small>}<button className="choose-another-mission" onClick={()=>{setMissionTab(selectedMission.status === "follow_up" ? "follow_up" : "open");setScreen("missions")}}>انتخاب مأموریت دیگر از فهرست</button></section>}
            </>}
            {selectedMission.backendStatus === "follow_up_pending" && <div className="pending-callout"><Icon>◷</Icon><p><b>پیگیری بعدی بعد از بررسی سرپرست فعال می‌شود</b><small>سابقه این مراجعه حفظ شده و با تأیید گزارش، دکمه شروع پیگیری مجدد نمایش داده می‌شود.</small></p></div>}
            {["awaiting_supervisor","awaiting_employee","escalated"].includes(selectedMission.followUpRequestStatus??"") && <div className="pending-callout"><Icon>↻</Icon><p><b>این مأموریت هنوز در حال بررسی است</b><small>بعد از اقدام سرپرست، شروع پیگیری مجدد برای شما فعال می‌شود.</small></p></div>}
          </div>}

          {screen === "end-review" && <div className="end-review-screen">
            <button className="back-link" onClick={()=>{setSummaryConfirmed(false);setEndWorkNote("");setScreen("home")}}>→ بازگشت بدون پایان کار</button>
            <div className="end-review-intro"><span>✓</span><h2>مرور و تأیید فعالیت‌های امروز</h2><p>قبل از پایان فعالیت، انجام‌شده‌ها، انجام‌نشده‌ها و مقصدهای امروز را بررسی کنید.</p></div>
            {summaryLoading && !dailySummary ? <div className="summary-loading">در حال دریافت فهرست فعالیت‌ها...</div> : dailySummary ? <EmployeeDailySummaryView summary={dailySummary} /> : <div className="summary-loading">فهرست فعالیت‌ها در دسترس نیست.</div>}
            {dailySummary && <><div className="daily-confirm-check"><input id="confirm-daily-summary" aria-label="تأیید فعالیت‌های امروز" type="checkbox" checked={summaryConfirmed} onChange={event=>setSummaryConfirmed(event.target.checked)} /><span><b>فعالیت‌های امروز مورد تأیید من است</b><small>فهرست کارهای انجام‌شده و انجام‌نشده بالا را بررسی کردم.</small></span></div><label className="end-work-note"><span><b>ثبت توضیحات پایان فعالیت <i>*</i></b><small>خلاصه‌ای از وضعیت امروز، کارهای باقی‌مانده یا نکته لازم برای سرپرست بنویسید.</small></span><textarea value={endWorkNote} onChange={event=>setEndWorkNote(event.target.value)} maxLength={1000} rows={3} placeholder="مثلاً: مأموریت‌های امروز انجام شد؛ پیگیری مجوز برای فردا باقی ماند." required /><em>{endWorkNote.length.toLocaleString("fa-IR")} / ۱۰۰۰</em></label><button className="primary-wide end-work-confirm" disabled={!summaryConfirmed || endWorkNote.trim().length < 3} onClick={confirmEndWork}>تأیید و پایان فعالیت امروز</button></>}
          </div>}

          {screen === "notifications" && <NotificationCenter onOpenMissions={()=>setScreen("missions")} onOpenFollowUps={()=>{setMissionTab("follow_up");setScreen("missions")}} onCounts={setNotificationCounts}/>}
          {screen === "notification-settings" && <NotificationSettings onMessage={notify} onEnabledChange={setEmployeeNotificationEnabled}/>}
          {screen === "account-settings" && <AccountSettings initialFullName={employeeDisplayName} initialUsername={username} onSaved={user=>{setEmployeeDisplayName(user.fullName);setUsername(user.username)}} onMessage={notify}/>}
          {screen === "profile" && <div className="profile-screen"><div className="avatar large">{employeeDisplayName.slice(0,2)}</div><h2>{employeeDisplayName}</h2><p>کارشناس امور اداری</p><div className="profile-list"><button onClick={()=>setScreen("account-settings")}><span>نام کاربری، رمز و اطلاعات حساب</span>←</button><button onClick={()=>setScreen("notification-settings")}><span>تنظیمات اعلان‌ها</span><b>{employeeNotificationEnabled?"فعال":"غیرفعال"}</b></button><button onClick={()=>setScreen("notifications")}><span>درخواست‌های باز</span><b>{notificationCounts.open.toLocaleString("fa-IR")}</b></button><button onClick={() => syncQueued().catch(() => undefined)}><span>همگام‌سازی اطلاعات</span><b>{pendingSync ? `${pendingSync.toLocaleString("fa-IR")} مورد` : "همگام"}</b></button><button><span>راهنمای استفاده</span>←</button><button className="logout" onClick={async () => {await api("/api/auth/logout",{method:"POST"});setScreen("home");setPassword("");setSignedIn(false);}}><span>خروج از حساب</span>←</button></div></div>}
        </div>

        <nav className="bottom-nav" aria-label="ناوبری اپ">
          <button className={screen === "home" ? "active" : ""} onClick={() => setScreen("home")}><Icon>⌂</Icon><span>خانه</span></button>
          <button className={screen === "missions" || screen === "work" || screen === "new" || screen === "mission-detail" ? "active" : ""} onClick={() => setScreen("missions")}><Icon>▣</Icon><span>مأموریت‌ها</span><i>{missions.filter(m=>["open","follow_up"].includes(m.status)).length.toLocaleString("fa-IR")}</i></button>
          <button onClick={() => setScreen("new")} className="nav-add" aria-label="مأموریت جدید"><Icon>＋</Icon></button>
          <button className={screen === "report" || screen === "end-review" ? "active" : ""} onClick={openMyReport}><Icon>▤</Icon><span>گزارش من</span></button>
          <button className={["profile","notification-settings","account-settings"].includes(screen) ? "active" : ""} onClick={() => setScreen("profile")}><Icon>♙</Icon><span>حساب</span></button>
        </nav>
        {toast && <div className="toast"><Icon>✓</Icon>{toast}</div>}
      </section>

      <div className="employee-context context-left">
        <span className="eyebrow">سناریوی پیشنهادی</span>
        <div className="flow-list"><span className={workStep === 0 ? "active" : "done"}><i>۱</i>ثبت مقصد</span><span className={workStep === 1 ? "active" : workStep > 1 ? "done" : ""}><i>۲</i>ثبت نتیجه</span><span className={workStep === 2 ? "active" : workStep > 2 ? "done" : ""}><i>۳</i>مدرک و هزینه</span><span className={workStep === 3 ? "active" : workStep > 3 ? "done" : ""}><i>۴</i>تأیید سرپرست</span></div>
        <button onClick={() => {setScreen("work"); setWorkStep(0);}}>مشاهده جریان کامل ←</button>
      </div>
    </main>
  );
}

function LiveMap({ locations, destinations, focus }: { locations: ApiLocation[]; destinations: ApiDestination[]; focus?: boolean }) {
  if (!locations.length && !destinations.length) return <div className={`live-map-empty live-map-blank ${focus ? "large" : ""}`}><div><Icon>⌖</Icon><b>هنوز موقعیتی ثبت نشده است</b><span>مکان فعلی پس از شروع فعالیت و پین‌های شماره‌دار پس از «ثبت مقصد» کارمند اینجا نمایش داده می‌شوند.</span></div></div>;
  return <OperationsMap currentLocations={locations} destinations={destinations} large={focus} />;
}

function AdminPerformanceReports({ rows, destinations, period, onPeriodChange, policy }: { rows:ApiReportRow[]; destinations:ApiDestination[]; period:"daily"|"weekly"|"monthly"; onPeriodChange:(value:"daily"|"weekly"|"monthly")=>void; policy?:{standardStart:string;standardDailyMinutes:number;note:string} }) {
  const [selectedId, setSelectedId] = useState("");
  const selected = rows.find(row=>row.id===selectedId) ?? rows[0];
  const selectedDestinations = selected ? destinations.filter(destination=>destination.userId===selected.id) : [];
  const totals = rows.reduce((sum,row)=>({active:sum.active+row.attendance.activeMinutes,completed:sum.completed+row.missions.completedCount,overdue:sum.overdue+row.missions.overdueCount,distance:sum.distance+row.movement.missionDistanceKm,travel:sum.travel+row.movement.travelMinutes,moving:sum.moving+row.movement.movingMinutes,expense:sum.expense+row.finance.total,gaps:sum.gaps+row.integrity.gpsGapMinutes,score:sum.score+row.quality.confirmedScore,pending:sum.pending+row.quality.pendingScore}),{active:0,completed:0,overdue:0,distance:0,travel:0,moving:0,expense:0,gaps:0,score:0,pending:0});
  const exportUrl = `/api/reports/export?period=${period}`;
  return <div className="reports-layout reports-v2">
    {selected&&<section className="panel report-destination-map"><div className="panel-head"><div><h2>نقشه مقصدهای {selected.fullName}</h2><p>{period==="daily"?"پین‌های شماره‌دار امروز":period==="weekly"?"پین‌های ۷ روز اخیر؛ شماره‌گذاری هر روز جداست":"پین‌های ۳۰ روز اخیر؛ شماره‌گذاری هر روز جداست"}</p></div><span>{selectedDestinations.length.toLocaleString("fa-IR")} مقصد ثبت‌شده</span></div>{selectedDestinations.length?<><OperationsMap currentLocations={[]} destinations={selectedDestinations} /><div className="report-pin-list">{selectedDestinations.map(destination=><span key={destination.id}><i>{destination.sequence.toLocaleString("fa-IR")}</i><b>{destination.missionTitle}</b><small>{destination.destinationName} · {formatPersianDateTime(destination.recordedAt)}</small></span>)}</div></>:<div className="report-map-empty"><Icon>⌖</Icon><b>در این بازه مقصدی ثبت نشده است</b><small>هر بار کارمند «ثبت مقصد» را بزند، پین همان مأموریت اینجا ذخیره می‌شود.</small></div>}</section>}
    <div className="report-commandbar"><div className="period-selector"><button className={period==="daily"?"active":""} onClick={()=>onPeriodChange("daily")}>روزانه</button><button className={period==="weekly"?"active":""} onClick={()=>onPeriodChange("weekly")}>هفتگی</button><button className={period==="monthly"?"active":""} onClick={()=>onPeriodChange("monthly")}>ماهانه</button></div><div className="report-export-actions"><a href={exportUrl}>⇩ خروجی Excel / CSV</a><button onClick={()=>window.open(`${exportUrl}&format=print`,"_blank","noopener,noreferrer")}>▤ چاپ / ذخیره PDF</button></div></div>
    <div className="report-policy"><Icon>◷</Icon><span><b>معیار محاسبه حضور</b><small>{policy?.note ?? "معیار فعلی سامانه شروع ۰۸:۳۰ و ۸ ساعت کار در هر روز حضور است."}</small></span></div>
    <div className="report-kpis"><div><small>کل کارکرد</small><b>{formatMinutes(totals.active)}</b></div><div><small>مأموریت تکمیل‌شده</small><b>{totals.completed.toLocaleString("fa-IR")}</b></div><div className={totals.overdue?"danger":""}><small>مأموریت معوق</small><b>{totals.overdue.toLocaleString("fa-IR")}</b></div><div><small>مسافت مأموریت‌ها</small><b>{totals.distance.toLocaleString("fa-IR")} km</b></div><div><small>زمان در مسیر</small><b>{formatMinutes(totals.travel)}</b></div><div><small>زمان در حرکت</small><b>{formatMinutes(totals.moving)}</b></div><div><small>وقفه GPS</small><b>{totals.gaps.toLocaleString("fa-IR")} دقیقه</b></div><div><small>هزینه ثبت‌شده</small><b>{totals.expense.toLocaleString("fa-IR")}</b></div><div><small>امتیاز قطعی</small><b>{totals.score.toLocaleString("fa-IR")}</b></div><div className="pending"><small>امتیاز در انتظار</small><b>{totals.pending.toLocaleString("fa-IR")}</b></div></div>
    {selected&&<section className="panel mission-travel-panel"><div className="panel-head"><div><h2>مسیر هر مأموریتِ {selected.fullName}</h2><p>از «شروع مأموریت» تا «ثبت مقصد»؛ حرکت و توقف از GPS جدا می‌شوند</p></div><span>{selected.movement.missionTrips.length.toLocaleString("fa-IR")} مسیر</span></div>{selected.movement.missionTrips.length?<div className="report-table-scroll"><table className="report-table mission-travel-table"><thead><tr><th>مأموریت</th><th>شروع مسیر</th><th>ثبت مقصد</th><th>زمان در مسیر</th><th>در حرکت</th><th>توقف</th><th>مسافت</th><th>پوشش GPS</th></tr></thead><tbody>{selected.movement.missionTrips.map(trip=><tr key={trip.missionId}><td><b>{trip.title}</b><small>{trip.destinationName ?? "مقصد ثبت نشده"}</small></td><td>{formatPersianDateTime(trip.startedAt ?? undefined)}</td><td>{formatPersianDateTime(trip.destinationRecordedAt ?? undefined)}</td><td><b>{formatMinutes(trip.travelMinutes)}</b></td><td>{formatMinutes(trip.movingMinutes)}</td><td>{formatMinutes(trip.stoppedMinutes)}</td><td><b>{trip.distanceKm.toLocaleString("fa-IR")} km</b><small>{trip.movingMinutes>0?`میانگین ${trip.averageMovingSpeedKmh.toLocaleString("fa-IR")} km/h`:"بدون حرکت معتبر"}</small></td><td><span className={`coverage-badge ${trip.coverageStatus}`}>{trip.coverageStatus==="complete"?"کامل":trip.coverageStatus==="partial"?"ناقص":"بدون داده"}</span><small>{trip.pointCount.toLocaleString("fa-IR")} نقطه</small></td></tr>)}</tbody></table></div>:<div className="empty-state compact-empty"><span>⌖</span><h3>هنوز مسیر مأموریتی ثبت نشده است</h3><p>برای محاسبه، مأموریت باید شروع شود و سپس مقصد آن ثبت شود.</p></div>}</section>}
    <section className="panel report-table-panel"><div className="panel-head"><div><h2>گزارش عملکرد اعضای تیم</h2><p>روی نام هر کاربر بزنید تا ریز گزارش نمایش داده شود</p></div><span>{rows.length.toLocaleString("fa-IR")} کارمند فعال</span></div>{rows.length?<div className="report-table-scroll"><table className="report-table"><thead><tr><th>کارمند</th><th>کارکرد</th><th>تکمیل</th><th>موفق</th><th>باز / معوق</th><th>به‌موقع</th><th>مسافت مأموریت</th><th>GPS</th><th>هزینه</th><th>امتیاز</th></tr></thead><tbody>{rows.map(row=><tr key={row.id} className={selected?.id===row.id?"selected":""} onClick={()=>setSelectedId(row.id)}><td><b>{row.fullName}</b><small>{row.supervisorName ? `سرپرست: ${row.supervisorName}` : row.username}</small></td><td>{formatMinutes(row.attendance.activeMinutes)}</td><td><strong>{row.missions.completedCount.toLocaleString("fa-IR")}</strong><small>{row.missions.completionRate.toLocaleString("fa-IR")}٪</small></td><td>{row.missions.successfulCount.toLocaleString("fa-IR")}</td><td><span>{row.missions.openCount.toLocaleString("fa-IR")} باز</span><em>{row.missions.overdueCount.toLocaleString("fa-IR")} معوق</em></td><td>{row.missions.onTimeRate.toLocaleString("fa-IR")}٪</td><td>{row.movement.missionDistanceKm.toLocaleString("fa-IR")} km</td><td>{row.integrity.gpsGapMinutes.toLocaleString("fa-IR")} دقیقه</td><td>{row.finance.total.toLocaleString("fa-IR")}</td><td><b>{row.quality.confirmedScore.toLocaleString("fa-IR")}</b><small>{row.quality.pendingScore.toLocaleString("fa-IR")} در انتظار</small></td></tr>)}</tbody></table></div>:<div className="empty-state"><span>▤</span><h3>داده‌ای در این بازه وجود ندارد</h3><p>پس از ثبت فعالیت و مأموریت، گزارش واقعی اینجا نمایش داده می‌شود.</p></div>}</section>
    {selected&&<div className="report-detail-grid">
      <section className="panel report-detail"><div className="report-detail-head"><span className="avatar large blue">{selected.fullName.slice(0,2)}</span><div><h2>{selected.fullName}</h2><p>{period==="daily"?"گزارش روزانه":period==="weekly"?"گزارش ۷ روز اخیر":"گزارش ۳۰ روز اخیر"}</p></div></div><h3>حضور و کارکرد</h3><div className="report-metric-list"><span><small>اولین ورود</small><b>{formatPersianDateTime(selected.attendance.firstStartAt ?? undefined)}</b></span><span><small>آخرین خروج</small><b>{formatPersianDateTime(selected.attendance.lastEndAt ?? undefined)}</b></span><span><small>تأخیر</small><b>{formatMinutes(selected.attendance.lateMinutes)}</b></span><span><small>اضافه‌کار / کسری</small><b>{formatMinutes(selected.attendance.overtimeMinutes)} / {formatMinutes(selected.attendance.shortfallMinutes)}</b></span><span><small>زمان بدون GPS و محاسبه‌نشده</small><b>{formatMinutes(selected.attendance.unverifiedGpsMinutes)}</b></span><span><small>خوداظهاری در انتظار</small><b>{formatMinutes(selected.attendance.pendingCorrectionMinutes)}</b></span><span><small>تعداد شروع خوداظهاری</small><b>{selected.attendance.selfReportedStartCount.toLocaleString("fa-IR")}</b></span></div></section>
      <section className="panel report-detail"><h3>ماموریت‌ها</h3><div className="report-metric-list"><span><small>تخصیص / تکمیل</small><b>{selected.missions.assignedCount.toLocaleString("fa-IR")} / {selected.missions.completedCount.toLocaleString("fa-IR")}</b></span><span><small>موفق / نیازمند پیگیری</small><b>{selected.missions.successfulCount.toLocaleString("fa-IR")} / {selected.missions.followUpCount.toLocaleString("fa-IR")}</b></span><span><small>در انتظار / رد یا اصلاح</small><b>{selected.missions.pendingCount.toLocaleString("fa-IR")} / {selected.missions.rejectedCount.toLocaleString("fa-IR")}</b></span><span><small>میانگین زمان مأموریت</small><b>{formatMinutes(selected.missions.averageMissionMinutes)}</b></span></div></section>
      <section className="panel report-detail"><h3>حرکت و یکپارچگی</h3><div className="report-metric-list"><span><small>زمان در مسیر</small><b>{formatMinutes(selected.movement.travelMinutes)}</b></span><span><small>زمان واقعاً در حرکت</small><b>{formatMinutes(selected.movement.movingMinutes)}</b></span><span><small>توقف در مسیر</small><b>{formatMinutes(selected.movement.stoppedMinutes)}</b></span><span><small>مسافت مسیر مأموریت‌ها</small><b>{selected.movement.missionDistanceKm.toLocaleString("fa-IR")} km</b></span><span><small>زمان حضور در مقصد</small><b>{formatMinutes(selected.movement.onSiteMinutes)}</b></span><span><small>زمان دسته‌بندی‌نشده</small><b>{formatMinutes(selected.movement.unclassifiedMinutes)}</b></span><span><small>نقاط GPS / هشدار باز</small><b>{selected.movement.locationPointCount.toLocaleString("fa-IR")} / {selected.integrity.openCount.toLocaleString("fa-IR")}</b></span></div>{selected.movement.destinations.length>0&&<div className="report-destinations">{selected.movement.destinations.map(value=><span key={value}>⌖ {value}</span>)}</div>}</section>
      <section className="panel report-detail"><h3>کیفیت، مدارک و هزینه</h3><div className="report-metric-list"><span><small>مدارک ثبت‌شده</small><b>{selected.quality.attachmentCount.toLocaleString("fa-IR")}</b></span><span><small>نرخ تأیید فعلی</small><b>{selected.quality.firstPassApprovalRate.toLocaleString("fa-IR")}٪</b></span><span><small>هزینه تأیید / در انتظار</small><b>{selected.finance.approved.toLocaleString("fa-IR")} / {selected.finance.pending.toLocaleString("fa-IR")}</b></span><span><small>میانگین هزینه هر مأموریت</small><b>{selected.finance.averagePerMission.toLocaleString("fa-IR")} تومان</b></span></div></section>
      {selected.attendance.endNotes.length>0&&<section className="panel report-end-notes"><h3>توضیحات ثبت‌شده هنگام پایان فعالیت</h3>{selected.attendance.endNotes.map(note=><div key={`${note.at}-${note.note}`}><time>{formatPersianDateTime(note.at)}</time><p>{note.note}</p></div>)}</section>}
    </div>}
  </div>;
}

function AdminPanel() {
  const [adminSignedIn, setAdminSignedIn] = useState(false);
  const [adminUserId, setAdminUserId] = useState("");
  const [adminRole, setAdminRole] = useState<"owner" | "admin" | "supervisor">("admin");
  const [adminDisplayName, setAdminDisplayName] = useState("مدیر سیستم");
  const [adminUsername, setAdminUsername] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminError, setAdminError] = useState("");
  const [adminNotificationCounts,setAdminNotificationCounts]=useState({unread:0,open:0});
  const [screen, setScreen] = useState<AdminScreen>(restoreAdminScreen);
  const [selected, setSelected] = useState(0);
  const [approvalFilter, setApprovalFilter] = useState("pending");
  const [toast, setToast] = useState("");
  const [accessStage, setAccessStage] = useState<"list" | "create" | "edit" | "issued">("list");
  const [accessEditingId, setAccessEditingId] = useState<string | null>(null);
  const [accessStatus, setAccessStatus] = useState<"active" | "disabled">("active");
  const [accessSubmitting, setAccessSubmitting] = useState(false);
  const [employeeName, setEmployeeName] = useState("");
  const [employeeUsername, setEmployeeUsername] = useState("");
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [employeeMobile, setEmployeeMobile] = useState("");
  const [accessRole, setAccessRole] = useState<"admin" | "supervisor" | "employee">("employee");
  const [accessSupervisorId, setAccessSupervisorId] = useState("");
  const [adminUsers, setAdminUsers] = useState<ApiUser[]>([]);
  const [adminMissions, setAdminMissions] = useState<ApiMission[]>([]);
  const [adminMissionFilter, setAdminMissionFilter] = useState<"all"|"open"|"in_progress"|"pending"|"follow_up"|"done">("all");
  const [missionFormOpen, setMissionFormOpen] = useState(false);
  const [missionEditingId, setMissionEditingId] = useState<string | null>(null);
  const [missionTitle, setMissionTitle] = useState("");
  const [missionDescription, setMissionDescription] = useState("");
  const [missionDestination, setMissionDestination] = useState("");
  const [missionPriority, setMissionPriority] = useState("normal");
  const [missionDeadlineDate, setMissionDeadlineDate] = useState("");
  const [missionDeadlineTime, setMissionDeadlineTime] = useState("");
  const [missionAssignee, setMissionAssignee] = useState("");
  const [missionSubmitting, setMissionSubmitting] = useState(false);
  const [missionTrace, setMissionTrace] = useState<ApiMissionTrace | null>(null);
  const [missionTraceOpen, setMissionTraceOpen] = useState(false);
  const [missionTraceLoading, setMissionTraceLoading] = useState(false);
  const [missionTraceScore, setMissionTraceScore] = useState("12");
  const [missionTraceScoreNote, setMissionTraceScoreNote] = useState("");
  const [missionTraceScoreSaving, setMissionTraceScoreSaving] = useState(false);
  const [approvalItems, setApprovalItems] = useState<ApiApproval[]>([]);
  const [liveLocations, setLiveLocations] = useState<ApiLocation[]>([]);
  const [destinationPins, setDestinationPins] = useState<ApiDestination[]>([]);
  const [reportDestinations, setReportDestinations] = useState<ApiDestination[]>([]);
  const [integrityEvents, setIntegrityEvents] = useState<ApiIntegrityEvent[]>([]);
  const [reportRows, setReportRows] = useState<ApiReportRow[]>([]);
  const [adminReportPeriod, setAdminReportPeriod] = useState<"daily"|"weekly"|"monthly">("daily");
  const [reportPolicy, setReportPolicy] = useState<{standardStart:string;standardDailyMinutes:number;note:string}>();
  const notify = useCallback((message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2500); }, []);
  const updateFollowUpCount = useCallback((open:number)=>setAdminNotificationCounts(current=>({...current,open})),[]);
  const titles: Record<AdminScreen, [string,string]> = {
    dashboard:["نمای کلی عملیات","وضعیت زنده سامانه بر اساس اطلاعات ثبت‌شده"], live:["ردیابی زنده","موقعیت نیروهای مجاز و جزئیات فعالیت امروز"], missions:["مدیریت مأموریت‌ها","برنامه‌ریزی، تخصیص و پیگیری مأموریت‌های تیم"], actions:["نیازمند اقدام","گفت‌وگو، بررسی و تعیین تکلیف درخواست‌های پیگیری"], access:adminRole === "supervisor" ? ["کاربران زیرمجموعه","مشاهده کارکنانی که مستقیماً زیر نظر شما هستند"] : ["کاربران و دسترسی‌ها","ساخت حساب، تعیین نقش و مدیریت ورود کارکنان"], approvals:["تأییدهای در انتظار","بررسی گزارش‌های خودساخته و هزینه‌ها"], integrity:["مرکز یکپارچگی","بررسی قطعی GPS، فاصله زمانی و رویدادهای مشکوک"], reports:["گزارش‌ها و عملکرد","تحلیل فعالیت میدانی و امتیازهای قطعی"], notifications:["اعلان‌ها و درخواست‌های باز","رویدادهای جدید و کارهای قابل اقدام"], account:["حساب و امنیت","تغییر اطلاعات حساب، نام کاربری، رمز و اعلان گوشی"]
  };
  const nav: {id:AdminScreen; label:string; icon:string; count?:number}[] = [
    {id:"dashboard",label:"داشبورد",icon:"▦"},{id:"live",label:"ردیابی زنده",icon:"⌖"},{id:"missions",label:"مأموریت‌ها",icon:"▣",count:adminMissions.length},{id:"actions",label:"نیازمند اقدام",icon:"↻",count:adminNotificationCounts.open},{id:"access",label:adminRole === "supervisor" ? "کاربران زیرمجموعه" : "کاربران و دسترسی‌ها",icon:"♙",count:adminUsers.length},{id:"approvals",label:"تأییدها",icon:"✓",count:approvalItems.length},{id:"integrity",label:"مرکز یکپارچگی",icon:"◇",count:integrityEvents.filter(event=>event.status==="open").length},{id:"reports",label:"گزارش‌ها",icon:"▤"},{id:"notifications",label:"اعلان‌ها",icon:"♧",count:adminNotificationCounts.unread},{id:"account",label:"حساب و امنیت",icon:"♙"}
  ];

  useEffect(() => {
    persistNavigation("admin", screen);
  }, [screen]);

  const loadAdminData = async (target = screen) => {
    if (target === "access") setAdminUsers((await api<{users:ApiUser[]}>("/api/admin/users")).users);
    if (target === "missions") {
      const [missionData, userData] = await Promise.all([
        api<{missions:ApiMission[]}>("/api/missions"),
        api<{users:ApiUser[]}>("/api/admin/users"),
      ]);
      setAdminMissions(missionData.missions);
      setAdminUsers(userData.users);
    }
    if (target === "approvals") setApprovalItems((await api<{approvals:ApiApproval[]}>("/api/approvals")).approvals);
    if (target === "dashboard") {
      const [locations, destinations, missions, users, approvals, integrity] = await Promise.all([
        api<{locations:ApiLocation[]}>("/api/locations"), api<{destinations:ApiDestination[]}>("/api/destinations?period=daily&live=1"),
        api<{missions:ApiMission[]}>("/api/missions"), api<{users:ApiUser[]}>("/api/admin/users"), api<{approvals:ApiApproval[]}>("/api/approvals"), api<{events:ApiIntegrityEvent[]}>("/api/integrity"),
      ]);
      setLiveLocations(locations.locations); setDestinationPins(destinations.destinations); setAdminMissions(missions.missions); setAdminUsers(users.users); setApprovalItems(approvals.approvals); setIntegrityEvents(integrity.events);
    }
    if (target === "live") {
      const [locations, destinations] = await Promise.all([api<{locations:ApiLocation[]}>("/api/locations"), api<{destinations:ApiDestination[]}>("/api/destinations?period=daily&live=1")]);
      setLiveLocations(locations.locations); setDestinationPins(destinations.destinations);
    }
    if (target === "integrity") setIntegrityEvents((await api<{events:ApiIntegrityEvent[]}>("/api/integrity")).events);
    if (target === "reports") {
      const [report, destinations] = await Promise.all([
        api<{rows:ApiReportRow[];policy:{standardStart:string;standardDailyMinutes:number;note:string}}>(`/api/reports/summary?period=${adminReportPeriod}`),
        api<{destinations:ApiDestination[]}>(`/api/destinations?period=${adminReportPeriod}`),
      ]);
      setReportRows(report.rows); setReportPolicy(report.policy); setReportDestinations(destinations.destinations);
    }
  };

  useEffect(() => {
    if (!adminSignedIn) return;
    const timer = window.setTimeout(() => loadAdminData().catch(error => notify(error.message)), 0);
    return () => window.clearTimeout(timer);
    // Each admin screen owns its matching collection and refreshes after mutations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminSignedIn, screen]);
  useEffect(() => {
    if (!adminSignedIn || screen !== "reports") return;
    const timer = window.setTimeout(() => loadAdminData("reports").catch(error => notify(error.message)), 0);
    return () => window.clearTimeout(timer);
    // Report period intentionally refreshes only the report collection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminReportPeriod]);
  useEffect(() => {
    if (!adminSignedIn || (screen !== "dashboard" && screen !== "live")) return;
    const timer = window.setInterval(() => loadAdminData("live").catch(error => notify(error.message)), 30_000);
    return () => window.clearInterval(timer);
    // Live tracking refreshes independently so stale or disabled users disappear without a page reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminSignedIn, screen]);
  useEffect(() => { api<{user:{id:string;role:"owner"|"admin"|"supervisor"|"employee";fullName:string;username:string}}>("/api/auth/me").then(({user})=>{if(['owner','admin','supervisor'].includes(user.role)){setAdminUserId(user.id);setAdminRole(user.role as "owner"|"admin"|"supervisor");setAdminDisplayName(user.fullName);setAdminUsername(user.username);setAdminSignedIn(true)}}).catch(()=>undefined); }, []);
  useEffect(()=>{if(!adminSignedIn)return;let active=true;const load=()=>api<{unreadCount:number;openRequestCount:number}>("/api/notifications").then(result=>{if(active)setAdminNotificationCounts({unread:result.unreadCount,open:result.openRequestCount})}).catch(()=>undefined);load();const timer=window.setInterval(load,60_000);return()=>{active=false;window.clearInterval(timer)}},[adminSignedIn]);

  const adminSignIn = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const result = await api<{user:{id:string;role:"owner"|"admin"|"supervisor"|"employee";fullName:string;username:string}}>("/api/auth/login", { method:"POST", body:JSON.stringify({username:adminUsername,password:adminPassword}) });
      if (!['owner','admin','supervisor'].includes(result.user.role)) throw new Error("این حساب دسترسی مدیریتی ندارد.");
      setAdminUserId(result.user.id); setAdminRole(result.user.role as "owner"|"admin"|"supervisor"); setAdminDisplayName(result.user.fullName); setAdminSignedIn(true); setAdminError("");
    } catch (error) { setAdminError(error instanceof Error ? error.message : "ورود ناموفق بود"); }
  };

  const saveAccess = async (e: FormEvent) => {
    e.preventDefault();
    if (accessRole === "employee" && !accessSupervisorId) return notify("برای کارمند باید یک سرپرست انتخاب کنید");
    setAccessSubmitting(true);
    try {
      const editing = accessStage === "edit" && accessEditingId;
      await api(editing ? `/api/admin/users/${accessEditingId}` : "/api/admin/users", {
        method:editing ? "PATCH" : "POST",
        body:JSON.stringify({
          fullName:employeeName,mobile:employeeMobile,username:employeeUsername,
          ...(temporaryPassword ? {temporaryPassword} : {}),role:accessRole,
          supervisorId:accessRole === "employee" ? accessSupervisorId : null,
          ...(editing ? {status:accessStatus} : {}),
        }),
      });
      if (editing && accessEditingId === adminUserId && temporaryPassword) {
        setAccessStage("list"); setAdminUsername(employeeUsername); setAdminPassword(""); setAdminSignedIn(false);
        setAdminError("رمز حساب شما تغییر کرد. برای ادامه با رمز جدید دوباره وارد شوید.");
        return;
      }
      if (editing && accessEditingId && accessStatus === "disabled") {
        setLiveLocations(current => current.filter(location => location.userId !== accessEditingId));
        setDestinationPins(current => current.filter(destination => destination.userId !== accessEditingId));
        setSelected(0);
      }
      await loadAdminData("access");
      if (editing) { setAccessStage("list"); notify(temporaryPassword ? "اطلاعات و رمز جدید ذخیره شد" : "اطلاعات کاربر ذخیره شد"); }
      else setAccessStage("issued");
    } catch (error) { notify(error instanceof Error ? error.message : "ذخیره دسترسی ناموفق بود"); }
    finally { setAccessSubmitting(false); }
  };

  const openAccessForm = () => {
    setAccessEditingId(null);
    setEmployeeName(""); setEmployeeMobile(""); setEmployeeUsername("");
    setTemporaryPassword(`Rahkar@${Math.floor(1000+Math.random()*9000)}`);
    setAccessRole("employee");
    setAccessStatus("active");
    setAccessSupervisorId(adminUsers.find(user => user.role === "supervisor" && user.status === "active")?.id ?? "");
    setAccessStage("create");
  };

  const openEditUser = (user: ApiUser) => {
    setAccessEditingId(user.id);
    setEmployeeName(user.fullName); setEmployeeMobile(user.mobile); setEmployeeUsername(user.username);
    setTemporaryPassword("");
    setAccessRole(user.role as "admin" | "supervisor" | "employee");
    setAccessSupervisorId(user.role === "employee" ? user.supervisorId ?? "" : "");
    setAccessStatus(user.status === "active" ? "active" : "disabled");
    setAccessStage("edit");
  };

  const toggleUserStatus = async (user: ApiUser) => {
    const nextStatus = user.status === "active" ? "disabled" : "active";
    if (nextStatus === "disabled" && !window.confirm(`حساب «${user.fullName}» غیرفعال شود؟ ورودهای باز او نیز بسته می‌شود.`)) return;
    try {
      await api(`/api/admin/users/${user.id}`, { method:"PATCH", body:JSON.stringify({status:nextStatus}) });
      if (nextStatus === "disabled") {
        setLiveLocations(current => current.filter(location => location.userId !== user.id));
        setDestinationPins(current => current.filter(destination => destination.userId !== user.id));
        setSelected(0);
      }
      await loadAdminData("access");
      notify(nextStatus === "active" ? "حساب کاربر فعال شد" : "حساب کاربر غیرفعال شد");
    } catch (error) { notify(error instanceof Error ? error.message : "تغییر وضعیت حساب ناموفق بود"); }
  };

  const deleteUser = async (user: ApiUser) => {
    if (!window.confirm(`حساب «${user.fullName}» حذف شود؟ حساب‌های دارای سابقه عملیاتی فقط قابل غیرفعال‌سازی هستند.`)) return;
    try {
      await api(`/api/admin/users/${user.id}`, { method:"DELETE" });
      if (accessEditingId === user.id) setAccessStage("list");
      await loadAdminData("access");
      notify("حساب کاربر حذف شد");
    } catch (error) { notify(error instanceof Error ? error.message : "حذف حساب ناموفق بود"); }
  };

  const openMissionForm = async (mission?: ApiMission) => {
    try {
      const users = (await api<{users:ApiUser[]}>("/api/admin/users")).users;
      const assignable = users.filter(user => user.status === "active" && (adminRole !== "supervisor" || user.role === "employee"));
      const parsedDeadline = splitStoredDeadline(mission?.deadline);
      setAdminUsers(users);
      setMissionEditingId(mission?.id ?? null);
      setMissionTitle(mission?.title ?? ""); setMissionDescription(mission?.description ?? ""); setMissionDestination(mission?.destinationName ?? "");
      setMissionPriority(mission?.priority ?? "normal"); setMissionDeadlineDate(parsedDeadline.date); setMissionDeadlineTime(parsedDeadline.time);
      setMissionAssignee(mission?.assignedTo && assignable.some(user => user.id === mission.assignedTo) ? mission.assignedTo : assignable[0]?.id ?? "");
      setMissionFormOpen(true);
    } catch (error) { notify(error instanceof Error ? error.message : "دریافت فهرست کاربران ناموفق بود"); }
  };

  const createAdminMission = async (e: FormEvent) => {
    e.preventDefault();
    if (!missionTitle.trim() || !missionAssignee) return notify("عنوان و مسئول مأموریت را انتخاب کنید");
    setMissionSubmitting(true);
    try {
      await api<{mission:ApiMission}>(missionEditingId ? `/api/missions/${missionEditingId}` : "/api/missions", { method:missionEditingId ? "PATCH" : "POST", body:JSON.stringify({
        title:missionTitle, description:missionDescription, destinationName:missionDestination,
        priority:missionPriority, deadlineDate:missionDeadlineDate || null, deadlineTime:missionDeadlineTime || null, assignedTo:missionAssignee,
      }) });
      setMissionTitle(""); setMissionDescription(""); setMissionDestination(""); setMissionPriority("normal"); setMissionDeadlineDate(""); setMissionDeadlineTime("");
      setMissionFormOpen(false); setScreen("missions");
      await loadAdminData("missions");
      notify(missionEditingId ? "تغییرات مأموریت ذخیره شد" : "مأموریت ثبت و به کاربر انتخاب‌شده تخصیص داده شد");
      setMissionEditingId(null);
    } catch (error) { notify(error instanceof Error ? error.message : "ثبت مأموریت ناموفق بود"); }
    finally { setMissionSubmitting(false); }
  };

  const deleteMission = async (mission: ApiMission) => {
    if (!window.confirm(`مأموریت «${mission.title}» حذف شود؟ این کار فقط قبل از شروع مأموریت مجاز است.`)) return;
    try {
      await api(`/api/missions/${mission.id}`, { method:"DELETE" });
      await loadAdminData("missions");
      notify("مأموریت حذف شد");
    } catch (error) { notify(error instanceof Error ? error.message : "حذف مأموریت ناموفق بود"); }
  };

  const openMissionTrace = async (mission: ApiMission) => {
    setMissionTraceOpen(true);
    setMissionTrace(null);
    setMissionTraceLoading(true);
    try {
      const result = await api<{trace:ApiMissionTrace}>(`/api/missions/${mission.id}/trace`);
      setMissionTrace(result.trace);
      setMissionTraceScore(String(["pending","pending_approval"].includes(result.trace.mission.status) ? result.trace.mission.scorePending : result.trace.mission.scoreConfirmed));
      setMissionTraceScoreNote(result.trace.mission.scoreNote ?? "");
    } catch (error) {
      setMissionTraceOpen(false);
      notify(error instanceof Error ? error.message : "دریافت نقاط مأموریت ناموفق بود");
    } finally { setMissionTraceLoading(false); }
  };

  const saveMissionTraceScore = async () => {
    if (!missionTrace) return;
    const score = Number(missionTraceScore);
    if (!Number.isInteger(score) || score < 0 || score > 12) return notify("امتیاز باید عدد صحیح بین صفر تا ۱۲ باشد");
    if (missionTraceScoreNote.trim().length < 3) return notify("دلیل ارزیابی و امتیاز را بنویسید");
    setMissionTraceScoreSaving(true);
    try {
      const result = await api<{score:number;note:string;scoreState:"pending"|"confirmed"}>(`/api/missions/${missionTrace.mission.id}/trace`, { method:"PATCH", body:JSON.stringify({score,note:missionTraceScoreNote.trim()}) });
      setMissionTrace(current=>current ? { ...current, mission:{ ...current.mission, scorePending:result.scoreState === "pending" ? result.score : current.mission.scorePending, scoreConfirmed:result.scoreState === "confirmed" ? result.score : current.mission.scoreConfirmed, scoreNote:result.note } } : current);
      setAdminMissions(current=>current.map(mission=>mission.id===missionTrace.mission.id ? { ...mission, scorePending:result.scoreState === "pending" ? result.score : mission.scorePending, scoreConfirmed:result.scoreState === "confirmed" ? result.score : mission.scoreConfirmed, scoreNote:result.note } : mission));
      notify(result.scoreState === "pending" ? "ارزیابی ذخیره شد و امتیاز تا تأیید سرپرست در انتظار است" : "ارزیابی و امتیاز قطعی ذخیره شد");
    } catch (error) { notify(error instanceof Error ? error.message : "ثبت امتیاز ناموفق بود"); }
    finally { setMissionTraceScoreSaving(false); }
  };

  const decideApproval = async (decision:"approved"|"rejected"|"revision") => {
    const current = approvalItems[0];
    if (!current) return notify("موردی برای بررسی وجود ندارد");
    try {
      await api(`/api/approvals/${current.id}/decision`, {method:"POST",body:JSON.stringify({decision,reason:decision === "approved" ? undefined : "نیازمند بررسی و اصلاح گزارش"})});
      await loadAdminData("approvals");notify(decision === "approved" ? "مأموریت تأیید و امتیاز قطعی شد" : "تصمیم ثبت شد");
    } catch (error) { notify(error instanceof Error ? error.message : "ثبت تصمیم ناموفق بود"); }
  };

  const reviewIntegrity = async (event: ApiIntegrityEvent, status:"resolved"|"dismissed"="resolved") => {
    try {
      await api("/api/integrity", { method:"PATCH", body:JSON.stringify({id:event.id,status,note:status==="resolved"?"بررسی و تأیید توسط مدیر":"رد پس از بررسی مدیر"}) });
      await loadAdminData("integrity");
      notify(event.type==="self_reported_work_start"?status==="resolved"?"زمان خوداظهاری تأیید شد":"زمان خوداظهاری رد شد":"تصمیم در گزارش ممیزی ثبت شد");
    } catch (error) { notify(error instanceof Error ? error.message : "ثبت تصمیم ناموفق بود"); }
  };

  const selectedLocation = liveLocations[selected] ?? liveLocations[0];
  const activeEmployeeCount = new Set(liveLocations.map(location=>location.userId)).size;
  const totalEmployeeCount = adminUsers.filter(user=>user.role==="employee" && user.status==="active").length;
  const todayKey = new Date().toLocaleDateString("en-CA", { timeZone:"Asia/Tehran" });
  const isToday = (value?:string|null) => Boolean(value && new Date(value).toLocaleDateString("en-CA", { timeZone:"Asia/Tehran" }) === todayKey);
  const todayMissions = adminMissions.filter(mission=>isToday(mission.createdAt) || isToday(mission.completedAt));
  const todayCompleted = todayMissions.filter(mission=>["approved","pending","rejected"].includes(mission.status) || Boolean(mission.completedAt));
  const openIntegrityCount = integrityEvents.filter(event=>event.status==="open").length;
  const completionTrend = Array.from({length:7},(_,index)=>{
    const date = new Date(); date.setDate(date.getDate()-(6-index));
    const key = date.toLocaleDateString("en-CA", { timeZone:"Asia/Tehran" });
    const count = adminMissions.filter(mission=>mission.completedAt && new Date(mission.completedAt).toLocaleDateString("en-CA", { timeZone:"Asia/Tehran" })===key).length;
    return { count, label:new Intl.DateTimeFormat("fa-IR",{weekday:"narrow",timeZone:"Asia/Tehran"}).format(date) };
  });
  const trendMax = Math.max(1,...completionTrend.map(day=>day.count));
  const missionMatchesFilter = (mission: ApiMission, filter: typeof adminMissionFilter) => {
    if (filter === "all") return true;
    if (filter === "open") return ["open", "revision"].includes(mission.status);
    if (filter === "in_progress") return mission.status === "in_progress";
    if (filter === "pending") return ["pending", "pending_approval"].includes(mission.status);
    if (filter === "follow_up") return ["follow_up", "follow_up_pending"].includes(mission.status);
    return ["approved", "completed", "rejected"].includes(mission.status);
  };
  const filteredAdminMissions = adminMissions.filter(mission=>missionMatchesFilter(mission,adminMissionFilter));
  const adminMissionFilters = [
    {id:"all" as const,label:"همه"},{id:"open" as const,label:"باز"},{id:"in_progress" as const,label:"در حال انجام"},
    {id:"pending" as const,label:"منتظر تأیید"},{id:"follow_up" as const,label:"پیگیری مجدد"},{id:"done" as const,label:"انجام‌شده"},
  ];
  const missionTracePoints: MapTracePoint[] = missionTrace ? [
    missionTrace.points.start ? { ...missionTrace.points.start, kind:"start", title:"نقطه شروع مأموریت" } as MapTracePoint : null,
    missionTrace.points.destination ? { ...missionTrace.points.destination, kind:"destination", title:`مقصد: ${missionTrace.points.destination.destinationName}` } as MapTracePoint : null,
    missionTrace.points.end ? { ...missionTrace.points.end, kind:"end", title:"نقطه پایان مأموریت" } as MapTracePoint : null,
  ].filter((point): point is MapTracePoint => point !== null) : [];

  if (!adminSignedIn) return <main className="admin-login-page" dir="rtl"><section className="admin-login-card"><div className="login-brand"><span className="brand-mark">ر</span><b>راهکار</b><small>ورود مدیریت</small></div><div className="login-copy"><h1>ورود به پنل ادمین</h1><p>فقط مدیر، مالک و سرپرست مجاز هستند.</p></div><form onSubmit={adminSignIn}><label>نام کاربری<input value={adminUsername} onChange={e=>setAdminUsername(e.target.value)} autoComplete="username" /></label><label>رمز عبور<input type="password" value={adminPassword} onChange={e=>setAdminPassword(e.target.value)} autoComplete="current-password" /></label>{adminError&&<div className="login-error">! {adminError}</div>}<button className="primary-wide" type="submit">ورود مدیریت</button></form></section></main>;
  return <main className="admin-app" dir="rtl">
    <aside className="admin-sidebar">
      <div className="brand"><span className="brand-mark">ر</span><span><b>راهکار</b><small>مدیریت عملیات میدانی</small></span></div>
      <nav>{nav.map(n => <button key={n.id} className={screen === n.id ? "active" : ""} onClick={() => setScreen(n.id)}><Icon>{n.icon}</Icon><span>{n.label}</span>{n.count && <i>{n.count}</i>}</button>)}</nav>
      <div className="sidebar-help"><Icon>?</Icon><b>نیاز به راهنما دارید؟</b><p>راهنمای سریع سامانه را ببینید.</p><button>مشاهده راهنما</button></div>
      <div className="admin-profile" role="button" tabIndex={0} onClick={()=>setScreen("account")} onKeyDown={event=>{if(event.key==="Enter")setScreen("account")}}><div className="avatar">{adminDisplayName.slice(0,2)}</div><span><b>{adminDisplayName}</b><small>{adminRole === "supervisor" ? "سرپرست تیم" : adminRole === "owner" ? "مالک سیستم" : "مدیر سیستم"}</small></span><button aria-label="حساب و امنیت">⋮</button></div>
    </aside>
    <section className="admin-main">
      <PushNotificationBootstrap active={adminSignedIn} onMessage={notify} />
      <header className="admin-header"><div><h1>{titles[screen][0]}</h1><p>{titles[screen][1]}</p></div><div className="admin-actions"><label className="search"><Icon>⌕</Icon><input placeholder="جستجو در سامانه..." /></label><button className="round notification-round" onClick={()=>setScreen("notifications")} aria-label="اعلان‌ها">♧{adminNotificationCounts.unread>0&&<i/>}{adminNotificationCounts.open>0&&<b>{adminNotificationCounts.open.toLocaleString("fa-IR")}</b>}</button>{!["notifications","account","actions"].includes(screen)&&<button className="primary" onClick={() => screen === "access" && adminRole !== "supervisor" ? openAccessForm() : openMissionForm()}><Icon>＋</Icon> {screen === "access" && adminRole !== "supervisor" ? "ساخت دسترسی" : "مأموریت جدید"}</button>}</div></header>
      <div className="admin-content">
        {screen === "dashboard" && <>
          <div className="kpi-grid">
            <div className="kpi"><span className="kpi-icon blue">♙</span><span><small>نیروی فعال</small><b>{activeEmployeeCount.toLocaleString("fa-IR")} <em>از {totalEmployeeCount.toLocaleString("fa-IR")} نفر</em></b></span><i>GPS واقعی</i></div>
            <div className="kpi"><span className="kpi-icon teal">▣</span><span><small>مأموریت امروز</small><b>{todayMissions.length.toLocaleString("fa-IR")} <em>{todayCompleted.length.toLocaleString("fa-IR")} تعیین‌تکلیف‌شده</em></b></span><i>{todayMissions.length ? `${Math.round(todayCompleted.length/todayMissions.length*100).toLocaleString("fa-IR")}٪` : "بدون داده"}</i></div>
            <div className="kpi"><span className="kpi-icon amber">◷</span><span><small>منتظر تأیید</small><b>{approvalItems.length.toLocaleString("fa-IR")} <em>نیازمند بررسی</em></b></span><i className={approvalItems.length?"warning":""}>{approvalItems.length?"مشاهده":"صف خالی"}</i></div>
            <div className="kpi"><span className="kpi-icon red">◇</span><span><small>هشدار یکپارچگی</small><b>{openIntegrityCount.toLocaleString("fa-IR")} <em>هشدار باز</em></b></span><i className={openIntegrityCount?"warning":""}>{openIntegrityCount?"بررسی":"بدون هشدار"}</i></div>
          </div>
          <div className="dashboard-grid">
            <section className="panel map-panel"><div className="panel-head"><div><h2>موقعیت فعلی و مقصدهای امروز</h2><p>{`${liveLocations.length.toLocaleString("fa-IR")} موقعیت زنده · ${destinationPins.length.toLocaleString("fa-IR")} مقصد شماره‌دار`}</p></div><button onClick={() => setScreen("live")}>نمایش نقشه کامل ←</button></div><LiveMap locations={liveLocations} destinations={destinationPins} /></section>
            <section className="panel active-staff"><div className="panel-head"><div><h2>نیروهای دارای موقعیت</h2><p>{activeEmployeeCount.toLocaleString("fa-IR")} نفر با موقعیت ثبت‌شده</p></div><button onClick={()=>loadAdminData("dashboard").catch(error=>notify(error.message))}>↻</button></div>
              <div className="staff-list">{liveLocations.length ? liveLocations.map((location,i)=><button key={location.id} onClick={()=>{setSelected(i);setScreen("live")}}><span className="avatar blue">{location.fullName.slice(0,2)}</span><span><b>{location.fullName}</b><small><i/> آخرین موقعیت واقعی</small></span><time>{new Date(location.recordedAt).toLocaleTimeString("fa-IR",{hour:"2-digit",minute:"2-digit"})}<small>ثبت GPS</small></time></button>) : <div className="empty-state compact"><span>⌖</span><h3>هنوز نیروی فعالی نیست</h3><p>بعد از شروع فعالیت کارمند، اطلاعات این قسمت تکمیل می‌شود.</p></div>}</div>
            </section>
            <section className="panel approvals-preview"><div className="panel-head"><div><h2>نیازمند اقدام شما</h2><p>تأییدها و هشدارهای اخیر</p></div><button onClick={() => setScreen("approvals")}>مشاهده همه ←</button></div>
              {approvalItems.slice(0,2).map(item=><div className="action-row" key={item.id}><span className="avatar blue">{item.employeeName.slice(0,2)}</span><div><b>{item.title}</b><small>{item.employeeName} · مأموریت خودساخته</small></div><span className="tag amber">تأیید مأموریت</span><button onClick={()=>setScreen("approvals")}>بررسی</button></div>)}
              {integrityEvents.filter(event=>event.status==="open").slice(0,1).map(event=><div className="action-row" key={event.id}><span className="avatar orange">{event.employeeName.slice(0,2)}</span><div><b>هشدار {event.employeeName}</b><small>{event.type === "gps_gap" ? "وقفه ثبت GPS" : event.type === "mission_completed_without_start" ? "پایان مأموریت بدون شروع کار" : "رویداد یکپارچگی"} · {formatPersianDateTime(event.occurredAt)}</small></div><span className="tag red">هشدار</span><button onClick={()=>setScreen("integrity")}>بررسی</button></div>)}
              {!approvalItems.length && !openIntegrityCount && <div className="empty-state compact"><span>✓</span><h3>اقدامی در انتظار نیست</h3><p>تأییدها و هشدارهای واقعی در این قسمت نمایش داده می‌شوند.</p></div>}
            </section>
            <section className="panel chart-panel"><div className="panel-head"><div><h2>روند تکمیل مأموریت‌ها</h2><p>اطلاعات واقعی ۷ روز گذشته</p></div></div><div className="chart"><div className="gridlines"/><div className="bars">{completionTrend.map((day,index)=><div key={index}><span style={{height:`${day.count ? Math.max(12,day.count/trendMax*92) : 2}%`}}><i>{day.count.toLocaleString("fa-IR")}</i></span><small>{day.label}</small></div>)}</div></div></section>
          </div>
        </>}

        {screen === "live" && <div className="live-layout">
          <section className="panel live-map-panel"><div className="map-toolbar"><div className="map-tabs"><button className="active">امروز؛ موقعیت و مقصدها</button><button>{liveLocations.length.toLocaleString("fa-IR")} نیرو · {destinationPins.length.toLocaleString("fa-IR")} پین</button></div><div><button>OpenStreetMap</button><button onClick={()=>loadAdminData("live").catch(error=>notify(error.message))}>↻ به‌روزرسانی</button></div></div><LiveMap locations={liveLocations} destinations={destinationPins} focus /></section>
          <aside className="person-detail"><div className="detail-head"><span className="avatar large blue">{selectedLocation?.fullName.slice(0,2) ?? "—"}</span><div><h2>{selectedLocation?.fullName ?? "بدون موقعیت زنده"}</h2><p><i/> {selectedLocation ? `آخرین ثبت ${new Date(selectedLocation.recordedAt).toLocaleTimeString("fa-IR",{hour:"2-digit",minute:"2-digit"})}` : "منتظر دریافت GPS"}</p></div><button>×</button></div><div className="detail-metrics"><span><small>دقت GPS</small><b>{selectedLocation ? `${Math.round(selectedLocation.accuracy).toLocaleString("fa-IR")} متر` : "—"}</b></span><span><small>سرعت ثبت‌شده</small><b>{selectedLocation?.speed == null ? "—" : `${Math.round(selectedLocation.speed*3.6).toLocaleString("fa-IR")} km/h`}</b></span></div><div className="current-mission"><small>موقعیت فعلی</small><h3>{selectedLocation ? `${selectedLocation.latitude.toFixed(5)}, ${selectedLocation.longitude.toFixed(5)}` : "هنوز ثبت نشده"}</h3><p>اطلاعات مستقیماً از GPS گوشی کارمند دریافت می‌شود</p><span>{selectedLocation ? "زنده" : "بدون داده"}</span></div><h3 className="timeline-title">خط زمانی موقعیت</h3><div className="timeline"><div className="green"><time>{selectedLocation ? new Date(selectedLocation.recordedAt).toLocaleTimeString("fa-IR",{hour:"2-digit",minute:"2-digit"}) : "—"}</time><span><b>آخرین موقعیت GPS</b><small>{selectedLocation ? `دقت ${Math.round(selectedLocation.accuracy).toLocaleString("fa-IR")} متر` : "در انتظار ثبت از گوشی"}</small></span></div><div className="blue"><time>—</time><span><b>همگام‌سازی امن</b><small>نقاط آفلاین پس از اتصال به ترتیب ارسال می‌شوند</small></span></div></div><button className="outline-wide" onClick={()=>loadAdminData("live").catch(error=>notify(error.message))}>به‌روزرسانی اطلاعات</button></aside>
        </div>}

        {screen === "missions" && <section className="panel table-panel"><div className="table-toolbar"><div className="filter-tabs">{adminMissionFilters.map(filter=><button key={filter.id} className={adminMissionFilter===filter.id?"active":""} onClick={()=>setAdminMissionFilter(filter.id)}>{filter.label} <span>{adminMissions.filter(mission=>missionMatchesFilter(mission,filter.id)).length.toLocaleString("fa-IR")}</span></button>)}</div><button onClick={()=>openMissionForm()}>＋ تخصیص مأموریت</button></div>{filteredAdminMissions.length ? <table><thead><tr><th>مأموریت</th><th>مسئول</th><th>ایجادکننده</th><th>تاریخ و ساعت ثبت</th><th>مهلت</th><th>وضعیت</th><th>امتیاز</th><th>عملیات</th></tr></thead><tbody>{filteredAdminMissions.map((m)=><tr key={m.id} className={m.completedAt ? "clickable-mission-row" : ""} onClick={()=>m.completedAt&&openMissionTrace(m)}><td><b>{m.title}</b><small>{m.destinationName || m.description || "مقصد هنگام انجام ثبت می‌شود"}{Number(m.attemptCount ?? 0)>0?` · ${Number(m.attemptCount).toLocaleString("fa-IR")} مراجعه`:""}</small></td><td><span className="mini-user blue">{m.employeeName?.slice(0,2) ?? "—"}</span>{m.employeeName ?? "کاربر"}</td><td>{m.source === "employee" ? "کارمند" : adminRole === "supervisor" ? "سرپرست" : "مدیر"}</td><td className="mission-created-at"><b>{formatPersianDateTime(m.createdAt)}</b><small>ثبت خودکار سرور</small></td><td>{m.deadline || "بدون مهلت"}</td><td><span className={`status ${m.status === "open" || m.status === "revision" ? "open" : m.status === "in_progress" ? "running" : ["pending","pending_approval"].includes(m.status) ? "pending" : ["follow_up","follow_up_pending"].includes(m.status) ? "follow-up" : "done"}`}>{m.status === "open" ? "باز" : m.status === "in_progress" ? "در حال انجام" : ["pending","pending_approval"].includes(m.status) ? "منتظر تأیید" : m.status === "follow_up_pending" ? "پیگیری مجدد · منتظر بررسی" : m.status === "follow_up" ? "پیگیری مجدد" : m.status === "approved" ? "انجام‌شده" : m.status === "revision" ? "نیازمند اصلاح" : m.status === "rejected" ? "ردشده" : "انجام‌شده"}</span></td><td>{["pending","pending_approval","follow_up_pending"].includes(m.status) ? <span className="score-pending">Pending</span> : Number(m.scoreConfirmed) > 0 ? `+${Number(m.scoreConfirmed).toLocaleString("fa-IR")}` : "—"}</td><td>{m.status === "open" ? <div className="mission-row-actions"><button className="edit" onClick={event=>{event.stopPropagation();openMissionForm(m)}}><Icon>✎</Icon> ویرایش</button><button className="delete" onClick={event=>{event.stopPropagation();deleteMission(m)}}><Icon>×</Icon> حذف</button></div> : m.completedAt ? <button className="mission-trace-action" onClick={event=>{event.stopPropagation();openMissionTrace(m)}}><Icon>⌖</Icon> بررسی مراجعه ثبت‌شده</button> : <span className="mission-locked"><Icon>▣</Icon> قفل‌شده پس از شروع</span>}</td></tr>)}</tbody></table> : <div className="empty-state"><span>▣</span><h3>موردی در این دسته نیست</h3><p>با تغییر وضعیت مأموریت، آن مورد به‌صورت خودکار در دسته درست نمایش داده می‌شود.</p></div>}</section>}

        {screen === "actions" && <FollowUpActionCenter onMessage={notify} onCountChange={updateFollowUpCount}/>}

        {screen === "access" && <div className="access-layout">
          <section className="panel users-panel">
            <div className="users-toolbar"><div className="filter-tabs"><button className="active">{adminRole === "supervisor" ? "زیرمجموعه من" : "همه کاربران"} <span>{adminUsers.length.toLocaleString("fa-IR")}</span></button><button>فعال <span>{adminUsers.filter(user=>user.status==="active").length.toLocaleString("fa-IR")}</span></button><button>غیرفعال <span>{adminUsers.filter(user=>user.status!=="active").length.toLocaleString("fa-IR")}</span></button></div><button>☷ فیلترها</button></div>
            <div className="access-summary"><div><span className="kpi-icon blue">♙</span><p><b>{adminUsers.length.toLocaleString("fa-IR")} کاربر</b><small>{adminRole === "supervisor" ? "کارکنان مستقیماً زیر نظر شما" : "مدیر، سرپرست و کارمند"}</small></p></div><div><span className="kpi-icon teal">✓</span><p><b>{adminUsers.filter(user=>user.status==="active").length.toLocaleString("fa-IR")} حساب فعال</b><small>آماده دریافت مأموریت</small></p></div><div><span className="kpi-icon amber">◷</span><p><b>{adminUsers.filter(user=>!user.lastLoginAt).length.toLocaleString("fa-IR")} ورود اولیه</b><small>هنوز وارد سامانه نشده‌اند</small></p></div></div>
            <table className="users-table"><thead><tr><th>کاربر</th><th>نقش</th><th>سرپرست</th><th>نام کاربری</th><th>آخرین ورود</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>
              {adminUsers.map((u)=>{const protectedAccount=u.id===adminUserId||u.role==="owner";return <tr key={u.id}><td><span className="mini-user blue">{u.fullName.slice(0,2)}</span><b>{u.fullName}</b></td><td><span className={`role-badge ${u.role === "supervisor" ? "supervisor" : u.role === "admin" || u.role === "owner" ? "admin" : "employee"}`}>{u.role === "owner" ? "مالک" : u.role === "admin" ? "مدیر" : u.role === "supervisor" ? "سرپرست" : "کارمند"}</span></td><td>{u.supervisorName ?? "—"}</td><td className="ltr-cell">{u.username}</td><td>{u.lastLoginAt ? formatPersianDateTime(u.lastLoginAt) : "هنوز وارد نشده"}</td><td><span className={`account-active ${u.status !== "active" ? "disabled" : ""}`}><i />{u.status === "active" ? "فعال" : "غیرفعال"}</span></td><td>{adminRole === "supervisor" ? <span className="read-only-action">فقط مشاهده</span> : u.role === "owner" ? <span className="read-only-action">حساب محافظت‌شده</span> : <div className="user-row-actions"><button className="edit" onClick={()=>openEditUser(u)}>✎ ویرایش / رمز</button><button className={u.status === "active" ? "disable" : "activate"} disabled={protectedAccount} title={protectedAccount ? "وضعیت حساب جاری از اینجا تغییر نمی‌کند" : ""} onClick={()=>toggleUserStatus(u)}>{u.status === "active" ? "◉ غیرفعال" : "✓ فعال‌سازی"}</button><button className="delete" disabled={protectedAccount} title={protectedAccount ? "حساب جاری یا مالک قابل حذف نیست" : ""} onClick={()=>deleteUser(u)}>× حذف</button></div>}</td></tr>})}
            </tbody></table>
          </section>

          {accessStage !== "list" && <aside className="panel access-drawer">
            {accessStage !== "issued" ? <form onSubmit={saveAccess}>
              <div className="drawer-head"><div><h2>{accessStage === "edit" ? "ویرایش کاربر و دسترسی" : `ساخت دسترسی ${accessRole === "admin" ? "مدیر" : accessRole === "supervisor" ? "سرپرست" : "کارمند"}`}</h2><p>{accessStage === "edit" ? "نام کاربری، نقش، سرپرست، وضعیت و رمز را مدیریت کنید." : "حساب بلافاصله آماده تحویل می‌شود."}</p></div><button type="button" onClick={()=>setAccessStage("list")}>×</button></div>
              <div className="security-note"><Icon>◇</Icon><p><b>{accessStage === "edit" ? "تغییر رمز، ورودهای قبلی را می‌بندد" : "رمز فقط یک‌بار نمایش داده می‌شود"}</b><small>{accessStage === "edit" ? "اگر رمز فعلی باید حفظ شود، کادر رمز جدید را خالی بگذارید." : "کاربر باید در اولین ورود آن را تغییر دهد."}</small></p></div>
              <label>نام و نام خانوادگی <b>*</b><input value={employeeName} onChange={e=>setEmployeeName(e.target.value)} required /></label>
              <label>شماره موبایل <b>*</b><input value={employeeMobile} onChange={e=>setEmployeeMobile(e.target.value)} inputMode="tel" required /></label>
              <div className={`drawer-fields ${accessRole !== "employee" ? "single" : ""}`}><label>نقش <b>*</b><select value={accessRole} disabled={accessStage === "edit" && accessEditingId === adminUserId} onChange={e=>{const nextRole=e.target.value as "admin"|"supervisor"|"employee";setAccessRole(nextRole);setAccessSupervisorId(nextRole === "employee" ? adminUsers.find(user=>user.role==="supervisor"&&user.status==="active")?.id ?? "" : "")}}><option value="employee">کارمند</option><option value="supervisor">سرپرست</option><option value="admin">مدیر</option></select></label>{accessRole === "employee" && <label>سرپرست <b>*</b><select value={accessSupervisorId} onChange={e=>setAccessSupervisorId(e.target.value)} required><option value="">انتخاب سرپرست...</option>{adminUsers.filter(user=>user.role==="supervisor"&&user.status==="active").map(user=><option key={user.id} value={user.id}>{user.fullName}</option>)}</select></label>}</div>
              <label>نام کاربری <b>*</b><input className="ltr-input" value={employeeUsername} onChange={e=>setEmployeeUsername(e.target.value)} required /></label>
              <label>{accessStage === "edit" ? "رمز عبور جدید (اختیاری)" : <>رمز موقت <b>*</b></>}<div className="password-generator"><input className="ltr-input" value={temporaryPassword} onChange={e=>setTemporaryPassword(e.target.value)} required={accessStage === "create"} placeholder={accessStage === "edit" ? "برای حفظ رمز فعلی خالی بگذارید" : "حداقل ۸ کاراکتر"} /><button type="button" onClick={()=>setTemporaryPassword(`Rahkar@${Math.floor(1000+Math.random()*9000)}`)}>↻ تولید رمز</button></div></label>
              {accessStage === "edit" && <label>وضعیت حساب <b>*</b><select value={accessStatus} onChange={e=>setAccessStatus(e.target.value as "active"|"disabled")} disabled={accessEditingId===adminUserId}><option value="active">فعال و مجاز به ورود</option><option value="disabled">غیرفعال و مسدود</option></select>{accessEditingId===adminUserId && <small className="field-help">برای امنیت، حسابی که اکنون با آن وارد شده‌اید از همین فرم غیرفعال نمی‌شود.</small>}</label>}
              <div className="drawer-check"><input id="force-password-change" aria-label="اجبار به تغییر رمز در اولین ورود" type="checkbox" defaultChecked disabled /><span><b>تغییر رمز در اولین ورود اجباری است</b><small>پس از ساخت یا بازنشانی رمز، کاربر باید رمز شخصی خودش را تعیین کند.</small></span></div>
              <div className="drawer-actions"><button type="button" onClick={()=>setAccessStage("list")}>انصراف</button><button className="primary" type="submit" disabled={accessSubmitting}>{accessSubmitting ? "در حال ذخیره..." : accessStage === "edit" ? "ذخیره تغییرات" : "ساخت دسترسی"}</button></div>
            </form> : <div className="issued-access">
              <span className="issued-check">✓</span><h2>دسترسی ساخته شد</h2><p>این اطلاعات را امن و مستقیم به کاربر تحویل دهید.</p>
              <div className="employee-issued"><span className="avatar large blue">ا‌ک</span><div><b>{employeeName}</b><small>{accessRole === "admin" ? "مدیر · بدون سرپرست" : accessRole === "supervisor" ? "سرپرست · بدون سرپرست" : `کارمند · زیر نظر ${adminUsers.find(user=>user.id===accessSupervisorId)?.fullName ?? "سرپرست انتخاب‌شده"}`}</small></div></div>
              <div className="credential-box"><span><small>نام کاربری</small><b>{employeeUsername}</b></span><button onClick={async()=>{await navigator.clipboard.writeText(employeeUsername);notify("نام کاربری کپی شد")}}>□ کپی</button><span><small>رمز موقت</small><b>{temporaryPassword}</b></span><button onClick={async()=>{await navigator.clipboard.writeText(temporaryPassword);notify("رمز موقت کپی شد")}}>□ کپی</button></div>
              <div className="expiry-note"><Icon>◷</Icon><p><b>رمز موقت تا اولین ورود معتبر است</b><small>پس از تغییر رمز، رمز موقت دیگر قابل استفاده نیست.</small></p></div>
              <button className="primary-wide" onClick={()=>{setAccessStage("list");notify("دسترسی به فهرست کاربران اضافه شد")}}>تمام شد</button>
            </div>}
          </aside>}
        </div>}

        {screen === "approvals" && <div className="approval-layout"><section className="panel approval-queue"><div className="filter-tabs"><button className={approvalFilter==="pending"?"active":""} onClick={()=>setApprovalFilter("pending")}>در انتظار <span>{approvalItems.length}</span></button><button className={approvalFilter==="done"?"active":""} onClick={()=>setApprovalFilter("done")}>بررسی‌شده</button></div>{approvalFilter === "pending" ? <div className="approval-items">{approvalItems.length ? approvalItems.map((item,index)=><button key={item.id} className={index===0?"active":""}><span className="avatar blue">{item.employeeName.slice(0,2)}</span><span><b>{item.employeeName}</b><small>{item.title}</small><em>ثبت‌شده در سرور</em></span><i>مأموریت خودساخته</i></button>) : <div className="empty-state"><span>✓</span><h3>صف تأیید خالی است</h3><p>مأموریت‌های خودساخته پس از پایان اینجا دیده می‌شوند.</p></div>}</div> : <div className="empty-state"><span>✓</span><h3>تصمیم‌ها در Audit Log ثبت می‌شوند</h3><p>تاریخچه بررسی در Backend نگهداری می‌شود.</p></div>}</section>
          {approvalItems[0] ? <section className="panel approval-review"><div className="review-head"><div><span className="avatar large blue">{approvalItems[0].employeeName.slice(0,2)}</span><span><h2>{approvalItems[0].title}</h2><p>{approvalItems[0].employeeName} · ایجادشده توسط کارمند</p></span></div><span className="tag amber">منتظر تأیید</span></div><div className="review-stats"><span><small>وضعیت</small><b>Pending</b></span><span><small>هزینه</small><b>{approvalItems[0].expenseAmount.toLocaleString("fa-IR")}</b></span><span><small>نتیجه</small><b>{approvalItems[0].result}</b></span><span><small>امتیاز پیشنهادی</small><b>+{approvalItems[0].scorePending}</b></span></div><div className="review-section"><h3>نتیجه گزارش‌شده</h3><span className="result-badge">✓ {approvalItems[0].result}</span><p>{approvalItems[0].report}</p></div><div className="review-section"><h3>مقصد ثبت‌شده</h3><div className="mini-map"><i/><span>{approvalItems[0].destinationName || "بدون نام مقصد"}</span><small>اطلاعات مقصد از گزارش همان مأموریت خوانده شده است.</small></div></div><div className="review-actions"><button className="reject" onClick={()=>decideApproval("rejected")}>رد گزارش</button><button className="revise" onClick={()=>decideApproval("revision")}>بازگشت برای اصلاح</button><button className="approve" onClick={()=>decideApproval("approved")}>✓ تأیید مأموریت</button></div></section> : <section className="panel approval-review empty-state"><span>✓</span><h3>موردی برای بررسی نیست</h3><p>با پایان یک مأموریت خودساخته، جزئیات آن اینجا نمایش داده می‌شود.</p></section>}</div>}

        {screen === "integrity" && <div className="integrity-layout"><div className="kpi-grid compact"><div className="kpi"><span className="kpi-icon red">◇</span><span><small>هشدار باز</small><b>{integrityEvents.filter(event=>event.status==="open").length.toLocaleString("fa-IR")}</b></span></div><div className="kpi"><span className="kpi-icon amber">⌖</span><span><small>GPS / خوداظهاری</small><b>{integrityEvents.filter(event=>["gps_gap","gps_permission_denied","self_reported_work_start"].includes(event.type)).length.toLocaleString("fa-IR")}</b></span></div><div className="kpi"><span className="kpi-icon teal">✓</span><span><small>رویداد بررسی‌شده</small><b>{integrityEvents.filter(event=>event.status!=="open").length.toLocaleString("fa-IR")}</b></span></div></div><section className="panel integrity-panel"><div className="panel-head"><div><h2>رویدادهای واقعی نیازمند بررسی</h2><p>تصمیم شما در گزارش ممیزی ثبت می‌شود</p></div><button onClick={()=>loadAdminData("integrity").catch(error=>notify(error.message))}>↻ به‌روزرسانی</button></div>{integrityEvents.length ? integrityEvents.map(event=><div key={event.id} className={`alert-card ${event.severity === "high" ? "critical" : "warning-card"}`}><span className="alert-icon">{event.type === "self_reported_work_start" ? "−۳" : event.severity === "high" ? "!" : event.type === "mission_completed_without_start" ? "−۳" : "⌖"}</span><div><div><b>{event.type === "gps_gap" ? "وقفه در ثبت GPS" : event.type === "gps_permission_denied" ? "مجوز GPS مسدود شده" : event.type === "low_accuracy" ? "دقت پایین موقعیت" : event.type === "mission_completed_without_start" ? "پایان مأموریت بدون ثبت شروع کار" : event.type === "self_reported_work_start" ? "خوداظهاری شروع فعالیت ثبت‌نشده" : "قطع ارتباط دستگاه"}</b><span>{event.severity === "high" ? "اهمیت بالا" : "اهمیت متوسط"}</span></div><p>{event.employeeName} · {new Date(event.occurredAt).toLocaleString("fa-IR")}</p><small>{event.type === "gps_gap" ? `مدت وقفه: ${String(event.details.gapMinutes ?? "—")} دقیقه` : event.type === "mission_completed_without_start" ? `مأموریت: ${String(event.details.missionId ?? "—")} · کسر امتیاز: ${String(event.details.scorePenalty ?? 3)}` : event.type === "self_reported_work_start" ? `${formatPersianDateTime(String(event.details.claimedStart))} تا ${formatPersianDateTime(String(event.details.claimedEnd))} · ${String(event.details.claimedMinutes ?? "—")} دقیقه · کسر ${String(event.details.scorePenalty ?? 3)} امتیاز · علت: ${String(event.details.reason ?? "—")}` : `جزئیات ثبت‌شده: ${JSON.stringify(event.details)}`}</small></div>{event.status === "open" ? event.type === "self_reported_work_start" ? <div className="integrity-decision-actions"><button className="approve" onClick={()=>reviewIntegrity(event,"resolved")}>تأیید زمان</button><button className="reject" onClick={()=>reviewIntegrity(event,"dismissed")}>رد زمان</button></div> : <button onClick={()=>reviewIntegrity(event)}>ثبت بررسی</button> : <button disabled>بررسی‌شده</button>}</div>) : <div className="empty-state"><span>✓</span><h3>هشدار بازی وجود ندارد</h3><p>وقفه GPS، مجوز مسدود، دقت نامناسب، خوداظهاری یا پایان مأموریت بدون شروع اینجا ثبت می‌شود.</p></div>}</section></div>}

        {screen === "reports" && <AdminPerformanceReports rows={reportRows} destinations={reportDestinations} period={adminReportPeriod} onPeriodChange={setAdminReportPeriod} policy={reportPolicy} />}
        {screen === "notifications" && <section className="admin-settings-layout"><NotificationCenter onOpenMissions={()=>setScreen("missions")} onOpenFollowUps={()=>setScreen("actions")} onCounts={setAdminNotificationCounts}/></section>}
        {screen === "account" && <div className="admin-settings-layout"><AccountSettings initialFullName={adminDisplayName} initialUsername={adminUsername} onSaved={user=>{setAdminDisplayName(user.fullName);setAdminUsername(user.username)}} onMessage={notify}/><NotificationSettings onMessage={notify}/></div>}
      </div>
      {missionFormOpen && <div className="mission-modal-backdrop">
        <section className="mission-modal panel" role="dialog" aria-modal="true" aria-labelledby="new-admin-mission-title">
          <form onSubmit={createAdminMission}>
            <div className="drawer-head"><div><h2 id="new-admin-mission-title">{missionEditingId ? "ویرایش مأموریت" : "مأموریت جدید"}</h2><p>{missionEditingId ? "تا قبل از شروع کارمند می‌توانید جزئیات مأموریت را تغییر دهید." : adminRole === "supervisor" ? "مأموریت را به یکی از کاربران زیرمجموعه خود تخصیص دهید." : "مأموریت را ثبت و به کاربر موردنظر ارجاع دهید."}</p></div><button type="button" aria-label="بستن فرم" onClick={()=>{setMissionFormOpen(false);setMissionEditingId(null)}}>×</button></div>
            <label>عنوان مأموریت <b>*</b><input value={missionTitle} onChange={e=>setMissionTitle(e.target.value)} placeholder="مثلاً: تحویل اسناد قرارداد" required /></label>
            <label>مسئول مأموریت <b>*</b><select value={missionAssignee} onChange={e=>setMissionAssignee(e.target.value)} required disabled={!adminUsers.some(user=>user.status==="active" && (adminRole!=="supervisor" || user.role==="employee"))}><option value="">انتخاب کاربر...</option>{adminUsers.filter(user=>user.status==="active" && (adminRole!=="supervisor" || user.role==="employee")).map(user=><option key={user.id} value={user.id}>{user.fullName} · {user.role === "employee" ? "کارمند" : user.role === "supervisor" ? "سرپرست" : user.role === "admin" ? "مدیر" : "مالک"}</option>)}</select></label>
            {adminRole === "supervisor" && <div className="assignment-rule"><Icon>✓</Icon><span><b>محدوده تخصیص سرپرست</b><small>فقط کارکنانی نمایش داده می‌شوند که مستقیماً زیر نظر شما هستند.</small></span></div>}
            {!adminUsers.some(user=>user.status==="active" && (adminRole!=="supervisor" || user.role==="employee")) && <div className="mission-form-error">کاربر فعالی برای تخصیص مأموریت پیدا نشد.</div>}
            <div className="mission-form-grid"><label>اولویت<select value={missionPriority} onChange={e=>setMissionPriority(e.target.value)}><option value="normal">عادی</option><option value="urgent">فوری</option><option value="low">کم</option></select></label><label>تاریخ شمسی مهلت <small>اختیاری</small><input value={missionDeadlineDate} onChange={e=>setMissionDeadlineDate(e.target.value)} inputMode="numeric" placeholder="مثلاً: ۱۴۰۵/۰۵/۲۷" aria-describedby="jalali-deadline-help" /></label><label>ساعت مهلت <small>اختیاری</small><input value={missionDeadlineTime} onChange={e=>setMissionDeadlineTime(e.target.value)} inputMode="numeric" placeholder="مثلاً: ۱۴:۳۰" aria-describedby="jalali-deadline-help" /></label></div>
            <p id="jalali-deadline-help" className="deadline-help">تاریخ را به‌صورت شمسی وارد کنید؛ اگر مهلت تعیین می‌کنید، تاریخ و ساعت را با هم بنویسید.</p>
            <label>نام یا آدرس مقصد <small>اختیاری</small><input value={missionDestination} onChange={e=>setMissionDestination(e.target.value)} placeholder="مثلاً: بانک رفاه، خیابان ولیعصر" /></label>
            <label>توضیحات مأموریت <small>اختیاری</small><textarea value={missionDescription} onChange={e=>setMissionDescription(e.target.value)} placeholder="توضیحات و جزئیات لازم برای انجام مأموریت را بنویسید..." /></label>
            <div className="server-time-note"><Icon>◷</Icon><span><b>تاریخ و ساعت ثبت خودکار است</b><small>هم‌زمان با ثبت مأموریت، زمان دقیق سرور ذخیره می‌شود و قابل تغییر نیست.</small></span></div>
            <div className="drawer-actions"><button type="button" onClick={()=>{setMissionFormOpen(false);setMissionEditingId(null)}} disabled={missionSubmitting}>انصراف</button><button className="primary" type="submit" disabled={missionSubmitting || !missionAssignee}>{missionSubmitting ? "در حال ثبت..." : missionEditingId ? "ذخیره تغییرات" : "ثبت و تخصیص مأموریت"}</button></div>
          </form>
        </section>
      </div>}
      {missionTraceOpen && <div className="mission-modal-backdrop mission-trace-backdrop">
        <section className="panel mission-trace-modal" role="dialog" aria-modal="true" aria-labelledby="mission-trace-title">
          <div className="drawer-head"><div><h2 id="mission-trace-title">بررسی مکانی مأموریت</h2><p>سه نقطه شروع کار، مقصد و پایان برای ارزیابی عملکرد</p></div><button type="button" aria-label="بستن بررسی مأموریت" onClick={()=>setMissionTraceOpen(false)}>×</button></div>
          {missionTraceLoading && <div className="trace-loading"><span>⌖</span><b>در حال دریافت نقاط واقعی مأموریت...</b></div>}
          {missionTrace && <>
            <div className="trace-mission-head"><div><span className="avatar large blue">{missionTrace.mission.employeeName.slice(0,2)}</span><span><h3>{missionTrace.mission.title}</h3><p>{missionTrace.mission.employeeName} · {missionTrace.mission.result ?? "نتیجه ثبت‌شده"}</p></span></div><span className={`trace-confidence ${missionTrace.evaluation.confidence}`}>{missionTrace.evaluation.confidence === "high" ? "اطمینان مکانی بالا" : missionTrace.evaluation.confidence === "medium" ? "نیازمند بررسی" : "اطلاعات ناقص"}</span></div>
            <div className="trace-map"><OperationsMap currentLocations={[]} destinations={[]} tracePoints={missionTracePoints} /></div>
            <div className="trace-point-cards">
              <div className={`start ${missionTrace.points.start ? "available" : "missing"}`}><i>شروع</i><span><b>نقطه شروع کار</b><small>{missionTrace.points.start ? `${formatPersianDateTime(missionTrace.points.start.recordedAt)} · دقت ${Math.round(missionTrace.points.start.accuracy).toLocaleString("fa-IR")} متر` : "شروع کار یا موقعیت آن ثبت نشده است"}</small>{missionTrace.points.start?.source === "nearest_gps" && <em>برآورد از نزدیک‌ترین GPS</em>}</span></div>
              <div className={`destination ${missionTrace.points.destination ? "available" : "missing"}`}><i>مقصد</i><span><b>{missionTrace.points.destination?.destinationName ?? "نقطه مقصد ثبت نشده"}</b><small>{missionTrace.points.destination ? `${formatPersianDateTime(missionTrace.points.destination.recordedAt)} · دقت ${Math.round(missionTrace.points.destination.accuracy).toLocaleString("fa-IR")} متر` : "مختصات مقصد موجود نیست"}</small></span></div>
              <div className={`end ${missionTrace.points.end ? "available" : "missing"}`}><i>پایان</i><span><b>نقطه پایان کار</b><small>{missionTrace.points.end ? `${formatPersianDateTime(missionTrace.points.end.recordedAt)} · دقت ${Math.round(missionTrace.points.end.accuracy).toLocaleString("fa-IR")} متر` : "موقعیت پایان مأموریت ثبت نشده است"}</small>{missionTrace.points.end?.source === "nearest_gps" && <em>برآورد از نزدیک‌ترین GPS</em>}</span></div>
            </div>
            <div className="trace-evaluation-grid"><section><h3>فاصله و زمان</h3><div><span><small>شروع تا مقصد</small><b>{missionTrace.metrics.startToDestinationMeters == null ? "—" : `${missionTrace.metrics.startToDestinationMeters.toLocaleString("fa-IR")} متر`}</b></span><span><small>مقصد تا پایان</small><b>{missionTrace.metrics.destinationToEndMeters == null ? "—" : `${missionTrace.metrics.destinationToEndMeters.toLocaleString("fa-IR")} متر`}</b></span><span><small>زمان کل مأموریت</small><b>{missionTrace.metrics.totalElapsedMinutes == null ? "بدون شروع" : formatMinutes(missionTrace.metrics.totalElapsedMinutes)}</b></span></div></section><section><h3>وضعیت امتیاز</h3><div><span><small>امتیاز قطعی</small><b>{missionTrace.mission.scoreConfirmed.toLocaleString("fa-IR")}</b></span><span><small>در انتظار تأیید</small><b>{missionTrace.mission.scorePending.toLocaleString("fa-IR")}</b></span><span><small>کسر ثبت‌شده</small><b>{missionTrace.mission.scorePenalty.toLocaleString("fa-IR")}</b></span></div></section></div>
            <section className="trace-score-hints"><h3>موارد مؤثر در ارزیابی و نمره</h3>{missionTrace.evaluation.scoreHints.map((hint,index)=><p key={index}><Icon>{missionTrace.evaluation.confidence === "high" ? "✓" : "!"}</Icon>{hint}</p>)}</section>
            {["pending","pending_approval","approved","completed"].includes(missionTrace.mission.status) ? <section className="trace-score-form"><div><h3>ثبت نمره مدیر یا سرپرست</h3><p>بر اساس سه نقطه، دقت GPS و گزارش کارمند، نمره نهایی را در مقیاس فعلی سامانه ثبت کنید.</p></div><label>نمره از ۱۲<input type="number" min="0" max="12" step="1" inputMode="numeric" value={missionTraceScore} onChange={event=>setMissionTraceScore(event.target.value)} /></label><label>دلیل ارزیابی <b>*</b><textarea value={missionTraceScoreNote} onChange={event=>setMissionTraceScoreNote(event.target.value)} placeholder="مثلاً: هر سه نقطه صحیح است و پایان کار در محدوده مقصد ثبت شده..." /></label><button type="button" onClick={saveMissionTraceScore} disabled={missionTraceScoreSaving}>{missionTraceScoreSaving ? "در حال ثبت..." : "ثبت ارزیابی و نمره"}</button></section> : <div className="trace-score-locked">این مأموریت رد شده یا برای اصلاح برگشته است؛ تا ثبت مجدد نتیجه، امتیاز جدیدی برای آن قطعی نمی‌شود.</div>}
            {missionTrace.mission.report && <section className="trace-report"><h3>گزارش ثبت‌شده کارمند</h3><p>{missionTrace.mission.report}</p></section>}
            <div className="drawer-actions"><button className="primary" type="button" onClick={()=>setMissionTraceOpen(false)}>بستن بررسی مأموریت</button></div>
          </>}
        </section>
      </div>}
      {toast && <div className="admin-toast"><Icon>✓</Icon>{toast}</div>}
    </section>
  </main>;
}

export default function Home() {
  const [mode, setMode] = useState<PanelMode>("employee");
  const [navigationReady, setNavigationReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      const url = new URL(window.location.href);
      const requested = url.searchParams.get("panel");
      const stored = sessionStorage.getItem(PANEL_STORAGE_KEY);
      if (isPanelMode(requested) || isPanelMode(stored)) {
        if (!cancelled) { setMode(isPanelMode(requested) ? requested : stored as PanelMode); setNavigationReady(true); }
        return;
      }
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store", credentials: "same-origin" });
        const body = await response.json() as { user?: { role?: string } };
        const restoredMode: PanelMode = response.ok && ["owner", "admin", "supervisor"].includes(body.user?.role ?? "") ? "admin" : "employee";
        if (!cancelled) setMode(restoredMode);
      } catch { /* The login screen remains available while offline. */ }
      if (!cancelled) setNavigationReady(true);
    };
    void restore();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (navigationReady) persistNavigation(mode);
  }, [mode, navigationReady]);

  if (!navigationReady) return <div className="prototype app-navigation-loading" dir="rtl"><AppVersionGuard /><div className="navigation-loading-card"><span className="brand-mark">ر</span><b>در حال بازگردانی صفحه شما…</b></div></div>;
  return <div className="prototype"><AppVersionGuard /><TopSwitcher mode={mode} setMode={setMode} />{mode === "employee" ? <EmployeeApp /> : <AdminPanel />}</div>;
}
