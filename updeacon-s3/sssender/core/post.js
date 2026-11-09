// Magic-link transport: POST Object with retry, and idle (never total-duration)
// timeouts. A POST is single-shot: no multipart, 5 GB per object, body sent in one
// request, and a retry re-sends from byte 0.
import { linkExpiredError } from "./link.js?v=6684013";
import { retryUntilDone } from "./retry.js?v=6684013";

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
  signal,
  setTimerFn = setTimeout,
  clearTimerFn = clearTimeout,
}) {
  signal?.throwIfAborted();
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
  const onAbort = () => ctrl?.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
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
    // Whichever cause triggered the abort wins, offline being the more specific
    if (signal?.aborted) throw signal.reason;
    throw offlineErr || timeoutErr || uploadTransportError();
  } finally {
    if (timer !== null) clearTimerFn(timer);
    removeOffline();
    signal?.removeEventListener("abort", onAbort);
  }
  if (resp.ok) return;
  throw s3ErrorFromText(resp.status, resp.statusText, errorBody);
}

// XHR is only for progress. It forces a CORS preflight.
function postObjectXhr({
  link,
  key,
  body,
  contentType = "application/octet-stream",
  onProgress,
  signal,
  setTimerFn = setTimeout,
  clearTimerFn = clearTimeout,
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const xhr = new XMLHttpRequest();
    let settled = false;
    let offlineErr = null;
    let timeoutErr = null;
    let removeOffline = () => {};
    // Caller gave up (a sibling failed): abort with its reason, no retry
    const onAbort = () => abortWith(signal.reason);
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
      signal?.removeEventListener("abort", onAbort);
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
    signal?.addEventListener("abort", onAbort, { once: true });
    armStall();
    xhr.send(postForm({ link, key, body, contentType }));
  });
}

export function postObject(args) {
  if (!args.onProgress && typeof fetch === "function") return postObjectFetch(args);
  return postObjectXhr(args);
}

export function isRetryableUploadError(err) {
  if (!err) return false;
  if (err.kind === "network") return true;
  if (err.kind === "link" || err.kind === "size" || err.kind === "unreachable") {
    return false;
  }
  return err.status === 408 || err.status === 429 || (err.status >= 500 && err.status < 600);
}

// A file moved, changed or deleted since it was picked fails like a dropped
// connection and would retry forever. Reading one byte tells them apart
export async function checkReadable(body) {
  if (typeof Blob === "undefined" || !(body instanceof Blob)) return;
  try {
    await body.slice(0, 1).arrayBuffer();
  } catch (cause) {
    const err = new Error("The file can no longer be read: it was moved, changed or deleted after it was selected.", {
      cause,
    });
    err.kind = "input";
    throw err;
  }
}

// Retry a POST until it lands, the link expires or `signal` aborts. The body must
// still be readable before each retry
export function postObjectWithRetry({
  onRetry,
  sleepFn,
  waitOnlineFn,
  nowFn = Date.now,
  postOnce = postObject,
  checkReadableFn = checkReadable,
  ...args
}) {
  return retryUntilDone(() => postOnce(args), {
    retryable: isRetryableUploadError,
    signal: args.signal,
    deadline: args.link.expiresAt,
    expired: () => linkExpiredError(args.link.expiresAt, nowFn()),
    beforeRetry: () => checkReadableFn(args.body),
    onRetry,
    nowFn,
    ...(sleepFn && { sleepFn }),
    ...(waitOnlineFn && { waitOnlineFn }),
  });
}
