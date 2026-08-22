import webpush from "web-push";
import { ensureDatabase } from "../db/runtime";

type NotificationInput = {
  type: string;
  title: string;
  message: string;
  entityType?: string;
  entityId?: string;
  url?: string;
};

type StoredSubscription = { id: string; endpoint: string; p256dh: string; auth: string };
type ManagerRecipient = { id: string };

let vapidConfigured = false;

function configureVapid() {
  if (vapidConfigured) return true;
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim() || "mailto:admin@taprasystem.ir";
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigured = true;
  return true;
}

export async function createUserNotification(userId: string, input: NotificationInput) {
  const db = await ensureDatabase();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO notifications (id, user_id, type, title, message, entity_type, entity_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, userId, input.type, input.title, input.message, input.entityType ?? null, input.entityId ?? null, now)
    .run();

  const preference = await db.prepare("SELECT notification_enabled AS enabled FROM users WHERE id = ?").bind(userId).first<{ enabled: number }>();
  if (!preference?.enabled || !configureVapid()) return { id, delivered: 0 };

  const subscriptions = (await db.prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?").bind(userId).all<StoredSubscription>()).results;
  let delivered = 0;
  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, JSON.stringify({
        title: input.title,
        body: input.message,
        url: input.url ?? "/",
        tag: `${input.type}:${input.entityId ?? id}`,
      }));
      delivered += 1;
    } catch (error) {
      const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 0;
      if ([404, 410].includes(statusCode)) await db.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(subscription.id).run();
      else console.error("push delivery failed", error);
    }
  }));
  return { id, delivered };
}

export async function createManagerIntegrityNotifications(employeeId: string, input: Omit<NotificationInput, "entityType">) {
  const db = await ensureDatabase();
  const recipients = (await db.prepare(`SELECT DISTINCT manager.id
    FROM users employee JOIN users manager
      ON manager.status = 'active' AND (manager.role IN ('owner', 'admin') OR (manager.role = 'supervisor' AND manager.id = employee.supervisor_id))
    WHERE employee.id = ? AND manager.id <> employee.id`).bind(employeeId).all<ManagerRecipient>()).results;
  const results = await Promise.allSettled(recipients.map(recipient => createUserNotification(recipient.id, {
    ...input, entityType:"integrity_event",
  })));
  return { recipients: recipients.length, delivered: results.reduce((sum, result) => sum + (result.status === "fulfilled" ? result.value.delivered : 0), 0) };
}

export function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY?.trim() ?? "";
}
