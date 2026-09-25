export const WORK_START_RESPONSE_TIMEOUT_MS = 15_000;

/** Bounds fetch, response parsing and local queue acknowledgements, including suspended WebViews. */
export function createWorkStartDeadline<T>(operation: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const deadline = Date.now() + WORK_START_RESPONSE_TIMEOUT_MS;
  let settled = false;
  let reject!: (error: Error) => void;
  let timer: ReturnType<typeof setTimeout>;
  const stop = (message: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(new Error(message));
    controller.abort();
  };
  const timeout = () => stop("پاسخ ثبت فعالیت نرسید؛ ممکن است ثبت شده باشد. دوباره تلاش کنید تا همان درخواست بررسی شود.");
  const checkDeadline = () => {
    if (Date.now() >= deadline) timeout();
    return settled;
  };
  const promise = new Promise<T>((resolve, no) => {
    reject = no;
    timer = setTimeout(timeout, WORK_START_RESPONSE_TIMEOUT_MS);
    Promise.resolve().then(() => operation(controller.signal)).then(result => {
      if (settled || checkDeadline()) return;
      settled = true; clearTimeout(timer); resolve(result);
    }, error => {
      if (settled) return;
      settled = true; clearTimeout(timer); no(error);
    });
  });
  return { promise, checkDeadline, cancel: () => stop("ثبت فعالیت متوقف شد؛ دوباره تلاش کنید.") };
}
