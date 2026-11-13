// Magic-link transport: every POST uses XHR, with progress-driven sending and a
// bounded response wait. A retry re-sends the whole object from byte 0
import { linkExpiredError } from "./link.js?v=61b67cc";
import { abortable, retryUntilDone } from "./retry.js?v=61b67cc";

// A progressing upload has no duration limit. After its body is sent, allow time
// for the store/proxy to finish and return the complete response
export const STALL_MS = 2 * 60 * 1000; // no upload progress at all
export const RESPONSE_MS = 5 * 60 * 1000; // body sent, awaiting the store's commit

function s3Error(xhr) {
  const { status, statusText } = xhr;
  const text = xhr.responseText || "";
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

// Progress listeners require CORS preflight, including for control objects
export function postObject({
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

export function isRetryableUploadError(err) {
  if (!err) return false;
  if (err.kind === "network") return true;
  if (err.kind === "link" || err.kind === "size" || err.kind === "unreachable") {
    return false;
  }
  return err.status === 408 || err.status === 429 || (err.status >= 500 && err.status < 600);
}

// A file moved, changed or deleted since it was picked fails like a dropped
// connection and would retry forever. Reading one byte tells them apart. The read
// itself can hang (a network share, sleeping disk or cloud folder), hence READ_CHECK_MS
export const READ_CHECK_MS = 5 * 60 * 1000;

export async function checkReadable(
  body,
  { signal, timeoutMs = READ_CHECK_MS, setTimerFn = setTimeout, clearTimerFn = clearTimeout } = {}
) {
  signal?.throwIfAborted();
  if (typeof Blob === "undefined" || !(body instanceof Blob)) return;
  const unreadable = (message, cause) => {
    const err = new Error(message, cause ? { cause } : undefined);
    err.kind = "input";
    return err;
  };
  try {
    await abortable(body.slice(0, 1).arrayBuffer(), signal, {
      timeoutMs, setTimerFn, clearTimerFn,
      expired: () => unreadable("The file stopped responding: the disk, network share or cloud folder it is on may be unavailable."),
    });
  } catch (cause) {
    if (signal?.aborted) throw signal.reason;
    if (cause?.kind === "input") throw cause;
    throw unreadable("The file can no longer be read: it was moved, changed or deleted after it was selected.", cause);
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
    beforeRetry: (_err, { signal }) => checkReadableFn(args.body, {
      signal, setTimerFn: args.setTimerFn, clearTimerFn: args.clearTimerFn,
    }),
    onRetry,
    nowFn,
    setTimerFn: args.setTimerFn,
    clearTimerFn: args.clearTimerFn,
    ...(sleepFn && { sleepFn }),
    ...(waitOnlineFn && { waitOnlineFn }),
  });
}
