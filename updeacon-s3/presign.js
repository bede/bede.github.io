// Presigned-link upload: decode a signed POST policy from the URL fragment and POST
// objects under its prefix. Minted by scripts/mint-upload-link.py.
// A POST policy signs a key pattern, not one key, so it covers many files. But POST
// Object is single-shot: no multipart, 5 GB per object, body sent in one request.

const SPOOL_DIR = "updeacon-spool";
const STALE_SPOOL_MS = 6 * 60 * 60 * 1000; // don't reap a sibling tab's live spools

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

  if (!bucket) throw new Error("Upload link names no bucket.");
  // Object store enforces the prefix; this only refuses an unscoped link
  if (prefix == null) throw new Error("Upload link does not restrict uploads to a prefix.");
  const expiresAt = Date.parse(policy.expiration);
  if (Number.isNaN(expiresAt)) throw new Error("Upload link has no valid expiry.");

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
    throw new Error("Upload link is corrupt — it may have been truncated in transit.");
  }
  if (payload.v !== 1) {
    throw new Error(`Upload link version ${payload.v} is not supported by this page.`);
  }
  if (!payload.endpoint || !payload.fields?.policy || !payload.fields?.["x-amz-signature"]) {
    throw new Error("Upload link is missing required fields.");
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

function s3Error(xhr) {
  let code = "";
  let message = "";
  try {
    const doc = new DOMParser().parseFromString(xhr.responseText || "", "text/xml");
    code = doc.querySelector("Code")?.textContent || "";
    message = doc.querySelector("Message")?.textContent || "";
  } catch (_) {
    // Non-XML body
  }
  const err = new Error(message || `HTTP ${xhr.status} ${xhr.statusText}`);
  err.name = code || "UploadError";
  err.status = xhr.status;
  if (xhr.status === 403 || /AccessDenied|Expired|SignatureDoesNotMatch|Policy/i.test(code)) {
    err.updeaconCause = "link";
  }
  return err;
}

// The xhr.upload listener forces a CORS preflight on every POST
export function postObject({ link, key, body, contentType = "application/octet-stream", onProgress }) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("key", key);
    for (const [name, value] of Object.entries(link.fields)) form.append(name, value);
    form.append("Content-Type", contentType);
    form.append("file", body); // Must be the last field

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${link.endpoint}/${link.bucket}`);
    if (onProgress) {
      // fetch() can't report upload progress
      xhr.upload.onprogress = (e) => onProgress(e.loaded, e.total);
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(s3Error(xhr));
    };
    xhr.onerror = () => {
      const err = new Error("Can't reach the object store from this page.");
      err.updeaconCause = "cors";
      reject(err);
    };
    xhr.send(form);
  });
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
