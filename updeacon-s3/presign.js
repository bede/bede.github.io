// Presigned-link upload: decode a signed POST policy from the URL fragment and POST
// objects under its prefix. Minted by scripts/mint-upload-link.py.
// A POST policy signs a key pattern, not one key, so it covers many files. But POST
// Object is single-shot: no multipart, 5 GB per object, body sent in one request.

const SPOOL_DIR = "updeacon-spool";
const STALE_SPOOL_MS = 6 * 60 * 60 * 1000; // don't reap a sibling tab's live spools
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 60 * 1000;

const SESSION_ID = Math.random().toString(36).slice(2, 10);

function bytesFromBase64(s) {
  // Payload is base64url, the policy inside it standard base64
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function jsonFromBase64(s) {
  return JSON.parse(new TextDecoder().decode(bytesFromBase64(s)));
}

// Read from the signed policy, so it can't disagree with a copy beside it
function readPolicy(encoded) {
  const policy = jsonFromBase64(encoded);
  const conditions = Array.isArray(policy.conditions) ? policy.conditions : [];
  let bucket = null;
  let prefix = null;
  let maxBytes = null;

  for (const cond of conditions) {
    if (Array.isArray(cond)) {
      // ["starts-with", "$key", v] vs ["content-length-range", min, max]
      const [op] = cond;
      if (op === "starts-with" && cond[1] === "$key") prefix = cond[2];
      else if (op === "content-length-range") maxBytes = Number(cond[2]);
    } else if (cond && typeof cond === "object" && typeof cond.bucket === "string") {
      bucket = cond.bucket;
    }
  }

  if (!bucket) throw new Error("Magic link names no bucket.");
  // Object store enforces the prefix; this only refuses an unscoped link
  if (prefix == null) throw new Error("Magic link does not restrict uploads to a prefix.");
  const expiresAt = Date.parse(policy.expiration);
  if (Number.isNaN(expiresAt)) throw new Error("Magic link has no valid expiry.");

  return { bucket, prefix, maxBytes, expiresAt };
}

// Null when the hash carries no link, throws when it carries a broken one
export function parseUploadLink(hash) {
  const raw = new URLSearchParams((hash || "").replace(/^#/, "")).get("u");
  if (!raw) return null;

  let payload;
  try {
    payload = jsonFromBase64(raw);
  } catch (_) {
    throw new Error("Magic link is corrupt — it may have been truncated in transit.");
  }
  if (payload.v !== 1) {
    throw new Error(`Magic link version ${payload.v} is not supported by this page.`);
  }
  if (!payload.endpoint || !payload.fields?.policy || !payload.fields?.["x-amz-signature"]) {
    throw new Error("Magic link is missing required fields.");
  }

  const { bucket, prefix, maxBytes, expiresAt } = readPolicy(payload.fields.policy);
  return {
    endpoint: payload.endpoint.replace(/\/$/, ""),
    bucket,
    prefix,
    maxBytes,
    expiresAt,
    fields: payload.fields,
  };
}

export function describeExpiry(expiresAt, now = Date.now()) {
  const ms = expiresAt - now;
  const abs = Math.abs(ms);
  const units = [
    ["day", 86400000],
    ["hour", 3600000],
    ["minute", 60000],
  ];
  let text = "less than a minute";
  for (const [unit, size] of units) {
    if (abs < size) continue;
    // Unit by floor, count by round, so a fresh 7-day link isn't "6 days"
    const n = Math.round(abs / size);
    text = `${n} ${unit}${n === 1 ? "" : "s"}`;
    break;
  }
  return { expired: ms <= 0, text };
}

// Provenance for an upload; never include location.href, the fragment holds the signature
export function clientEnvironment() {
  const nav = typeof navigator === "undefined" ? {} : navigator;
  const env = {
    user_agent: nav.userAgent || null,
    platform: nav.userAgentData?.platform || nav.platform || null,
    languages: [...(nav.languages || [])],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    hardware_concurrency: nav.hardwareConcurrency ?? null,
  };
  if (nav.deviceMemory) env.device_memory_gb = nav.deviceMemory; // Chromium only
  return env;
}

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
    err.updeaconCause = "link";
  }
  return err;
}

function uploadTransportError(message = "Can't reach the object store from this page.", attrs = {}) {
  const err = new Error(message);
  err.updeaconCause = "network";
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

async function postObjectFetch({ link, key, body, contentType = "application/octet-stream" }) {
  let resp;
  let offlineErr = null;
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const removeOffline = ctrl
    ? withOfflineAbort((err) => {
        offlineErr = err;
        ctrl.abort();
      })
    : () => {};
  try {
    resp = await fetch(`${link.endpoint}/${link.bucket}`, {
      method: "POST",
      body: postForm({ link, key, body, contentType }),
      credentials: "omit",
      cache: "no-store",
      ...(ctrl && { signal: ctrl.signal }),
    });
  } catch (_) {
    if (offlineErr) throw offlineErr;
    throw uploadTransportError();
  } finally {
    removeOffline();
  }
  if (resp.ok) return;
  throw s3ErrorFromText(resp.status, resp.statusText, await resp.text().catch(() => ""));
}

// XHR is only for progress; it forces preflight.
function postObjectXhr({ link, key, body, contentType = "application/octet-stream", onProgress }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    let offlineErr = null;
    let removeOffline = () => {};
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      removeOffline();
      fn(value);
    };
    removeOffline = withOfflineAbort((err) => {
      offlineErr = err;
      xhr.abort();
    });
    xhr.open("POST", `${link.endpoint}/${link.bucket}`);
    if (onProgress) {
      // fetch() can't report upload progress
      xhr.upload.onprogress = (e) => onProgress(e.loaded, e.total);
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) finish(resolve);
      else finish(reject, s3Error(xhr));
    };
    xhr.onerror = () => finish(reject, uploadTransportError());
    xhr.ontimeout = () => finish(reject, uploadTransportError("Upload timed out."));
    xhr.onabort = () => finish(reject, offlineErr || uploadTransportError("Upload was interrupted."));
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
  if (err.updeaconCause === "network") return true;
  if (err.updeaconCause === "link" || err.updeaconCause === "size" || err.updeaconCause === "cors") {
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
  err.updeaconCause = "link";
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

export function spoolSupported() {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function" &&
    typeof FileSystemFileHandle !== "undefined" &&
    typeof FileSystemFileHandle.prototype.createWritable === "function"
  );
}

async function spoolDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(SPOOL_DIR, { create: true });
}

export function spoolName(n, mate = "") {
  return `${SESSION_ID}-${n}${mate ? `-${mate}` : ""}.bin`;
}

// POST needs the whole body up front; spool to OPFS to bound memory
export async function spoolToFile(stream, name) {
  if (!spoolSupported()) return new Response(stream).blob(); // older Safari/Firefox
  const dir = await spoolDir();
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await stream.pipeTo(writable); // closes the writable
  return handle.getFile();
}

export async function releaseSpool(name) {
  if (!spoolSupported()) return;
  try {
    (await spoolDir()).removeEntry(name);
  } catch (_) {
    // Already gone
  }
}

// Reap spools from a crashed session, age-gated so sibling tabs survive
export async function purgeStaleSpools(now = Date.now()) {
  if (!spoolSupported()) return;
  try {
    const dir = await spoolDir();
    for await (const [name, handle] of dir.entries()) {
      if (name.startsWith(`${SESSION_ID}-`)) continue;
      const file = await handle.getFile();
      if (now - file.lastModified > STALE_SPOOL_MS) await dir.removeEntry(name);
    }
  } catch (_) {
    // Best effort
  }
}
