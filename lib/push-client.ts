export type PushDeviceState = "unsupported" | "default" | "denied" | "subscribed";

function applicationServerKey(value: string) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}

export function getPushDeviceState(): PushDeviceState {
  if (typeof window === "undefined" || !("serviceWorker" in navigator) || typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission !== "granted") return "default";
  return "subscribed";
}

export async function ensurePushDevice(publicKey: string) {
  if (!("serviceWorker" in navigator) || typeof Notification === "undefined") throw new Error("این مرورگر از اعلان ویندوز پشتیبانی نمی‌کند");
  if (Notification.permission !== "granted") throw new Error("اجازه نمایش اعلان در مرورگر داده نشده است");
  if (!publicKey) throw new Error("کلید ارسال اعلان روی سرور تنظیم نشده است");

  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(publicKey),
  });
  const response = await fetch("/api/notifications/subscriptions", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });
  if (!response.ok) throw new Error("ثبت این دستگاه برای اعلان ناموفق بود");
  return subscription;
}
