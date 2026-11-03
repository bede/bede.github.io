// Mint magic links in the browser: the same signed S3 POST policy as
// scripts/mint-magic-link.py, so link.js reads either. The secret key is only used
// to sign here; nothing is sent anywhere.

export const POST_MAX_BYTES = 5 * 1024 ** 3; // S3 POST Object caps a single upload at 5 GB
const MAX_DAYS = 7; // SigV4 signatures are invalid beyond 604800 s
export const RAW_ROOT = "raw/"; // keeps unfiltered uploads out of paths assumed to be human-depleted
const ALGORITHM = "AWS4-HMAC-SHA256";

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

export async function signingKey(secret, datestamp, region, service) {
  let k = await hmac(enc.encode(`AWS4${secret}`), datestamp);
  k = await hmac(k, region);
  k = await hmac(k, service);
  return hmac(k, "aws4_request");
}

export function sanitise(name) {
  const slug = (name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (!slug) throw new Error(name?.trim() ? "The name needs at least one letter or digit." : "Enter a name for the link.");
  return slug;
}

// The letter-digit-letter-digit suffix avoids collisions, not guessing; the signature
// is the secret
export function makePrefix(name, { raw = false, randomFn = randomInt } = {}) {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  let suffix = "";
  for (let i = 0; i < 4; i++) {
    const set = i % 2 === 0 ? letters : digits;
    suffix += set[randomFn(set.length)];
  }
  return `${raw ? RAW_ROOT : ""}${sanitise(name)}-${suffix}/`;
}

function randomInt(n) {
  return crypto.getRandomValues(new Uint32Array(1))[0] % n;
}

const isoSeconds = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

function base64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// -> { link, prefix, expiresAt, fields }. Checks run in the order the page shows them.
export async function mintMagicLink({
  endpoint,
  bucket,
  region = "us-east-1", // Ceph RGW ignores it, but it must match the signature
  accessKeyId,
  secretAccessKey,
  name,
  raw = false,
  days = MAX_DAYS,
  maxBytes = POST_MAX_BYTES,
  baseUrl,
  now = new Date(),
  randomFn,
}) {
  const missing = [
    [endpoint, "server address"],
    [bucket, "bucket"],
    [accessKeyId, "access key ID"],
    [secretAccessKey, "secret access key"],
  ].filter(([v]) => !v).map(([, label]) => label);
  if (missing.length) {
    const list = missing.length > 1 ? `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}` : missing[0];
    throw new Error(`Enter the ${list}.`);
  }
  const prefix = makePrefix(name, { raw, ...(randomFn && { randomFn }) });
  if (!(Number.isInteger(days) && days >= 1 && days <= MAX_DAYS)) {
    throw new Error(`Lifetime must be a whole number of days from 1 to ${MAX_DAYS}.`);
  }
  if (!(maxBytes > 0 && maxBytes <= POST_MAX_BYTES)) {
    throw new Error("Max file size must be greater than 0 and at most 5 GB.");
  }

  const start = new Date(Math.floor(now.getTime() / 1000) * 1000);
  const expiresAt = new Date(start.getTime() + days * 86400000);
  const amzDate = isoSeconds(start).replace(/[-:]/g, "");
  const datestamp = amzDate.slice(0, 8);
  const credential = `${accessKeyId}/${datestamp}/${region}/s3/aws4_request`;

  const conditions = [
    { bucket },
    ["starts-with", "$key", prefix], // authorise a key pattern, not a key
    ["content-length-range", 0, maxBytes],
    ["starts-with", "$Content-Type", ""], // empty value matches anything
    { "x-amz-algorithm": ALGORITHM },
    { "x-amz-credential": credential },
    { "x-amz-date": amzDate },
  ];
  const fields = { "x-amz-algorithm": ALGORITHM, "x-amz-credential": credential, "x-amz-date": amzDate };

  // These exact bytes are signed and posted; no canonical request for a POST policy
  const policy = JSON.stringify({ expiration: isoSeconds(expiresAt), conditions });
  fields.policy = btoa(policy);
  const key = await signingKey(secretAccessKey, datestamp, region, "s3");
  fields["x-amz-signature"] = hex(await hmac(key, fields.policy));

  const payload = { v: 1, endpoint: endpoint.replace(/\/+$/, ""), fields };
  const blob = base64url(enc.encode(JSON.stringify(payload)));
  return { link: `${baseUrl.replace(/\/+$/, "")}/#u=${blob}`, prefix, expiresAt, fields };
}
