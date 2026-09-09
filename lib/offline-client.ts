export type OutboxResult<T = unknown> = { queued: boolean; data?: T; queueId?: number };
export type OutboxOperation =
  | "mission_task_result"
  | "mission_destination"
  | "mission_completion"
  | "work_start"
  | "work_end"
  | "location_batch"
  | "integrity_event"
  | "attachment"
  | "other";

export type OutboxConflict = {
  queueId: number;
  url: string;
  method: string;
  status: number;
  operation: OutboxOperation;
  createdAt: string;
  serverError: string;
  serverCode?: string;
  clientEventId?: string;
  expectedVersion?: number;
  reapplyable: boolean;
  position: number;
  total: number;
};

export type OutboxQuarantine = {
  queueId: number;
  url: string;
  method: string;
  operation: OutboxOperation;
  createdAt: string;
  clientEventId?: string;
  expectedVersion?: number;
};

export type FlushOutboxResult = {
  sent: number;
  remaining: number;
  conflicts: OutboxConflict[];
  quarantined: OutboxQuarantine[];
};

type PersistedConflict = {
  status: number;
  serverError: string;
  serverCode?: string;
  detectedAt: string;
};

type EntryBase = {
  id?: number;
  accountId?: string;
  createdAt: string;
  conflict?: PersistedConflict;
};
type JsonEntry = EntryBase & { kind: "json"; url: string; method: string; body: unknown };
type FileEntry = EntryBase & { kind: "file"; url: string; fields: Record<string, string>; file: File };
type OutboxEntry = JsonEntry | FileEntry;
type LocationAck = {
  acceptedIds?: string[];
  duplicateIds?: string[];
  permanentRejected?: Array<{clientEventId?:string}>;
  retryableRejected?: Array<{clientEventId?:string}>;
};

const databaseName = "rahkar-offline-v1";
const storeName = "outbox";

function validAccountId(accountId: string) {
  const normalized = accountId.trim();
  if (!normalized || normalized.length > 64) throw new Error("حساب فعال برای ذخیره اطلاعات آفلاین مشخص نیست");
  return normalized;
}

function safeServerCode(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9_]{1,64}$/.test(normalized) ? normalized : undefined;
}

function safeConflictReason(operation: OutboxOperation) {
  if (operation === "mission_task_result") return "نسخه نتیجه این تسک در سرور تغییر کرده است";
  if (operation === "mission_destination") return "وضعیت مقصد یا مأموریت در سرور تغییر کرده است";
  if (operation === "mission_completion") return "وضعیت مأموریت در سرور تغییر کرده است";
  if (operation === "work_start" || operation === "work_end") return "وضعیت فعالیت روزانه در سرور تغییر کرده است";
  return "اطلاعات مربوط به این عملیات در سرور تغییر کرده است";
}

function objectBody(entry: OutboxEntry): Record<string, unknown> | null {
  return entry.kind === "json" && entry.body && typeof entry.body === "object" && !Array.isArray(entry.body)
    ? entry.body as Record<string, unknown>
    : null;
}

function safeEntryMetadata(entry: OutboxEntry) {
  const body = objectBody(entry);
  const clientEventId = typeof body?.clientEventId === "string" && body.clientEventId.length <= 64 ? body.clientEventId : undefined;
  const expected = Number(body?.expectedVersion);
  const expectedVersion = Number.isInteger(expected) && expected >= 0 ? expected : undefined;
  return { clientEventId, expectedVersion };
}

export function outboxOperation(entry: Pick<OutboxEntry, "kind"|"url"> & { method?: string; body?: unknown }): OutboxOperation {
  const method = (entry.method ?? "POST").toUpperCase();
  if (entry.kind === "file" && entry.url === "/api/attachments") return "attachment";
  if (method === "PATCH" && /^\/api\/missions\/[^/]+\/tasks\/[^/]+$/.test(entry.url)) return "mission_task_result";
  if (method === "POST" && entry.url === "/api/destinations") return "mission_destination";
  if (method === "POST" && /^\/api\/missions\/[^/]+\/complete$/.test(entry.url)) return "mission_completion";
  if (method === "POST" && entry.url === "/api/locations") return "location_batch";
  if (method === "POST" && entry.url === "/api/integrity") return "integrity_event";
  if (method === "POST" && entry.url === "/api/work-sessions") {
    const body = entry.body && typeof entry.body === "object" && !Array.isArray(entry.body) ? entry.body as Record<string, unknown> : null;
    if (body?.action === "start") return "work_start";
    if (body?.action === "end") return "work_end";
  }
  return "other";
}

export function outboxOperationLabel(operation: OutboxOperation) {
  const labels: Record<OutboxOperation, string> = {
    mission_task_result:"نتیجه یکی از کارهای مأموریت",
    mission_destination:"ثبت مقصد مأموریت",
    mission_completion:"ثبت نتیجه نهایی مأموریت",
    work_start:"شروع فعالیت روزانه",
    work_end:"پایان فعالیت روزانه",
    location_batch:"موقعیت‌های GPS",
    integrity_event:"گزارش وضعیت اتصال یا GPS",
    attachment:"فایل یا مدرک مأموریت",
    other:"تغییر آفلاین",
  };
  return labels[operation];
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: "id", autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    let result: T;
    // A successful IDB request may still be rolled back if its transaction
    // aborts. Never report a saved/deleted item until the commit completes.
    transaction.oncomplete = () => { database.close(); resolve(result); };
    transaction.onerror = () => { database.close(); reject(transaction.error); };
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error("ذخیره تغییر آفلاین کامل نشد")); };
    try {
      action(transaction.objectStore(storeName), value => { result = value; }, reject);
    } catch (error) {
      transaction.abort();
      reject(error);
    }
  });
}

async function enqueue(accountId: string, entry: Omit<JsonEntry, "accountId"> | Omit<FileEntry, "accountId">) {
  const ownedEntry = { ...entry, accountId: validAccountId(accountId) } as OutboxEntry;
  return withStore<number>("readwrite", (store, resolve, reject) => {
    const request = store.add(ownedEntry);
    request.onsuccess = () => resolve(Number(request.result));
    request.onerror = () => reject(request.error);
  });
}

async function readAll() {
  return withStore<OutboxEntry[]>("readonly", (store, resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result as OutboxEntry[]);
    request.onerror = () => reject(request.error);
  });
}

async function readOne(id: number) {
  return withStore<OutboxEntry | undefined>("readonly", (store, resolve, reject) => {
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result as OutboxEntry | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function put(entry: OutboxEntry) {
  return withStore<void>("readwrite", (store, resolve, reject) => {
    const request = store.put(entry);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function remove(id: number) {
  return withStore<void>("readwrite", (store, resolve, reject) => {
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function quarantineDescription(entry: OutboxEntry): OutboxQuarantine | null {
  if (!entry.id || entry.accountId) return null;
  const metadata = safeEntryMetadata(entry);
  return {
    queueId:entry.id,
    url:entry.url,
    method:entry.kind === "json" ? entry.method : "POST",
    operation:outboxOperation(entry),
    createdAt:entry.createdAt,
    ...metadata,
  };
}

export async function getOutboxState(accountId: string) {
  const currentAccountId = validAccountId(accountId);
  const entries = await readAll();
  return {
    ownedCount:entries.filter(entry => entry.accountId === currentAccountId).length,
    quarantined:entries.map(quarantineDescription).filter((entry): entry is OutboxQuarantine => Boolean(entry)),
  };
}

export async function getOutboxCount(accountId: string) {
  return (await getOutboxState(accountId)).ownedCount;
}

async function responseBody<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "خطا در ارتباط با سرور");
  return body;
}

function isLocationEntry(entry:JsonEntry) {
  return entry.url === "/api/locations" && entry.method.toUpperCase() === "POST";
}

export function nonLocationOutboxResponseAction(status:number):"sent"|"retry"|"conflict" {
  if (status >= 200 && status < 300) return "sent";
  if (status === 409) return "conflict";
  if (status >= 500 || [401, 408, 425, 429].includes(status)) return "retry";
  // A permanent rejection is not a successful sync. Keep it for explicit
  // resolution instead of silently discarding the employee's report or file.
  return "conflict";
}

export function locationBatchHasFinalAck(points:Array<{clientEventId?:string}> | undefined, body:LocationAck) {
  if (!Array.isArray(points)) return false;
  const expected = points.map((point) => point.clientEventId).filter((id):id is string => typeof id === "string" && id.length > 0);
  if (expected.length !== points.length) return false;
  const terminal = new Set([
    ...(body.acceptedIds ?? []),
    ...(body.duplicateIds ?? []),
    ...(body.permanentRejected ?? []).map((item) => item.clientEventId).filter((id):id is string => Boolean(id)),
  ]);
  const retryable = new Set((body.retryableRejected ?? []).map((item) => item.clientEventId).filter((id):id is string => Boolean(id)));
  return expected.every((id) => terminal.has(id) && !retryable.has(id));
}

function locationEntryHasFinalAck(entry:JsonEntry, body:LocationAck) {
  const points = (entry.body as {points?:Array<{clientEventId?:string}>} | null)?.points;
  return locationBatchHasFinalAck(points, body);
}

export async function sendJsonOrQueue<T>(accountId: string, url: string, method: string, body: unknown): Promise<OutboxResult<T>> {
  const currentAccountId = validAccountId(accountId);
  const entry: Omit<JsonEntry, "accountId"> = { kind: "json", url, method, body, createdAt: new Date().toISOString() };
  if (!navigator.onLine) { const queueId = await enqueue(accountId, entry); return { queued: true, queueId }; }
  try {
    const response = await fetch(url, { method, headers: { "Content-Type": "application/json", "X-Tapra-User-Id": currentAccountId }, body: JSON.stringify(body) });
    const data = await responseBody<T>(response);
    if (isLocationEntry(entry) && !locationEntryHasFinalAck(entry, data as LocationAck)) {
      const queueId = await enqueue(accountId, entry);
      return { queued:true, data, queueId };
    }
    return { queued: false, data };
  } catch (error) {
    if (error instanceof TypeError) { const queueId = await enqueue(accountId, entry); return { queued: true, queueId }; }
    throw error;
  }
}

export async function sendFileOrQueue<T>(accountId: string, url: string, fields: Record<string, string>, file: File): Promise<OutboxResult<T>> {
  const currentAccountId = validAccountId(accountId);
  const entry: Omit<FileEntry, "accountId"> = { kind: "file", url, fields, file, createdAt: new Date().toISOString() };
  if (!navigator.onLine) { const queueId = await enqueue(accountId, entry); return { queued: true, queueId }; }
  try {
    const form = new FormData();
    Object.entries(fields).forEach(([key, value]) => form.set(key, value));
    form.set("file", file);
    const response = await fetch(url, { method: "POST", headers: { "X-Tapra-User-Id": currentAccountId }, body: form });
    return { queued: false, data: await responseBody<T>(response) };
  } catch (error) {
    if (error instanceof TypeError) { const queueId = await enqueue(accountId, entry); return { queued: true, queueId }; }
    throw error;
  }
}

export async function removeQueuedItem(queueId: number, accountId: string) {
  const entry = await readOne(queueId);
  if (!entry || entry.accountId !== validAccountId(accountId)) throw new Error("این تغییر آفلاین متعلق به حساب جاری نیست");
  await remove(queueId);
}

export async function claimQuarantinedItem(queueId: number, accountId: string) {
  const entry = await readOne(queueId);
  if (!entry || entry.accountId) throw new Error("این تغییر قدیمی دیگر قابل انتساب نیست");
  await put({ ...entry, accountId:validAccountId(accountId) });
}

export async function removeQuarantinedItem(queueId: number) {
  const entry = await readOne(queueId);
  if (!entry || entry.accountId) throw new Error("این تغییر در بخش قرنطینه قرار ندارد");
  await remove(queueId);
}

export async function rebaseQueuedTaskResult(queueId: number, accountId: string, expectedVersion: number, clientEventId: string) {
  const entry = await readOne(queueId);
  if (!entry || entry.accountId !== validAccountId(accountId)) throw new Error("این تغییر آفلاین متعلق به حساب جاری نیست");
  if (entry.kind !== "json" || outboxOperation(entry) !== "mission_task_result") throw new Error("اعمال مجدد خودکار برای این نوع عملیات مجاز نیست");
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0 || !clientEventId.trim()) throw new Error("نسخه جدید تسک یا شناسه ثبت معتبر نیست");
  const body = objectBody(entry);
  if (!body) throw new Error("اطلاعات تغییر آفلاین معتبر نیست");
  await put({ ...entry, body:{ ...body, expectedVersion, clientEventId:clientEventId.trim() }, conflict:undefined });
}

function conflictDescription(entry: OutboxEntry, position: number, total: number): OutboxConflict | null {
  if (!entry.id || !entry.conflict) return null;
  const metadata = safeEntryMetadata(entry);
  const operation = outboxOperation(entry);
  return {
    queueId:entry.id,
    url:entry.url,
    method:entry.kind === "json" ? entry.method : "POST",
    status:entry.conflict.status,
    operation,
    createdAt:entry.createdAt,
    serverError:entry.conflict.serverError,
    serverCode:entry.conflict.serverCode,
    ...metadata,
    reapplyable:entry.conflict.status === 409 && operation === "mission_task_result" && entry.conflict.serverCode === "TASK_VERSION_CONFLICT",
    position,
    total,
  };
}

const activeFlushes = new Map<string, Promise<FlushOutboxResult>>();

export function flushOutbox(accountId: string): Promise<FlushOutboxResult> {
  const currentAccountId = validAccountId(accountId);
  const active = activeFlushes.get(currentAccountId);
  if (active) return active;
  const run = () => flushOwnedOutbox(currentAccountId);
  // Web Locks coordinate different tabs/WebViews sharing this origin. Older
  // engines still get the per-realm single-flight guard without requiring it.
  const work = typeof navigator.locks?.request === "function"
    ? navigator.locks.request(`tapra-outbox:${currentAccountId}`, run)
    : run();
  const pending = Promise.resolve(work).finally(() => activeFlushes.delete(currentAccountId));
  activeFlushes.set(currentAccountId, pending);
  return pending;
}

async function flushOwnedOutbox(accountId: string) {
  const currentAccountId = validAccountId(accountId);
  const stateBefore = await getOutboxState(currentAccountId);
  if (!navigator.onLine) return { sent:0, remaining:stateBefore.ownedCount, conflicts:[], quarantined:stateBefore.quarantined } satisfies FlushOutboxResult;
  const entries = (await readAll()).filter(entry => entry.accountId === currentAccountId);
  let sent = 0;
  const conflicts: OutboxConflict[] = [];
  for (const entry of entries) {
    if (!entry.id) continue;
    const blocked = conflictDescription(entry, 1, entries.length - sent);
    if (blocked) { conflicts.push(blocked); break; }
    try {
      let response: Response;
      if (entry.kind === "json") {
        response = await fetch(entry.url, { method: entry.method, headers: { "Content-Type": "application/json", "X-Tapra-User-Id": currentAccountId }, body: JSON.stringify(entry.body) });
      } else {
        const form = new FormData();
        Object.entries(entry.fields).forEach(([key, value]) => form.set(key, value));
        form.set("file", entry.file);
        response = await fetch(entry.url, { method: "POST", headers: { "X-Tapra-User-Id": currentAccountId }, body: form });
      }
      if (nonLocationOutboxResponseAction(response.status) === "conflict") {
        const body = await response.json().catch(() => ({})) as { code?: unknown };
        // A different session is not a version conflict. Leave this account's
        // queue intact so it can resume after the correct account signs in.
        if (body.code === "ACCOUNT_CONTEXT_CHANGED") break;
        const operation = outboxOperation(entry);
        const persisted:OutboxEntry = {
          ...entry,
          conflict:{
            status:response.status,
            serverError:response.status === 409 ? safeConflictReason(operation) : "سرور این تغییر را نپذیرفت؛ اطلاعات محلی برای بررسی شما محفوظ است",
            serverCode:safeServerCode(body.code),
            detectedAt:new Date().toISOString(),
          },
        };
        await put(persisted);
        const conflict = conflictDescription(persisted, 1, entries.length - sent);
        if (conflict) conflicts.push(conflict);
        break;
      } else if (entry.kind === "json" && isLocationEntry(entry)) {
        if (!response.ok) break;
        const body = await response.json().catch(() => null) as LocationAck | null;
        if (!body || !locationEntryHasFinalAck(entry, body)) break;
      } else if (nonLocationOutboxResponseAction(response.status) === "retry") break;
      await remove(entry.id);
      sent += 1;
    } catch {
      break;
    }
  }
  const stateAfter = await getOutboxState(currentAccountId);
  return { sent, remaining:stateAfter.ownedCount, conflicts, quarantined:stateAfter.quarantined } satisfies FlushOutboxResult;
}
