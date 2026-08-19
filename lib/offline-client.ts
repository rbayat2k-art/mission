export type OutboxResult<T = unknown> = { queued: boolean; data?: T; queueId?: number };

type JsonEntry = { id?: number; kind: "json"; url: string; method: string; body: unknown; createdAt: string };
type FileEntry = { id?: number; kind: "file"; url: string; fields: Record<string, string>; file: File; createdAt: string };
type OutboxEntry = JsonEntry | FileEntry;

const databaseName = "rahkar-offline-v1";
const storeName = "outbox";

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
    action(transaction.objectStore(storeName), resolve, reject);
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => { database.close(); reject(transaction.error); };
  });
}

async function enqueue(entry: OutboxEntry) {
  return withStore<number>("readwrite", (store, resolve, reject) => {
    const request = store.add(entry);
    request.onsuccess = () => resolve(Number(request.result));
    request.onerror = () => reject(request.error);
  });
}

export async function getOutboxCount() {
  return withStore<number>("readonly", (store, resolve, reject) => {
    const request = store.count();
    request.onsuccess = () => resolve(request.result);
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

async function remove(id: number) {
  return withStore<void>("readwrite", (store, resolve, reject) => {
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function responseBody<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "خطا در ارتباط با سرور");
  return body;
}

export async function sendJsonOrQueue<T>(url: string, method: string, body: unknown): Promise<OutboxResult<T>> {
  const entry: JsonEntry = { kind: "json", url, method, body, createdAt: new Date().toISOString() };
  if (!navigator.onLine) { await enqueue(entry); return { queued: true }; }
  try {
    const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { queued: false, data: await responseBody<T>(response) };
  } catch (error) {
    if (error instanceof TypeError) { await enqueue(entry); return { queued: true }; }
    throw error;
  }
}

export async function sendFileOrQueue<T>(url: string, fields: Record<string, string>, file: File): Promise<OutboxResult<T>> {
  const entry: FileEntry = { kind: "file", url, fields, file, createdAt: new Date().toISOString() };
  if (!navigator.onLine) { const queueId = await enqueue(entry); return { queued: true, queueId }; }
  try {
    const form = new FormData();
    Object.entries(fields).forEach(([key, value]) => form.set(key, value));
    form.set("file", file);
    const response = await fetch(url, { method: "POST", body: form });
    return { queued: false, data: await responseBody<T>(response) };
  } catch (error) {
    if (error instanceof TypeError) { const queueId = await enqueue(entry); return { queued: true, queueId }; }
    throw error;
  }
}

export async function removeQueuedItem(queueId: number) {
  await remove(queueId);
}

export async function flushOutbox() {
  if (!navigator.onLine) return { sent: 0, remaining: await getOutboxCount() };
  const entries = await readAll();
  let sent = 0;
  for (const entry of entries) {
    if (!entry.id) continue;
    try {
      let response: Response;
      if (entry.kind === "json") {
        response = await fetch(entry.url, { method: entry.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry.body) });
      } else {
        const form = new FormData();
        Object.entries(entry.fields).forEach(([key, value]) => form.set(key, value));
        form.set("file", entry.file);
        response = await fetch(entry.url, { method: "POST", body: form });
      }
      if (!response.ok && (response.status >= 500 || response.status === 401)) break;
      await remove(entry.id);
      sent += 1;
    } catch {
      break;
    }
  }
  return { sent, remaining: await getOutboxCount() };
}
