// A shared in-flight GET prevents focus, polling and notification signals from
// racing. A local mission mutation invalidates an older server snapshot.
export function createMissionRefresh<T>(options: {
  read: (signal: AbortSignal) => Promise<T>;
  apply: (value: T) => void;
  revision: () => number;
  timeoutMs?: number;
}) {
  let disposed = false;
  let controller: AbortController | null = null;
  let pending: Promise<void> | null = null;
  return {
    refresh(): Promise<void> {
      if (disposed) return Promise.resolve();
      if (pending) return pending;
      const request = new AbortController();
      controller = request;
      const revision = options.revision();
      const timeout = setTimeout(() => request.abort(), options.timeoutMs ?? 10_000);
      pending = Promise.resolve().then(() => options.read(request.signal)).then(value => {
        if (!disposed && !request.signal.aborted && revision === options.revision()) options.apply(value);
      }).finally(() => { clearTimeout(timeout); pending = null; });
      return pending;
    },
    dispose() { disposed = true; controller?.abort(); },
  };
}
