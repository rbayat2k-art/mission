self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(data.title || "راهکار", {
    body: data.body || "اعلان جدیدی در سامانه دارید.",
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: data.tag || "rahkar-notification",
    renotify: true,
    requireInteraction: true,
    silent: false,
    timestamp: Date.now(),
    data: { url: data.url || "/" },
    dir: "rtl",
    lang: "fa",
    actions: [{ action: "open", title: "مشاهده درخواست" }],
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => client.url.startsWith(self.location.origin));
    if (existing) return existing.navigate(target).then((client) => client ? client.focus() : self.clients.openWindow(target));
    return self.clients.openWindow(target);
  }));
});
