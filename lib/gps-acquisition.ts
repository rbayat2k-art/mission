import { validateTrustedLocation, type CapturedMissionLocation } from "./mission-location";

export const GPS_ACQUISITION_TIMEOUT_MS = 25_000;
export type GpsFailure = "PERMISSION_DENIED" | "PRECISE_REQUIRED" | "LOCATION_DISABLED" | "INSECURE_ORIGIN" | "POSITION_UNAVAILABLE" | "TIMEOUT" | "STALE" | "LOW_ACCURACY" | "UNKNOWN_ERROR" | "CANCELLED";
export type GpsPhase = "ACQUIRING" | "WAITING_FRESH" | "WAITING_ACCURACY" | "READY" | GpsFailure;
export type GpsProgress = { phase: GpsPhase; accuracy: number | null };
export type GpsPreflightBridge = {
  isNativeApp: () => boolean;
  isLocationPermissionGranted: () => boolean;
  isPreciseLocationPermissionGranted?: () => boolean;
  getLocationServiceState?: () => string;
};
export type GpsDiagnostic = {
  source: "web"; nativeApp: boolean; secureContext: boolean; permissionAny: boolean | null;
  permissionPrecise: boolean | null; locationServiceState: "enabled" | "disabled" | "unknown";
  callback: "success" | "error" | "none"; errorCode: number | null;
  accuracy: number | null; ageMs: number | null; acquisitionElapsedMs: number; finalReason: GpsPhase;
};

export function gpsProgressMessage(progress: GpsProgress) {
  switch (progress.phase) {
    case "ACQUIRING": return "در حال دریافت موقعیت دقیق؛ حداکثر ۲۵ ثانیه منتظر بمانید.";
    case "WAITING_FRESH": return "موقعیت قبلی قدیمی است؛ در حال دریافت موقعیت جدید…";
    case "WAITING_ACCURACY": return `موقعیت دریافت شد، دقت فعلی ${progress.accuracy?.toLocaleString("fa-IR")} متر است؛ برای شروع فعالیت باید دقت به ۱۰۰ متر یا کمتر برسد.`;
    case "READY": return "موقعیت تازه و دقیق دریافت شد.";
    case "PERMISSION_DENIED": return "مجوز موقعیت مسدود است؛ در تنظیمات برنامه یا مرورگر، دسترسی Location را فعال کنید و دوباره تلاش کنید.";
    case "PRECISE_REQUIRED": return "برای شروع فعالیت، موقعیت دقیق (Precise Location) را فعال کنید و دوباره تلاش کنید.";
    case "LOCATION_DISABLED": return "موقعیت مکانی گوشی خاموش است؛ آن را روشن کنید و دوباره تلاش کنید.";
    case "INSECURE_ORIGIN": return "موقعیت‌یابی در این محیط آزمایشی پشتیبانی نمی‌شود؛ برنامه باید با نشانی امن HTTPS باز شود.";
    case "POSITION_UNAVAILABLE": return "سرویس مکان‌یابی موقعیت را در دسترس قرار نداد؛ روشن‌بودن Location و دسترسی به فضای باز را بررسی و دوباره تلاش کنید.";
    case "TIMEOUT": return "در مهلت تعیین‌شده موقعیت تازه دریافت نشد؛ Location گوشی را بررسی کنید و دوباره تلاش کنید.";
    case "STALE": return "فقط موقعیت قدیمی یا با زمان نامعتبر دریافت شد؛ ساعت خودکار و Location گوشی را بررسی و دوباره تلاش کنید.";
    case "LOW_ACCURACY": return "در مهلت تعیین‌شده دقت GPS به ۱۰۰ متر نرسید؛ موقعیت دقیق را فعال کنید و در فضای باز دوباره تلاش کنید.";
    case "CANCELLED": return "دریافت موقعیت متوقف شد؛ دوباره تلاش کنید.";
    default: return "دریافت موقعیت با خطا روبه‌رو شد؛ دوباره تلاش کنید.";
  }
}

export class GpsAcquisitionError extends Error {
  constructor(public readonly reason: GpsFailure) {
    super(gpsProgressMessage({ phase: reason, accuracy: null }));
    this.name = "GpsAcquisitionError";
  }
}

/** Owns one watch. Cleanup and observers can never prevent settlement. No raw fix is logged. */
export function createGpsAcquisition(options: {
  geolocation?: Pick<Geolocation, "watchPosition" | "clearWatch">;
  secureContext: boolean; protocol: string; bridge?: GpsPreflightBridge;
  onProgress?: (progress: GpsProgress) => void; onDiagnostic?: (event: GpsDiagnostic) => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const started = now();
  const deadline = started + GPS_ACQUISITION_TIMEOUT_MS;
  let settled = false;
  let watchId: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastIssue: GpsFailure = "TIMEOUT";
  const diagnostic: Omit<GpsDiagnostic, "acquisitionElapsedMs" | "finalReason"> = {
    source: "web", nativeApp: false, secureContext: options.secureContext,
    permissionAny: null, permissionPrecise: null, locationServiceState: "unknown",
    callback: "none", errorCode: null, accuracy: null, ageMs: null,
  };
  let resolve!: (location: CapturedMissionLocation) => void;
  let reject!: (error: GpsAcquisitionError) => void;
  const promise = new Promise<CapturedMissionLocation>((yes, no) => { resolve = yes; reject = no; });
  const emit = (phase: GpsPhase) => {
    try { options.onProgress?.({ phase, accuracy: diagnostic.accuracy }); } catch { /* Observer is not part of settlement. */ }
    try { options.onDiagnostic?.({ ...diagnostic, acquisitionElapsedMs: Math.max(0, now() - started), finalReason: phase }); } catch { /* Diagnostics must never block GPS. */ }
  };
  const clearWatch = () => {
    if (watchId === undefined) return;
    const id = watchId;
    watchId = undefined;
    try { options.geolocation?.clearWatch(id); } catch { /* Ignore late callbacks even if a broken WebView cannot clear its watch. */ }
  };
  const finish = (reason: GpsPhase, location?: CapturedMissionLocation) => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    clearWatch();
    emit(reason);
    if (location) resolve(location);
    else reject(new GpsAcquisitionError(reason as GpsFailure));
  };
  const checkDeadline = () => {
    if (!settled && now() >= deadline) finish(lastIssue);
    return settled;
  };
  const cancel = () => finish("CANCELLED");
  try {
    diagnostic.nativeApp = options.bridge?.isNativeApp() === true;
    // Desktop loopback can be a secure context; native test builds deliberately require HTTPS.
    if (!options.secureContext || (diagnostic.nativeApp && options.protocol !== "https:")) {
      finish("INSECURE_ORIGIN");
    } else {
      if (diagnostic.nativeApp && options.bridge) {
        diagnostic.permissionAny = options.bridge.isLocationPermissionGranted();
        diagnostic.permissionPrecise = options.bridge.isPreciseLocationPermissionGranted?.() ?? null;
        const service = options.bridge.getLocationServiceState?.();
        diagnostic.locationServiceState = service === "enabled" || service === "disabled" ? service : "unknown";
      }
      if (diagnostic.permissionAny === false) finish("PERMISSION_DENIED");
      else if (diagnostic.permissionPrecise === false) finish("PRECISE_REQUIRED");
      else if (diagnostic.locationServiceState === "disabled") finish("LOCATION_DISABLED");
      else if (!options.geolocation) finish("POSITION_UNAVAILABLE");
      else {
        emit("ACQUIRING");
        // Install the deadline BEFORE watchPosition: native adapters can callback synchronously.
        timer = setTimeout(() => finish(lastIssue), GPS_ACQUISITION_TIMEOUT_MS);
        watchId = options.geolocation.watchPosition(position => {
          if (settled || checkDeadline()) return;
          diagnostic.callback = "success";
          diagnostic.errorCode = null;
          try {
            const timestamp = position.timestamp;
            const validTime = Number.isFinite(timestamp) && Math.abs(timestamp) <= 8.64e15;
            diagnostic.accuracy = Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null;
            diagnostic.ageMs = validTime ? now() - timestamp : null;
            const validation = validateTrustedLocation({
              latitude: position.coords.latitude, longitude: position.coords.longitude,
              accuracy: position.coords.accuracy, recordedAt: validTime ? new Date(timestamp).toISOString() : "",
            }, { nowMs: now(), maxAgeMs: 60_000 });
            if (validation.location) finish("READY", validation.location);
            else if (["LOCATION_STALE", "LOCATION_FUTURE_TIMESTAMP", "LOCATION_INVALID_TIMESTAMP"].includes(validation.code ?? "")) {
              lastIssue = "STALE"; emit("WAITING_FRESH");
            } else if (validation.code === "LOCATION_ACCURACY_TOO_LOW") {
              lastIssue = "LOW_ACCURACY"; emit("WAITING_ACCURACY");
            } else finish("UNKNOWN_ERROR");
          } catch { finish("UNKNOWN_ERROR"); }
        }, error => {
          if (settled || checkDeadline()) return;
          diagnostic.callback = "error";
          // Log only the standardized numeric code, never provider error.message.
          diagnostic.errorCode = [1, 2, 3].includes(error?.code) ? error.code : null;
          finish(error?.code === 1 ? "PERMISSION_DENIED" : error?.code === 2 ? "POSITION_UNAVAILABLE" : error?.code === 3 ? "TIMEOUT" : "UNKNOWN_ERROR");
        }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 });
        if (settled) clearWatch(); // Handle synchronous callback before the watch id was returned.
      }
    }
  } catch { finish("UNKNOWN_ERROR"); }
  return { promise, cancel, checkDeadline };
}
