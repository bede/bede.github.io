// Magic links: a signed S3 POST policy carried in the URL fragment (#u=…), minted by
// scripts/mint-magic-link.py. A POST policy signs a key pattern, not one key, so one
// link covers any number of files under its prefix.

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
  // The store enforces the prefix. This only refuses an unscoped link
  if (prefix == null) throw new Error("Magic link does not restrict uploads to a prefix.");
  const expiresAt = Date.parse(policy.expiration);
  if (Number.isNaN(expiresAt)) throw new Error("Magic link has no valid expiry.");

  return { bucket, prefix, maxBytes, expiresAt };
}

// Null when the hash carries no link, throws when it carries a broken one
export function parseMagicLink(hash) {
  const raw = new URLSearchParams((hash || "").replace(/^#/, "")).get("u");
  if (!raw) return null;

  let payload;
  try {
    payload = jsonFromBase64(raw);
  } catch (_) {
    throw new Error("Magic link is corrupt. It may have been truncated in transit.");
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

export function linkExpiredError(expiresAt, now = Date.now()) {
  const err = new Error(`This magic link expired ${describeExpiry(expiresAt, now).text} ago.`);
  err.kind = "link";
  return err;
}

// For _CLIENT.json: the signing key's ID (not secret), prefix and expiry
export function linkAccess(link) {
  const credential = link.fields?.["x-amz-credential"] || "";
  return {
    mode: "link",
    access_key_id: credential.split("/")[0] || null,
    prefix: link.prefix,
    expires: new Date(link.expiresAt).toISOString(),
  };
}
