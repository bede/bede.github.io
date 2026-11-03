// Magic-link transport: POST Object with retry, and idle (never total-duration)
// timeouts. A POST is single-shot: no multipart, 5 GB per object, body sent in one
// request, and a retry re-sends from byte 0.
import { describeExpiry } from "./link.js?v=87dbf05";

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 60 * 1000;

// Idle timeouts, never total-duration ones: a multi-GB POST over a bad link runs for
// hours, and a retry re-sends from byte 0, so a false positive costs the whole object.
// Abort only on prolonged silence.
export const STALL_MS = 15 * 60 * 1000; // no upload progress at all
export const RESPONSE_MS = 30 * 60 * 1000; // body sent, awaiting the store's commit
export const SMALL_MS = 5 * 60 * 1000; // small bodies, request + response

function s3Error(xhr) {
  return s3ErrorFromText(xhr.status, xhr.statusText, xhr.responseText || "");
}

function s3ErrorFromText(status, statusText, text) {
  let code = "";
  let message = "";
  try {
    if (typeof DOMParser !== "undefined") {
      const doc = new DOMParser().parseFromString(text || "", "text/xml");
      code = doc.querySelector("Code")?.textContent || "";
      message = doc.querySelector("Message")?.textContent || "";
    } else {
      code = /<Code>([^<]+)<\/Code>/.exec(text || "")?.[1] || "";
      message = /<Message>([^<]+)<\/Message>/.exec(text || "")?.[1] || "";
    }
  } catch (_) {
    // Non-XML body
  }
  const err = new Error(message || `HTTP ${status} ${statusText}`);
  err.name = code || "UploadError";
  err.status = status;
  if (status === 403 || /AccessDenied|Expired|SignatureDoesNotMatch|Policy/i.test(code)) {
    err.kind = "link";
  }
  return err;
}

function uploadTransportError(message = "Can't reach the object store from this page.", attrs = {}) {
  const err = new Error(message);
  err.kind = "network";
  Object.assign(err, attrs);
  return err;
}

function withOfflineAbort(abort) {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => {};
  const onOffline = () => abort(uploadTransportError("Connection lost during upload.", { offline: true }));
  window.addEventListener("offline", onOffline, { once: true });
  return () => window.removeEventListener("offline", onOffline);
}

function postForm({ link, key, body, contentType = "application/octet-stream" }) {
  const form = new FormData();
  form.append("key", key);
  for (const [name, value] of Object.entries(link.fields)) form.append(name, value);
  form.append("Content-Type", contentType);
  form.append("file", body); // Must be the last field
  return form;
}

async function postObjectFetch({
  link,
  key,
  body,
  contentType = "application/octet-stream",
  setTimerFn = setTimeout,
  clearTimerFn = clearTimeout,
}) {
  let resp;
  let errorBody = "";
  let offlineErr = null;
  let timeoutErr = null;
  let timer = null;
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const removeOffline = ctrl
    ? withOfflineAbort((err) => {
        offlineErr = err;
        ctrl.abort();
      })
    : () => {};
  if (ctrl) {
    // Small bodies only, so one bound covers sending and the response
    timer = setTimerFn(() => {
      timeoutErr = uploadTransportError("Upload timed out.");
      ctrl.abort();
    }, SMALL_MS);
  }
  try {
    resp = await fetch(`${link.endpoint}/${link.bucket}`, {
      method: "POST",
      body: postForm({ link, key, body, contentType }),
      credentials: "omit",
      cache: "no-store",
      ...(ctrl && { signal: ctrl.signal }),
    });
    // fetch() resolves when response headers arrive. Keep the abort timer alive
    // while an error body is consumed, or a half-delivered XML error can hang.
    if (!resp.ok) errorBody = await resp.text();
  } catch (_) {
    // Whichever cause triggered the abort wins; offline is the more specific
    throw offlineErr || timeoutErr || uploadTransportError();
  } finally {
    if (timer !== null) clearTimerFn(timer);
    removeOffline();
  }
  if (resp.ok) return;
  throw s3ErrorFromText(resp.status, resp.statusText, errorBody);
}

// XHR is only for progress; it forces preflight.
function postObjectXhr({
  link,
  key,
  body,
  contentType = "application/octet-stream",
  onProgress,
  setTimerFn = setTimeout,
  clearTimerFn = clearTimeout,
}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    let offlineErr = null;
    let timeoutErr = null;
    let removeOffline = () => {};
    let stallTimer = null;
    let responseTimer = null;
    let uploadComplete = false;
    let lastLoaded = 0;

    const clearTimers = () => {
      if (stallTimer !== null) clearTimerFn(stallTimer);
      if (responseTimer !== null) clearTimerFn(responseTimer);
      stallTimer = null;
      responseTimer = null;
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimers();
      removeOffline();
      fn(value);
    };
    // abort() fires onabort synchronously, so stash the cause first, as offline does
    const abortWith = (err) => {
      timeoutErr = err;
      xhr.abort();
    };
    // Never xhr.timeout: that bounds total duration, and a slow upload is still alive
    const armStall = () => {
      if (uploadComplete) return;
      if (stallTimer !== null) clearTimerFn(stallTimer);
      stallTimer = setTimerFn(() => abortWith(uploadTransportError("Upload stalled.")), STALL_MS);
    };

    removeOffline = withOfflineAbort((err) => {
      offlineErr = err;
      xhr.abort();
    });
    xhr.open("POST", `${link.endpoint}/${link.bucket}`);
    // Attached unconditionally: the stall timer needs the events, not just the caller
    xhr.upload.onprogress = (e) => {
      // Duplicate progress events are not evidence that bytes are still moving.
      if (e.loaded > lastLoaded) {
        lastLoaded = e.loaded;
        armStall();
      }
      // fetch() can't report upload progress
      if (onProgress) onProgress(e.loaded, e.total);
    };
    xhr.upload.onloadend = () => {
      if (settled || uploadComplete) return; // abort fires loadend too
      uploadComplete = true;
      if (stallTimer !== null) clearTimerFn(stallTimer);
      stallTimer = null;
      // The store can spend a long time committing a large object, silently
      responseTimer = setTimerFn(
        () => abortWith(uploadTransportError("Upload timed out waiting for the object store.")),
        RESPONSE_MS
      );
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) finish(resolve);
      else finish(reject, s3Error(xhr));
    };
    xhr.onerror = () => finish(reject, uploadTransportError());
    xhr.ontimeout = () => finish(reject, uploadTransportError("Upload timed out."));
    xhr.onabort = () =>
      finish(reject, offlineErr || timeoutErr || uploadTransportError("Upload was interrupted."));
    armStall();
    xhr.send(postForm({ link, key, body, contentType }));
  });
}

export function postObject(args) {
  if (!args.onProgress && typeof fetch === "function") return postObjectFetch(args);
  return postObjectXhr(args);
}

export function retryDelayMs(attempt, { baseMs = RETRY_BASE_MS, maxMs = RETRY_MAX_MS } = {}) {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

export function isRetryableUploadError(err) {
  if (!err) return false;
  if (err.kind === "network") return true;
  if (err.kind === "link" || err.kind === "size" || err.kind === "cors") {
    return false;
  }
  return err.status === 408 || err.status === 429 || (err.status >= 500 && err.status < 600);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function waitForOnline() {
  if (typeof navigator === "undefined" || navigator.onLine !== false) return Promise.resolve();
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return sleep(RETRY_MAX_MS);
  return new Promise((resolve) => window.addEventListener("online", resolve, { once: true }));
}

function linkExpiredError(link, now = Date.now()) {
  const { expired, text } = describeExpiry(link.expiresAt, now);
  if (!expired) return null;
  const err = new Error(`This magic link expired ${text} ago.`);
  err.kind = "link";
  return err;
}

async function waitWhileOffline({ attempt, link, onRetry, sleepFn, waitOnlineFn, nowFn }) {
  let waited = false;
  while (typeof navigator !== "undefined" && navigator.onLine === false) {
    waited = true;
    const waitMs = Math.min(RETRY_MAX_MS, Math.max(0, link.expiresAt - nowFn()));
    onRetry?.({ attempt, waitingOnline: true, waitMs });
    await Promise.race([waitOnlineFn(), sleepFn(waitMs)]);
    const expired = linkExpiredError(link, nowFn());
    if (expired) throw expired;
  }
  return waited;
}

export async function postObjectWithRetry({
  onRetry,
  sleepFn = sleep,
  waitOnlineFn = waitForOnline,
  nowFn = Date.now,
  postOnce = postObject,
  ...args
}) {
  let attempt = 0;
  for (;;) {
    const expired = linkExpiredError(args.link, nowFn());
    if (expired) throw expired;
    if (await waitWhileOffline({
      attempt,
      link: args.link,
      onRetry,
      sleepFn,
      waitOnlineFn,
      nowFn,
    })) {
      onRetry?.({ attempt, resumed: true });
    }

    try {
      return await postOnce(args);
    } catch (err) {
      if (!isRetryableUploadError(err)) throw err;

      attempt++;
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        if (await waitWhileOffline({
          attempt,
          link: args.link,
          onRetry: (info) => onRetry?.({ ...info, error: err }),
          sleepFn,
          waitOnlineFn,
          nowFn,
        })) {
          onRetry?.({ attempt, resumed: true, error: err });
        }
        continue;
      }

      const waitMs = Math.min(retryDelayMs(attempt), Math.max(0, args.link.expiresAt - nowFn()));
      onRetry?.({ attempt, waitMs, error: err });
      await sleepFn(waitMs);
    }
  }
}
