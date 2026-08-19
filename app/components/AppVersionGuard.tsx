"use client";

import { useCallback, useEffect, useState } from "react";
import { APP_VERSION } from "../../lib/app-version";

const UPDATE_ATTEMPT_PREFIX = "rahkar-app-update:";

type VersionResponse = { version?: string };

async function requestLatestVersion(signal?: AbortSignal) {
  const response = await fetch(`/api/version?loaded=${encodeURIComponent(APP_VERSION)}&t=${Date.now()}`, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { "Cache-Control": "no-cache" },
    signal,
  });
  if (!response.ok) throw new Error("version-check-failed");
  return (await response.json() as VersionResponse).version?.trim() ?? "";
}

async function refreshApplication(targetVersion: string) {
  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations().catch(() => []);
    await Promise.all(registrations.map(registration => registration.update().catch(() => undefined)));
  }

  const target = new URL(window.location.href);
  target.searchParams.set("app_version", targetVersion);
  target.searchParams.set("refresh", Date.now().toString());
  window.location.replace(target.toString());
}

export default function AppVersionGuard() {
  const [availableVersion, setAvailableVersion] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const applyUpdate = useCallback(async (targetVersion = availableVersion) => {
    if (!targetVersion || refreshing) return;
    setRefreshing(true);
    sessionStorage.setItem(`${UPDATE_ATTEMPT_PREFIX}${targetVersion}`, "1");
    await refreshApplication(targetVersion);
  }, [availableVersion, refreshing]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    const checkForUpdate = async () => {
      try {
        const latestVersion = await requestLatestVersion(controller.signal);
        if (!active || !latestVersion) return;
        if (latestVersion === APP_VERSION) {
          sessionStorage.removeItem(`${UPDATE_ATTEMPT_PREFIX}${latestVersion}`);
          const cleanUrl = new URL(window.location.href);
          if (cleanUrl.searchParams.has("app_version") || cleanUrl.searchParams.has("refresh")) {
            cleanUrl.searchParams.delete("app_version");
            cleanUrl.searchParams.delete("refresh");
            window.history.replaceState(null, "", cleanUrl.toString());
          }
          return;
        }

        setAvailableVersion(latestVersion);
        const authResponse = await fetch("/api/auth/me", {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });

        const attemptKey = `${UPDATE_ATTEMPT_PREFIX}${latestVersion}`;
        if (authResponse.status === 401 && sessionStorage.getItem(attemptKey) !== "1") {
          sessionStorage.setItem(attemptKey, "1");
          await refreshApplication(latestVersion);
        }
      } catch {
        // Offline use must continue normally; the next online/visible check retries.
      }
    };

    void checkForUpdate();
    const timer = window.setInterval(checkForUpdate, 5 * 60_000);
    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") void checkForUpdate();
    };
    const checkWhenOnline = () => void checkForUpdate();
    document.addEventListener("visibilitychange", checkWhenVisible);
    window.addEventListener("online", checkWhenOnline);

    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", checkWhenVisible);
      window.removeEventListener("online", checkWhenOnline);
    };
  }, []);

  if (!availableVersion) return null;

  return (
    <aside className="app-update-banner" role="status" aria-live="polite">
      <div>
        <b>نسخه جدید سامانه آماده است</b>
        <span>برای دریافت آخرین اصلاحات، برنامه را در زمان مناسب به‌روزرسانی کنید. اطلاعات ثبت‌نشده شما پاک نمی‌شود.</span>
      </div>
      <small>نسخه {APP_VERSION} ← {availableVersion}</small>
      <button type="button" onClick={() => void applyUpdate()} disabled={refreshing}>
        {refreshing ? "در حال به‌روزرسانی…" : "به‌روزرسانی امن"}
      </button>
    </aside>
  );
}
