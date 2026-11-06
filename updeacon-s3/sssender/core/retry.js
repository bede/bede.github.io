// Retrying through bad connections, for every request that must: magic-link POSTs,
// SDK requests and the first write. Only a deadline or the caller's signal gives up.

export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 60 * 1000;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const onlineNow = () => typeof navigator === "undefined" || navigator.onLine !== false;

export function waitForOnline() {
  if (onlineNow()) return Promise.resolve();
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return sleep(RETRY_MAX_MS);
  return new Promise((resolve) => window.addEventListener("online", resolve, { once: true }));
}

// Like promise, but rejects with the signal's reason once it aborts
export function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export function retryDelayMs(attempt, { baseMs = RETRY_BASE_MS, maxMs = RETRY_MAX_MS } = {}) {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

// Call attempt(n) until it succeeds, retrying errors retryable(err) accepts, forever.
//   - Offline: no attempt starts until `online` (rechecked each minute). Reports
//     { attempt, waitingOnline: true, waitMs, error? }, then { attempt, resumed: true }
//   - Otherwise backs off by delayMs(attempt), reporting { attempt, waitingOnline: false, waitMs, error }
//   - beforeRetry(err) may throw to stop retrying
//   - Past `deadline` (epoch ms) throws expired(), and no wait overruns it
//   - `signal` aborts any attempt or wait
export async function retryUntilDone(
  attempt,
  {
    retryable,
    signal,
    deadline = null,
    expired = () => new Error("Gave up waiting."),
    beforeRetry,
    delayMs = retryDelayMs,
    onRetry,
    onlineFn = onlineNow,
    sleepFn = sleep,
    waitOnlineFn = waitForOnline,
    nowFn = Date.now,
  } = {}
) {
  const remaining = () => (deadline == null ? Infinity : Math.max(0, deadline - nowFn()));
  const checkDeadline = () => {
    if (deadline != null && nowFn() >= deadline) throw expired();
  };
  const waitWhileOffline = async (n, error) => {
    let waited = false;
    while (!onlineFn()) {
      waited = true;
      const waitMs = Math.min(RETRY_MAX_MS, remaining());
      onRetry?.({ attempt: n, waitingOnline: true, waitMs, ...(error && { error }) });
      await abortable(Promise.race([waitOnlineFn(), sleepFn(waitMs)]), signal);
      checkDeadline();
    }
    if (waited) onRetry?.({ attempt: n, resumed: true, ...(error && { error }) });
  };

  let n = 0;
  let lastError = null;
  for (;;) {
    signal?.throwIfAborted();
    checkDeadline();
    await waitWhileOffline(n, lastError);
    try {
      return await attempt(n);
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      if (!retryable(err)) throw err;
      await beforeRetry?.(err);
      n++;
      lastError = err;
      if (!onlineFn()) continue; // the offline wait at the top reports this one
      const waitMs = Math.min(delayMs(n), remaining());
      onRetry?.({ attempt: n, waitingOnline: false, waitMs, error: err });
      await abortable(sleepFn(waitMs), signal);
    }
  }
}
