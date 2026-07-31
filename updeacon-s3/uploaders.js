// Upload-mode adapters. UI code supplies status/rendering hooks; transport,
// retry, spooling and preflight behaviour stay independently testable here.
import {
  describeExpiry,
  postObjectWithRetry,
  sleep,
  waitForOnline,
  spoolToFile,
  spoolName,
  releaseSpool,
  prepareSpoolStorage,
  SMALL_MS,
} from "./presign.js?v=121a98f-dirty-20260731104053";

const onlineNow = () => typeof navigator === "undefined" || navigator.onLine !== false;

function expiredWhileWaiting() {
  const err = new Error("This magic link expired while waiting for the connection to return.");
  err.updeaconCause = "link";
  return err;
}

export async function checkReachable(
  endpoint,
  bucket,
  {
    retryOffline = false,
    expiresAt = null,
    onRetry,
    onChecking,
    fetchFn = fetch,
    nowFn = Date.now,
    onlineFn = onlineNow,
    sleepFn = sleep,
    waitOnlineFn = waitForOnline,
    setTimerFn = setTimeout,
    clearTimerFn = clearTimeout,
  } = {}
) {
  const remainingWait = () =>
    expiresAt ? Math.min(60 * 1000, Math.max(0, expiresAt - nowFn())) : 60 * 1000;
  const checkExpiry = () => {
    if (expiresAt && nowFn() >= expiresAt) throw expiredWhileWaiting();
  };
  const waitBeforeRetry = async (err) => {
    const waitingOnline = !onlineFn();
    const waitMs = remainingWait();
    onRetry?.({ waitingOnline, waitMs, ...(err && { error: err }) });
    if (waitingOnline) await Promise.race([waitOnlineFn(), sleepFn(waitMs)]);
    else await sleepFn(waitMs);
    checkExpiry();
  };

  const probe = async () => {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    let timedOut = false;
    const timer = ctrl
      ? setTimerFn(() => {
          timedOut = true;
          ctrl.abort();
        }, SMALL_MS)
      : null;
    try {
      await fetchFn(`${endpoint}/${bucket}`, {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        ...(ctrl && { signal: ctrl.signal }),
      });
    } catch (cause) {
      if (timedOut) {
        const err = new Error("Connection check timed out.", { cause });
        err.updeaconCause = "network";
        throw err;
      }
      throw cause;
    } finally {
      if (timer !== null) clearTimerFn(timer);
    }
  };

  for (;;) {
    onChecking?.();
    while (retryOffline && !onlineFn()) await waitBeforeRetry();
    try {
      await probe();
      return;
    } catch (cause) {
      const err = new Error("Can't reach the object store from this page.", { cause });
      err.updeaconCause = cause?.updeaconCause === "network" || !onlineFn() ? "network" : "cors";
      if (!retryOffline || err.updeaconCause !== "network") throw err;
      await waitBeforeRetry(err);
    }
  }
}

export function makeCredentialUploader({
  accessKeyId,
  secretAccessKey,
  bucket,
  endpoint,
  region,
  partSize,
  queueSize,
  onStatus,
  loadSdk = () => import("./vendor/aws-sdk.js"),
  checkReachableFn = checkReachable,
}) {
  let client = null;
  let Upload = null;

  const put = (key, body, contentType, onProgress) => {
    const up = new Upload({
      client,
      params: { Bucket: bucket, Key: key, Body: body, ...(contentType && { ContentType: contentType }) },
      queueSize,
      partSize,
    });
    if (onProgress) up.on("httpUploadProgress", (p) => onProgress(p.loaded || 0));
    return up.done();
  };

  return {
    async preflight(keyBase) {
      const sdk = await loadSdk();
      Upload = sdk.Upload;
      client = new sdk.S3Client({
        endpoint,
        region,
        forcePathStyle: true,
        credentials: { accessKeyId, secretAccessKey },
      });
      onStatus?.("Checking connection …");
      await checkReachableFn(endpoint, bucket);
      onStatus?.("Checking credentials …");
      try {
        await put(`${keyBase}/_ACCESS_KEY_ID.txt`, new Blob([accessKeyId], { type: "text/plain" }), "text/plain");
      } catch (err) {
        err.updeaconCause = "credentials";
        throw err;
      }
    },
    putSmall: (key, blob, contentType) => put(key, blob, contentType),
    async uploadGroup(item, outputs, hooks) {
      if (item.kind !== "paired") {
        await put(item.key, outputs.stream, null, hooks.onUploadProgress);
        return [item.key];
      }
      let r1 = 0;
      let r2 = 0;
      await Promise.all([
        put(item.key, outputs.streamR1, null, (n) => hooks.onUploadProgress((r1 = n) + r2)),
        put(item.key2, outputs.streamR2, null, (n) => hooks.onUploadProgress(r1 + (r2 = n))),
      ]);
      return [item.key, item.key2];
    },
  };
}

export function makeLinkUploader({
  link,
  buildClientRecord,
  humanBytes,
  onStatus,
  postWithRetryFn = postObjectWithRetry,
  prepareSpoolFn = prepareSpoolStorage,
  spoolToFileFn = spoolToFile,
  spoolNameFn = spoolName,
  releaseSpoolFn = releaseSpool,
  checkReachableFn = checkReachable,
}) {
  let spoolSeq = 0;
  let runStatus = "";

  const retryStatus = (key, info) => {
    const leaf = key.split("/").pop();
    if (info.waitingOnline) {
      onStatus?.(`Connection lost. Waiting to retry ${leaf} …`, "waiting");
      return;
    }
    if (info.resumed) {
      onStatus?.(runStatus || `Retrying ${leaf} …`);
      return;
    }
    const secs = Math.max(1, Math.ceil((info.waitMs || 0) / 1000));
    onStatus?.(`Connection interrupted while uploading ${leaf}. Retrying in ${secs}s …`);
  };

  const post = ({ onUploadRetry, ...args }) =>
    postWithRetryFn({
      ...args,
      onRetry: (info) => {
        onUploadRetry?.(info);
        retryStatus(args.key, info);
      },
    });

  const checkSize = (key, file) => {
    if (!link.maxBytes || file.size <= link.maxBytes) return;
    const err = new Error(
      `${key.split("/").pop()} is ${humanBytes(file.size)} after filtering, above the ` +
        `${humanBytes(link.maxBytes)} per-file limit for magic links.`
    );
    err.updeaconCause = "size";
    throw err;
  };

  return {
    async preflight(keyBase) {
      runStatus = `Filtering and uploading to ${keyBase}`;
      const { expired, text } = describeExpiry(link.expiresAt);
      if (expired) {
        const err = new Error(`This magic link expired ${text} ago.`);
        err.updeaconCause = "link";
        throw err;
      }
      await checkReachableFn(link.endpoint, link.bucket, {
        retryOffline: true,
        expiresAt: link.expiresAt,
        onChecking: () => onStatus?.("Checking connection …"),
        onRetry: (info) => retryStatus(`${keyBase}/_CLIENT.json`, info),
      });
      onStatus?.("Checking magic link …");
      await post({
        link,
        key: `${keyBase}/_CLIENT.json`,
        body: new Blob([JSON.stringify(buildClientRecord(), null, 2)], { type: "application/json" }),
        contentType: "application/json",
      });
    },
    putSmall: (key, blob, contentType) => post({ link, key, body: blob, contentType }),
    async uploadGroup(item, outputs, hooks) {
      const specs =
        item.kind === "paired"
          ? [
              { key: item.key, stream: outputs.streamR1, mate: "r1", sourceBytes: item.file1.size || 0 },
              { key: item.key2, stream: outputs.streamR2, mate: "r2", sourceBytes: item.file2.size || 0 },
            ]
          : [{ key: item.key, stream: outputs.stream, mate: "", sourceBytes: item.file.size || 0 }];
      const names = specs.map((s) => spoolNameFn(spoolSeq++, s.mate));

      try {
        await prepareSpoolFn(specs.reduce((n, s) => n + s.sourceBytes, 0));
        // Mates must drain together; the worker interleaves R1/R2 and stalls otherwise.
        const files = await Promise.all(
          specs.map((s, i) =>
            spoolToFileFn(s.stream, names[i], { expectedBytes: s.sourceBytes })
          )
        );
        specs.forEach((s, i) => checkSize(s.key, files[i]));

        hooks.onUploadStart(files.reduce((n, f) => n + f.size, 0));
        let done = 0;
        for (let i = 0; i < specs.length; i++) {
          await post({
            link,
            key: specs[i].key,
            body: files[i],
            onProgress: (loaded) => hooks.onUploadProgress(done + loaded),
            onUploadRetry: () => hooks.onUploadProgress(done),
          });
          done += files[i].size;
        }
        return specs.map((s) => s.key);
      } finally {
        for (const name of names) await releaseSpoolFn(name);
      }
    },
  };
}
