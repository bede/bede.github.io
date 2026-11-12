// Retrying through bad connections, for every request that must: magic-link POSTs,
// SDK requests and the first write. Only a deadline or the caller's signal gives up.

export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 60 * 1000;

// A bounded wait owns its timer and optional event listener, including on Cancel
function wait(ms, { signal, target, event, setTimerFn = setTimeout, clearTimerFn = clearTimeout } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let timer = null;
    const finish = (fn, value) => {
      if (timer !== null) clearTimerFn(timer);
      target?.removeEventListener?.(event, onReady);
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    const onReady = () => finish(resolve);
    const onAbort = () => finish(reject, signal.reason);
    target?.addEventListener?.(event, onReady, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimerFn(onReady, ms);
  });
}

export const sleep = (ms, options) => wait(ms, options);

export const onlineNow = () => typeof navigator === "undefined" || navigator.onLine !== false;

export async function waitForOnline({ timeoutMs = RETRY_MAX_MS, onlineFn = onlineNow, target = globalThis.window, ...options } = {}) {
  options.signal?.throwIfAborted();
  if (onlineFn()) return;
  await wait(timeoutMs, { ...options, target, event: "online" });
}

// Await a promise with an optional signal/deadline, removing our listener/timer
// even when the underlying operation cannot itself be cancelled
export function abortable(
  promise,
  signal,
  { timeoutMs = Infinity, expired = () => new Error("Gave up waiting."), setTimerFn = setTimeout, clearTimerFn = clearTimeout } = {}
) {
  if (!signal && !Number.isFinite(timeoutMs)) return promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimerFn(timer);
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, signal.reason);
    Promise.resolve(promise).then((value) => finish(resolve, value), (err) => finish(reject, err));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (Number.isFinite(timeoutMs)) timer = setTimerFn(() => finish(reject, expired()), timeoutMs);
  });
}

export function retryDelayMs(attempt, { baseMs = RETRY_BASE_MS, maxMs = RETRY_MAX_MS } = {}) {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

// Call attempt(n) until it succeeds, retrying errors retryable(err) accepts, forever.
//   - Offline: no attempt starts until `online` (rechecked each minute). Reports
//     { attempt, waitingOnline: true, waitMs, error? }, then { attempt, resumed: true }
//   - Otherwise backs off by delayMs(attempt), reporting { attempt, waitingOnline: false, waitMs, error }
//   - beforeRetry(err, { signal }) may throw to stop retrying; its wait is bounded by the deadline
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
    setTimerFn = setTimeout,
    clearTimerFn = clearTimeout,
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
      await abortable(waitOnlineFn({ signal, timeoutMs: waitMs, onlineFn, setTimerFn, clearTimerFn }), signal);
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
    signal?.throwIfAborted();
    checkDeadline();
    try {
      return await attempt(n);
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      if (!retryable(err)) throw err;
      checkDeadline();
      if (beforeRetry) {
        const check = new AbortController();
        try {
          await abortable(Promise.resolve(beforeRetry(err, { signal: check.signal })), signal, {
            timeoutMs: remaining(), expired, setTimerFn, clearTimerFn,
          });
        } finally {
          check.abort(); // release a readability check's own wait/timer, including on expiry
        }
      }
      checkDeadline();
      n++;
      lastError = err;
      if (!onlineFn()) continue; // the offline wait at the top reports this one
      const waitMs = Math.min(delayMs(n), remaining());
      onRetry?.({ attempt: n, waitingOnline: false, waitMs, error: err });
      await abortable(sleepFn(waitMs, { signal, setTimerFn, clearTimerFn }), signal);
    }
  }
}
