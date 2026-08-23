"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ensurePushDevice } from "../../lib/push-client";

type NativeNotificationBridge = {
  isNativeApp?: () => boolean;
  isNotificationPermissionGranted?: () => boolean;
  requestNotificationPermission?: () => void;
  openNotificationSettings?: () => void;
  showNativeNotification?: (id: string, title: string, message: string, targetUrl: string) => boolean;
};

function nativeBridge() {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { TapraAndroid?: NativeNotificationBridge }).TapraAndroid;
}

function isNativeAndroid() {
  try { return nativeBridge()?.isNativeApp?.() === true; }
  catch { return false; }
}

function showNativeActivationTest() {
  try {
    nativeBridge()?.showNativeNotification?.(
      `tapra-notification-test-${Date.now()}`,
      "اعلان‌های راهکار فعال شد",
      "از این پس مأموریت، ارجاع و پیام جدید روی صفحه گوشی نمایش داده می‌شود.",
      "https://taprasystem.ir/?panel=employee&screen=notifications",
    );
  } catch { /* The browser version intentionally has no Android notification bridge. */ }
}

export default function NotificationSettings({
  onMessage,
  onEnabledChange,
}: {
  onMessage: (message: string) => void;
  onEnabledChange?: (enabled: boolean) => void;
}) {
  const [enabled, setEnabled] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [publicKey, setPublicKey] = useState("");
  const [nativeApp, setNativeApp] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");
  const [busy, setBusy] = useState(false);
  const nativeActivationRequested = useRef(false);

  const saveEnabled = useCallback(async (value: boolean) => {
    const response = await fetch("/api/notifications/settings", {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: value }),
    });
    if (!response.ok) throw new Error("ذخیره تنظیم اعلان ناموفق بود");
    setEnabled(value);
    onEnabledChange?.(value);
    if (!value && !isNativeAndroid() && "serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.ready.catch(() => null);
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await fetch("/api/notifications/subscriptions", {
          method: "DELETE",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }
    }
  }, [onEnabledChange]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const native = isNativeAndroid();
      setNativeApp(native);
      if (native) {
        try {
          setPermission(nativeBridge()?.isNotificationPermissionGranted?.() ? "granted" : "default");
        } catch {
          setPermission("default");
        }
      } else {
        setPermission(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
      }
      fetch("/api/notifications/settings", { cache: "no-store", credentials: "same-origin" })
        .then(async response => {
          if (!response.ok) throw new Error("notification-settings-failed");
          return await response.json() as { enabled: boolean; configured: boolean; publicKey: string };
        })
        .then(body => {
          setEnabled(body.enabled);
          setConfigured(body.configured);
          setPublicKey(body.publicKey);
          onEnabledChange?.(body.enabled);
        })
        .catch(() => undefined);
    }, 0);

    const permissionChanged = (event: Event) => {
      const granted = Boolean((event as CustomEvent<{ granted?: boolean }>).detail?.granted);
      setPermission(granted ? "granted" : "denied");
      if (!nativeActivationRequested.current) return;
      nativeActivationRequested.current = false;
      setBusy(false);
      if (!granted) {
        onMessage("اجازه اعلان داده نشد؛ از تنظیمات گوشی، اعلان‌های راهکار را فعال کنید");
        return;
      }
      saveEnabled(true)
        .then(() => {
          showNativeActivationTest();
          onMessage("اعلان‌های اندروید راهکار روی این گوشی فعال شد");
        })
        .catch(error => onMessage(error instanceof Error ? error.message : "فعال‌سازی اعلان ناموفق بود"));
    };
    window.addEventListener("tapra-notification-permission-changed", permissionChanged);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("tapra-notification-permission-changed", permissionChanged);
    };
  }, [onEnabledChange, onMessage, saveEnabled]);

  const activate = async () => {
    if (nativeApp) {
      const bridge = nativeBridge();
      if (!bridge?.requestNotificationPermission || !bridge.isNotificationPermissionGranted) {
        return onMessage("نسخه برنامه قدیمی است؛ نسخه جدید اندروید را نصب کنید");
      }
      setBusy(true);
      try {
        if (bridge.isNotificationPermissionGranted()) {
          setPermission("granted");
          await saveEnabled(true);
          showNativeActivationTest();
          onMessage("اعلان‌های اندروید راهکار روی این گوشی فعال است");
          setBusy(false);
          return;
        }
        nativeActivationRequested.current = true;
        bridge.requestNotificationPermission();
        window.setTimeout(() => {
          if (!nativeActivationRequested.current) return;
          nativeActivationRequested.current = false;
          setBusy(false);
          onMessage("اگر پنجره اجازه نمایش داده نشد، تنظیمات اعلان برنامه را باز کنید");
        }, 15_000);
      } catch (error) {
        nativeActivationRequested.current = false;
        setBusy(false);
        onMessage(error instanceof Error ? error.message : "فعال‌سازی اعلان ناموفق بود");
      }
      return;
    }

    if (!configured) return onMessage("کلید ارسال اعلان هنوز روی سرور تنظیم نشده است");
    if (!("serviceWorker" in navigator) || typeof Notification === "undefined") {
      return onMessage("این مرورگر از اعلان گوشی پشتیبانی نمی‌کند");
    }
    setBusy(true);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") throw new Error("اجازه اعلان داده نشد؛ از تنظیمات مرورگر آن را فعال کنید");
      await ensurePushDevice(publicKey);
      await saveEnabled(true);
      onMessage("اعلان مأموریت روی این دستگاه فعال شد");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "فعال‌سازی اعلان ناموفق بود");
    } finally {
      setBusy(false);
    }
  };

  const permissionLabel = permission === "granted"
    ? nativeApp ? "اجازه اعلان اندروید داده شده" : "اجازه داده شده"
    : permission === "denied"
      ? nativeApp ? "در تنظیمات گوشی مسدود است" : "در مرورگر مسدود است"
      : permission === "unsupported" ? "پشتیبانی نمی‌شود" : "هنوز اجازه گرفته نشده";

  return <div className="notification-settings-card">
    <div className="settings-heading"><span>♧</span><div><h2>تنظیمات اعلان‌ها</h2><p>اعلان داخل برنامه همیشه قابل مشاهده است؛ اعلان گوشی را شما کنترل می‌کنید.</p></div></div>
    <label className="settings-master-toggle" htmlFor="notification-master"><span><b>اعلان مأموریت‌ها</b><small>در حالت پیش‌فرض فعال است</small></span><input id="notification-master" aria-label="فعال بودن اعلان مأموریت‌ها" type="checkbox" checked={enabled} onChange={event => saveEnabled(event.target.checked).then(() => onMessage(event.target.checked ? "اعلان‌های سامانه فعال شد" : "اعلان گوشی غیرفعال شد؛ اعلان‌های داخل برنامه باقی می‌مانند")).catch(error => onMessage(error instanceof Error ? error.message : "ذخیره تنظیم اعلان ناموفق بود"))}/></label>
    <div className="permission-status"><span><small>{nativeApp ? "وضعیت اجازه اندروید" : "وضعیت اجازه مرورگر"}</small><b>{permissionLabel}</b></span><i className={permission === "granted" ? "good" : ""}>{permission === "granted" ? "✓" : "!"}</i></div>
    <button className="primary-wide" onClick={activate} disabled={busy || !enabled}>{busy ? "در حال فعال‌سازی..." : permission === "granted" ? nativeApp ? "بررسی دوباره اعلان اندروید" : "ثبت دوباره این دستگاه" : "فعال‌سازی اعلان روی گوشی"}</button>
    {nativeApp && permission === "denied" && <button type="button" className="secondary-wide" onClick={() => nativeBridge()?.openNotificationSettings?.()}>بازکردن تنظیمات اعلان گوشی</button>}
    <p className="notification-help">{nativeApp ? "اعلان‌ها مستقیماً توسط اندروید نمایش داده می‌شوند. هنگام فعالیت، پیام جدید حتی با بسته‌بودن صفحه برنامه نیز بررسی می‌شود." : "برای دریافت اعلان، سایت باید با HTTPS باز شود. در آیفون، برنامه را به Home Screen اضافه کنید و سپس این دکمه را بزنید."}</p>
  </div>;
}
