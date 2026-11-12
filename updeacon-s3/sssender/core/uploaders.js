// Both upload modes: one uploader, two transports. The uploader (what runUpload drives):
//
//   preflight(keyBase, { signal })     open the transport
//   putSmall(key, blob, type, { signal, first })
//                                      first: the run's first write, also the reachability check
//   uploadGroup(item, outputs, hooks)  outputs[j] ({ body } | { stream }) -> item.keys[j], together
//   access                             who writes, for _CLIENT.json
//   concurrency?                       useful max groups at once
//
// hooks: onUploadStart(bytes) (whole Blobs only), onUploadProgress(bytes),
// onUploadRetry(info), signal. Retries show per row, a lost connection on the status line.
//
// A transport is what differs between modes:
//
//   expiresAt?                         retry deadline (a link's expiry)
//   access, concurrency?
//   open({ signal })?                  e.g. load the SDK, refuse an expired link
//   prepare(item, outputs, signal)?    -> { bodies, release? }, e.g. spool streams
//   put(key, body, { contentType, signal, onProgress, onRetry, once })
//                                      once: one attempt, sent as uploads are
//   resendsWhole                       a retry restarts the object
//
// credentialTransport: SDK multipart, streamed. A lost connection resends one part, forever.
// linkTransport: one POST per object, streams spooled first. A retry resends the object.
import { humanBytes } from "./format.js?v=b7c2564";
import { linkAccess, linkExpiredError } from "./link.js?v=b7c2564";
import { regionForEndpoint } from "./mint.js?v=b7c2564";
import { postObject, postObjectWithRetry } from "./post.js?v=b7c2564";
import { onlineNow, retryDelayMs, retryUntilDone } from "./retry.js?v=b7c2564";
import {
  DEFAULT_SPOOL_DIR,
  spoolToFile,
  spoolName,
  releaseSpool,
  prepareSpoolStorage,
} from "./spool.js?v=b7c2564";

const sum = (ns) => ns.reduce((a, b) => a + b, 0);
const isBlob = (b) => typeof Blob !== "undefined" && b instanceof Blob;
const leaf = (key) => key.split("/").pop();

// "s3.example.org" -> "https://s3.example.org". The prefilled "https://" alone is empty
export function normaliseEndpoint(value) {
  const s = (value || "").trim().replace(/\/+$/, "");
  if (!s || /^https?:\/*$/i.test(s)) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
}

// --- First contact -------------------------------------------------------------
// Browsers report a CORS refusal or a bad address as they do a dropped connection,
// which uploads retry forever. So the first write, sent once and exactly as uploads
// are, is the reachability check. Failing within PROMPT_FAILURE_MS while online means
// the setup is wrong: one more try, then "unreachable". Offline or slow failures are
// the connection, waited out as usual.
// 20 s allows for slow international links, where a CORS refusal can take 10-15 s.
// Too short would retry a bad setup forever.
export const PROMPT_FAILURE_MS = 20 * 1000;
export const FIRST_CONTACT_TRIES = 2;
const FIRST_RETRY_MS = 3 * 1000;

function unreachableError(viaLink, cause) {
  const err = new Error(
    viaLink
      ? "Can't reach the object store this link points to from this page. The link's server address " +
          "may be wrong, or its bucket may not allow uploads from this page (CORS). Ask whoever sent the link."
      : "Can't reach the object store from this page. Check the server address, and that the bucket's " +
          "CORS settings allow uploads from this page (PUT and POST, exposing ETag).",
    { cause }
  );
  err.kind = "unreachable";
  return err;
}

async function firstContact(
  attempt,
  { viaLink, signal, deadline, onRetry, onlineFn = onlineNow, nowFn = Date.now, ...waits }
) {
  let startedAt = 0;
  let prompt = 0;
  let quick = false;
  return retryUntilDone(() => {
    startedAt = nowFn();
    return attempt();
  }, {
    ...waits,
    retryable: (err) => err?.kind === "network",
    signal,
    deadline,
    expired: () => linkExpiredError(deadline, nowFn()),
    onRetry,
    onlineFn,
    nowFn,
    beforeRetry(err) {
      quick = onlineFn() && nowFn() - startedAt < PROMPT_FAILURE_MS;
      if (quick && ++prompt >= FIRST_CONTACT_TRIES) throw unreachableError(viaLink, err);
    },
    delayMs: (n) => quick ? FIRST_RETRY_MS : retryDelayMs(n),
  });
}

// --- The uploader ------------------------------------------------------------
// runLabel ("Uploading", "Filtering and uploading") restores the status line after a
// lost connection. waits: test hooks (onlineFn, sleepFn, waitOnlineFn, nowFn)
function makeUploader(transport, { onStatus, runLabel = "Uploading", waits = {} } = {}) {
  let runStatus = "";

  const retryStatus = (key, info) => {
    if (info.waitingOnline) onStatus?.(`Connection lost. Waiting to retry${key ? ` ${leaf(key)}` : ""} …`, "waiting");
    else if (info.resumed && runStatus) onStatus?.(runStatus);
  };

  return {
    access: transport.access,
    concurrency: transport.concurrency,
    async preflight(keyBase, { signal } = {}) {
      runStatus = `${runLabel} to ${keyBase}`;
      await transport.open?.({ signal });
    },
    putSmall(key, blob, contentType, { signal, first = false } = {}) {
      const onRetry = (info) => retryStatus(key, info);
      if (!first) return transport.put(key, blob, { contentType, signal, onRetry });
      onStatus?.("Checking connection …");
      return firstContact(() => transport.put(key, blob, { contentType, signal, once: true }), {
        viaLink: transport.access?.mode === "link",
        signal,
        deadline: transport.expiresAt ?? null,
        onRetry,
        ...waits,
      });
    },
    // A group's outputs go up together: a transform may interleave them (pairs)
    async uploadGroup(item, outputs, hooks = {}) {
      const { signal } = hooks;
      const { bodies, release } = transport.prepare
        ? await transport.prepare(item, outputs, signal)
        : { bodies: outputs.map((o) => o.body ?? o.stream) };
      try {
        if (bodies.every(isBlob)) hooks.onUploadStart?.(sum(bodies.map((b) => b.size)));
        const loaded = bodies.map(() => 0);
        const report = () => hooks.onUploadProgress?.(sum(loaded));
        await Promise.all(
          bodies.map((body, j) =>
            transport.put(item.keys[j], body, {
              signal,
              onProgress: (n) => {
                loaded[j] = n;
                report();
              },
              onRetry: (info) => {
                if (transport.resendsWhole) {
                  loaded[j] = 0;
                  report();
                }
                hooks.onUploadRetry?.(info);
                retryStatus(item.keys[j], info);
              },
            })
          )
        );
        return item.keys;
      } finally {
        await release?.();
      }
    },
  };
}

// --- Credentials -------------------------------------------------------------
// Give an SDK error the err.kind the pipeline acts on, keeping a transform's own
function classifySdkError(err) {
  if (!err || typeof err !== "object" || err.kind) return err;
  const status = err.$metadata?.httpStatusCode;
  if (/NotReadable|NotFound/.test(err.name || "")) err.kind = "input"; // the source file changed or vanished
  else if (status === 401 || status === 403) err.kind = "credentials";
  else if (status >= 500 || status === 408 || status === 429) err.kind = "network";
  // No response at all. fetch's wording varies by browser
  else if (!status && /Timeout|Failed to fetch|NetworkError|Load failed|network/i.test(`${err.name} ${err.message}`)) {
    err.kind = "network";
  }
  return err;
}

// The SDK gives up after ~3 attempts. This retries connection problems (no response,
// timeout, 5xx/429/408) until `signal` aborts, and throws anything else at once. The
// SDK re-signs each attempt, and a retry resends one buffered part. Streamed bodies
// are never retried. once: one attempt (first contact)
export function patientRetryStrategy({ signal, onRetry, once = false, ...waits } = {}) {
  return {
    mode: "standard",
    retry: (next, args) =>
      retryUntilDone(() => next(args), {
        retryable: (err) =>
          !once &&
          classifySdkError(err)?.kind === "network" &&
          typeof args?.request?.body?.getReader !== "function",
        signal,
        onRetry,
        ...waits,
      }),
  };
}

// Per HTTP attempt, including browser queueing, not an idle timeout
export const PART_TIMEOUT_MS = 15 * 60 * 1000;

// The bundled handler's timer rejects without aborting fetch, and lib-storage
// doesn't pass its abort signal to client.send. Own both at the HTTP boundary
export function withRequestTimeout(
  handler,
  { signal, timeoutMs = PART_TIMEOUT_MS, setTimerFn = setTimeout, clearTimerFn = clearTimeout } = {}
) {
  return {
    get metadata() {
      return handler.metadata;
    },
    updateHttpClientConfig: (...args) => handler.updateHttpClientConfig?.(...args),
    httpHandlerConfigs: () => handler.httpHandlerConfigs?.(),
    destroy: () => handler.destroy?.(),
    async handle(request, options = {}) {
      // Run Cancel takes precedence over an SDK abort or timeout
      const signals = [...new Set([signal, options.abortSignal].filter(Boolean))];
      const cancelled = () => signals.find((s) => s.aborted);
      const already = cancelled();
      if (already) throw already.reason;
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort(cancelled().reason);
      let timer = null;
      let timeoutError = null;
      try {
        for (const s of signals) s.addEventListener("abort", onAbort, { once: true });
        if (timeoutMs > 0) {
          timer = setTimerFn(() => {
            timeoutError = new Error(`Request did not complete within ${timeoutMs} ms`);
            timeoutError.name = "TimeoutError";
            ctrl.abort(timeoutError);
          }, timeoutMs);
        }
        const response = await handler.handle(request, {
          ...options,
          abortSignal: ctrl.signal,
          requestTimeout: 0, // disable the SDK's non-aborting timer, including per-send overrides
        });
        // Upload replies are small XML/control bodies. Consume them before cleanup
        // so a stalled response body still yields to the deadline and Cancel
        if (response.response?.body) {
          response.response.body = await new Response(response.response.body).blob();
        }
        if (ctrl.signal.aborted) throw ctrl.signal.reason;
        return response;
      } catch (err) {
        const aborted = cancelled();
        if (aborted) throw aborted.reason;
        throw timeoutError ?? err;
      } finally {
        if (timer !== null) clearTimerFn(timer);
        for (const s of signals) s.removeEventListener("abort", onAbort);
      }
    },
  };
}

export function credentialTransport({
  accessKeyId,
  secretAccessKey,
  bucket,
  endpoint,
  region = regionForEndpoint(endpoint), // Amazon S3 checks it, other stores ignore it
  partSize = 8 * 1024 * 1024,
  queueSize = 2, // memory stays bounded at partSize × queueSize per stream
  // Two files (or one paired group) send up to four parts at once
  concurrency = 2,
  requestTimeoutMs = PART_TIMEOUT_MS, // per request: a part or a small object, never a whole file
  setTimerFn = setTimeout,
  clearTimerFn = clearTimeout,
  loadSdk = () => import("../vendor/aws-sdk.js?v=b7c2564"), // the token busts a cached SDK after an update
  retryOptions = {}, // test hooks for patientRetryStrategy
}) {
  let sdk = null;
  return {
    concurrency,
    resendsWhole: false,
    access: { mode: "credentials", access_key_id: accessKeyId },
    async open() {
      sdk ??= await loadSdk();
    },
    async put(key, body, { contentType, signal, onProgress, onRetry, once = false } = {}) {
      signal?.throwIfAborted();
      // A client per object, so retries answer to its signal and row
      const client = new sdk.S3Client({
        endpoint,
        region,
        forcePathStyle: true,
        credentials: { accessKeyId, secretAccessKey },
        retryStrategy: patientRetryStrategy({ signal, onRetry, once, ...retryOptions }),
      });
      client.config.requestHandler = withRequestTimeout(client.config.requestHandler, {
        signal,
        timeoutMs: requestTimeoutMs,
        setTimerFn,
        clearTimerFn,
      });
      const up = new sdk.Upload({
        client,
        params: { Bucket: bucket, Key: key, Body: body, ...(contentType && { ContentType: contentType }) },
        queueSize,
        partSize,
      });
      if (onProgress) up.on("httpUploadProgress", (p) => onProgress(p.loaded || 0));
      const abort = () => Promise.resolve().then(() => up.abort()).catch(() => {});
      signal?.addEventListener("abort", abort, { once: true });
      try {
        return await up.done();
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        throw classifySdkError(err);
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}

// --- Magic links -------------------------------------------------------------
export function linkTransport({
  link,
  spoolDir = DEFAULT_SPOOL_DIR,
  postWithRetryFn = postObjectWithRetry,
  postOnceFn = postObject,
  prepareSpoolFn = prepareSpoolStorage,
  spoolToFileFn = spoolToFile,
  spoolNameFn = spoolName,
  releaseSpoolFn = releaseSpool,
}) {
  let spoolSeq = 0;

  const checkSize = (key, file, transformed) => {
    if (!link.maxBytes || file.size <= link.maxBytes) return;
    const err = new Error(
      `${leaf(key)}${transformed ? " output" : ""} is ${humanBytes(file.size)}, above the ` +
        `${humanBytes(link.maxBytes)} per-file limit for magic links.`
    );
    err.kind = "size";
    throw err;
  };

  return {
    expiresAt: link.expiresAt,
    resendsWhole: true,
    access: linkAccess(link),
    async open() {
      if (link.expiresAt <= Date.now()) throw linkExpiredError(link.expiresAt);
    },
    put: (key, body, { contentType, signal, onProgress, onRetry, once = false } = {}) =>
      once
        ? postOnceFn({ link, key, body, contentType, signal, onProgress })
        : postWithRetryFn({ link, key, body, contentType, signal, onProgress, onRetry }),
    // POST needs the whole body: Blobs as they are, streams spooled to files
    async prepare(item, outputs, signal) {
      if (outputs.every((o) => o.body)) {
        const bodies = outputs.map((o) => o.body);
        bodies.forEach((b, j) => checkSize(item.keys[j], b, false));
        return { bodies };
      }
      const names = outputs.map((_, j) => spoolNameFn(spoolSeq++, outputs.length > 1 ? String(j + 1) : ""));
      const release = async () => {
        for (const name of names) await releaseSpoolFn(name, { dir: spoolDir });
      };
      try {
        const sourceBytes = item.files.map((f) => f?.size || 0);
        await prepareSpoolFn(sum(sourceBytes));
        const bodies = await Promise.all(
          outputs.map((o, j) =>
            o.body ?? spoolToFileFn(o.stream, names[j], { expectedBytes: sourceBytes[j], dir: spoolDir, signal })
          )
        );
        bodies.forEach((b, j) => checkSize(item.keys[j], b, true));
        return { bodies, release };
      } catch (err) {
        await release();
        throw err;
      }
    },
  };
}

// --- The two uploaders -------------------------------------------------------
// opts: onStatus, runLabel, waits, plus the transport's options

export function makeCredentialUploader({ onStatus, runLabel, waits, ...opts }) {
  return makeUploader(credentialTransport(opts), { onStatus, runLabel, waits });
}

export function makeLinkUploader({ onStatus, runLabel, waits, ...opts }) {
  return makeUploader(linkTransport(opts), { onStatus, runLabel, waits });
}
