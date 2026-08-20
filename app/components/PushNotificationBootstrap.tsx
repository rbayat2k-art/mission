"use client";

import { useCallback, useEffect, useState } from "react";
import { ensurePushDevice, getPushDeviceState, type PushDeviceState } from "../../lib/push-client";

type SettingsResponse = { enabled: boolean; configured: boolean; publicKey: string };

export default function PushNotificationBootstrap({ active, onMessage }: { active: boolean; onMessage: (message: string) => void }) {
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
    if (!active) return;
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
  }, [active, registerGrantedDevice]);

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

  if (!active || dismissed || !settings?.enabled || state === "subscribed" || state === "unsupported") return null;
  return <aside className={`push-permission-banner ${state === "denied" ? "blocked" : ""}`} role="status">
    <span aria-hidden="true">♧</span>
    <div><b>{state === "denied" ? "اعلان ویندوز در مرورگر مسدود است" : "اعلان فوری درخواست‌های کارمند را فعال کنید"}</b><small>{state === "denied" ? "در تنظیمات سایت taprasystem.ir، گزینه Notifications را روی Allow بگذارید." : "پس از فعال‌سازی، ارجاع و پیام جدید حتی بیرون از این صفحه در سمت راست ویندوز نمایش داده می‌شود."}</small></div>
    {state !== "denied" && <button type="button" onClick={activate} disabled={busy}>{busy ? "در حال فعال‌سازی…" : "فعال‌سازی اعلان ویندوز"}</button>}
    <button type="button" className="dismiss" aria-label="بستن پیام" onClick={() => setDismissed(true)}>×</button>
  </aside>;
}
