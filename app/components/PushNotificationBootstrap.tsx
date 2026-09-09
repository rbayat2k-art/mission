"use client";

import { useCallback, useEffect, useState } from "react";
import { ensurePushDevice, getPushDeviceState, type PushDeviceState } from "../../lib/push-client";

type SettingsResponse = { userId?: string; enabled: boolean; configured: boolean; publicKey: string };
type NativeNotificationBridge = {
  isNativeApp?: () => boolean;
  showNativeNotification?: (id: string, title: string, message: string, targetUrl: string) => boolean;
  showNativeNotificationForUser?: (userId: string, id: string, title: string, message: string, targetUrl: string) => boolean;
};
type NotificationItem = {
  id: string;
  title: string;
  message: string;
  entityType: string | null;
  readAt: string | null;
};

function nativeBridge() {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { TapraAndroid?: NativeNotificationBridge }).TapraAndroid;
}

function isNativeAndroid() {
  try { return nativeBridge()?.isNativeApp?.() === true; }
  catch { return false; }
}

export default function PushNotificationBootstrap({ active, userId = "", onMessage, nativeOnly = false }: { active: boolean; userId?: string; onMessage: (message: string) => void; nativeOnly?: boolean }) {
  const [state, setState] = useState<PushDeviceState>(getPushDeviceState);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const registerGrantedDevice = useCallback(async (current: SettingsResponse) => {
    if (!current.enabled || !current.configured || Notification.permission !== "granted") return;
    await ensurePushDevice(current.publicKey);
    setState("subscribed");
  }, []);

  useEffect(() => {
    if (!active || isNativeAndroid() || nativeOnly) return;
    let cancelled = false;
    fetch("/api/notifications/settings", { cache: "no-store", credentials: "same-origin" })
      .then(async response => {
        if (!response.ok) throw new Error("notification-settings-failed");
        return await response.json() as SettingsResponse;
      })
      .then(async current => {
        if (cancelled) return;
        setSettings(current);
        if (current.enabled && current.configured && typeof Notification !== "undefined" && Notification.permission === "granted") {
          await registerGrantedDevice(current);
        }
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [active, nativeOnly, registerGrantedDevice]);

  useEffect(() => {
    if (!active || !userId || !isNativeAndroid()) return;
    let cancelled = false;
    let polling = false;
    let controller: AbortController | null = null;
    const pollNativeNotifications = async () => {
      if (polling || cancelled) return;
      polling = true;
      const requestController = new AbortController();
      controller = requestController;
      const timeout = window.setTimeout(() => requestController.abort(), 15_000);
      try {
        const bridge = nativeBridge();
        if (!bridge?.showNativeNotification) return;
        const headers = { "X-Tapra-User-Id": userId };
        const settingsResponse = await fetch("/api/notifications/settings", { cache: "no-store", credentials: "same-origin", headers, signal:requestController.signal });
        if (!settingsResponse.ok) return;
        const current = await settingsResponse.json() as SettingsResponse;
        if (current.userId !== userId || !current.enabled || cancelled) return;
        const response = await fetch("/api/notifications", { cache: "no-store", credentials: "same-origin", headers, signal:requestController.signal });
        if (!response.ok || cancelled) return;
        const body = await response.json() as { userId?:string;notifications?: NotificationItem[] };
        if (cancelled || body.userId !== userId) return;
        for (const item of (body.notifications ?? []).filter(item => !item.readAt).slice(0, 5)) {
          const target = item.entityType === "follow_up_request"
            ? "https://taprasystem.ir/?panel=employee&screen=notifications"
            : "https://taprasystem.ir/?panel=employee&screen=missions";
          if (cancelled) return;
          if (bridge.showNativeNotificationForUser) bridge.showNativeNotificationForUser(userId, item.id, item.title, item.message, target);
          else bridge.showNativeNotification(item.id, item.title, item.message, target);
        }
      } catch {
        // Native polling is best-effort; the in-app notification center remains available.
      } finally { window.clearTimeout(timeout); polling = false; }
    };
    pollNativeNotifications();
    const timer = window.setInterval(pollNativeNotifications, 30_000);
    return () => {
      cancelled = true;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, [active, userId]);

  const activate = async () => {
    if (!settings?.configured) return onMessage("ارسال اعلان هنوز روی سرور تنظیم نشده است");
    if (getPushDeviceState() === "unsupported") return onMessage("این مرورگر از اعلان ویندوز پشتیبانی نمی‌کند");
    if (Notification.permission === "denied") return onMessage("اعلان این سایت در مرورگر مسدود است؛ از تنظیمات سایت آن را روی Allow بگذارید");
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      setState(permission === "granted" ? "subscribed" : permission);
      if (permission !== "granted") throw new Error("اجازه اعلان داده نشد؛ از تنظیمات مرورگر آن را فعال کنید");
      await ensurePushDevice(settings.publicKey);
      await fetch("/api/notifications/settings", { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) });
      setState("subscribed");
      onMessage("اعلان‌های ویندوز برای این سیستم فعال شد");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "فعال‌سازی اعلان ناموفق بود");
    } finally {
      setBusy(false);
    }
  };

  if (isNativeAndroid() || nativeOnly || !active || dismissed || !settings?.enabled || state === "subscribed" || state === "unsupported") return null;
  return <aside className={`push-permission-banner ${state === "denied" ? "blocked" : ""}`} role="status">
    <span aria-hidden="true">♧</span>
    <div><b>{state === "denied" ? "اعلان ویندوز در مرورگر مسدود است" : "اعلان فوری عملیات و GPS را فعال کنید"}</b><small>{state === "denied" ? "در تنظیمات سایت taprasystem.ir، گزینه Notifications را روی Allow بگذارید." : "پس از فعال‌سازی، قطع GPS، ارجاع و پیام جدید حتی بیرون از این صفحه در سمت راست ویندوز نمایش داده می‌شود."}</small></div>
    {state !== "denied" && <button type="button" onClick={activate} disabled={busy}>{busy ? "در حال فعال‌سازی…" : "فعال‌سازی اعلان ویندوز"}</button>}
    <button type="button" className="dismiss" aria-label="بستن پیام" onClick={() => setDismissed(true)}>×</button>
  </aside>;
}
