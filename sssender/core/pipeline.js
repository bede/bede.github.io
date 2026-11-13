// Upload protocol, independent of UI and transform.
//
//   <keyBase>/_CLIENT.json          first, in both modes, and the access check
//   <keyBase>/<relative path>       one object per input file
//   <keyBase>/<…>.<extra>           transform extras, e.g. .deacon.json
//   <keyBase>/_FAILED.txt           skipped files, if any: <path>\t<reason>
//   <keyBase>/_MANIFEST.txt         last: every key above. Present = run finished
//
// A transform turns a group (select.js) into upload bodies:
//
//   name                   recorded in _CLIENT.json ("raw", "deacon")
//   outputName(path)       object name for an input path
//   start(group, hooks)    -> [{ body } | { stream }], one per file. May call
//                          hooks.onProgress(msg) and hooks.onStats(stats, elapsed)
//   extras(item, result)?  -> [{ key, body, contentType }], uploaded after the group
//   concurrency?           max groups at once (default: unlimited)
import { relativePath } from "./select.js?v=61b67cc";
import { SSSENDER_VERSION, SSSENDER_COMMIT, LAYOUT_VERSION } from "./version.js?v=61b67cc";

export const groupFiles = (group) => group.files;

// Keys are <keyBase>/<relative path>, so basenames never collide
export function buildUploadItems(groups, keyBase, outputName = (path) => path) {
  return groups.map((group) => ({
    ...group,
    keys: group.files.map((file) => outputName(`${keyBase}/${relativePath(file)}`)),
  }));
}

// Inputs over a link's per-object cap, an upper bound for filters (output <= input)
export function findOversizeFiles(groups, maxBytes) {
  if (!maxBytes) return [];
  return groups.flatMap(groupFiles).filter((f) => (f.size || 0) > maxBytes);
}

// Provenance only. Never location.href, whose fragment holds the signature
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

// _CLIENT.json body, written before any upload (intent, not outcome). access is the
// uploader's { mode, access_key_id, … }, never a secret
export function clientRecord({ app, appVersion = null, commit = null, transform, groups, access = null, extra = {} }) {
  return {
    started: new Date().toISOString(),
    app,
    app_version: appVersion,
    commit,
    transform,
    access,
    sssender_version: SSSENDER_VERSION,
    sssender_commit: SSSENDER_COMMIT,
    layout: LAYOUT_VERSION,
    ...extra,
    groups: groups.length,
    files: groups.reduce((n, g) => n + g.files.length, 0),
    input_bytes: groups.reduce((n, g) => n + (g.size || 0), 0),
    ...clientEnvironment(),
  };
}

// Errors that would fail every remaining group alike stop the run: bad link or keys,
// unreachable store, full storage, a connection retries couldn't ride out. Anything
// else (bad input, oversize file, one object refused) skips the group and goes in
// _FAILED.txt. Transforms tag bad input err.kind = "input".
const RUN_FATAL = new Set(["link", "credentials", "unreachable", "storage", "network"]);
export const isRunFatal = (err) => RUN_FATAL.has(err?.kind) || err?.name === "AbortError";

const GROUP_ATTEMPTS = 2;

const oneLine = (err) => String(err?.message || err || "unknown error").replace(/\s+/g, " ").trim();

// Uploads each input file byte-for-byte, under its own name
export const rawTransform = Object.freeze({
  name: "raw",
  outputName: (path) => path,
  start: (group) => group.files.map((file) => ({ body: file })),
});

// Run the protocol, up to `concurrency` groups at once (capped by transform and
// uploader). client: { app, appVersion, commit, extra } for _CLIENT.json.
// hooks, all (i, …): onGroupStart, onTransformProgress, onUploadStart,
// onUploadProgress, onUploadRetry, onGroupRetry, onGroupDone, onGroupFailed, and onFinalising()
// A group's own failure skips it. A fatal one aborts the rest, skips the manifest and
// is rethrown with err.groupIndex. -> { items, keys, failed: [{ index, item, error }] }
export async function runUpload({
  groups,
  keyBase,
  uploader,
  transform,
  client = {},
  concurrency = 1,
  signal,
  hooks = {},
}) {
  const items = buildUploadItems(groups, keyBase, transform.outputName);
  if (!items.length) return { items, keys: [], failed: [] };

  signal?.throwIfAborted();
  await uploader.preflight(keyBase, { signal });
  const clientKey = `${keyBase}/_CLIENT.json`;
  const record = clientRecord({ ...client, transform: transform.name, groups, access: uploader.access });
  // First write doubles as the reachability check (see firstContact)
  await uploader.putSmall(clientKey, new Blob([JSON.stringify(record, null, 2)], { type: "application/json" }), "application/json", {
    signal,
    first: true,
  });

  const lanes = Math.max(
    1,
    Math.min(concurrency, transform.concurrency ?? Infinity, uploader.concurrency ?? Infinity, items.length)
  );
  const ctrl = new AbortController();
  let failure = null;
  const stopRun = (error, i) => {
    if (failure) return;
    if (typeof error === "object" && error.groupIndex == null) error.groupIndex = i;
    failure = error;
    ctrl.abort(error);
  };
  const stop = () => ctrl.abort(signal.reason);
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });

  // One attempt under the group's own signal: aborting it stops the group's other
  // outputs (a pair's mate) and their producers, before another attempt can start
  const runGroup = async (i) => {
    const groupCtrl = new AbortController();
    const groupSignal = groupCtrl.signal;
    const stopGroup = () => groupCtrl.abort(ctrl.signal.reason);
    if (ctrl.signal.aborted) stopGroup();
    else ctrl.signal.addEventListener("abort", stopGroup, { once: true });
    const drains = [];
    try {
      groupSignal.throwIfAborted();
      const item = items[i];
      hooks.onGroupStart?.(i, item);
      const result = { stats: null, elapsed: 0 };
      const outputs = transform.start(item, {
        onProgress: (msg) => hooks.onTransformProgress?.(i, msg),
        onStats: (stats, elapsed) => {
          result.stats = stats;
          result.elapsed = Number(elapsed) || 0;
        },
        signal: groupSignal,
      }).map((output) => {
        if (!output.stream) return output;
        const bridge = new TransformStream();
        const drain = output.stream.pipeTo(bridge.writable, { signal: groupSignal });
        drain.catch(() => {}); // handled below, even if preparation fails before reading
        drains.push(drain);
        return { ...output, stream: bridge.readable };
      });
      const keys = [
        ...(await uploader.uploadGroup(item, outputs, {
          onUploadStart: (bytes) => hooks.onUploadStart?.(i, bytes),
          onUploadProgress: (bytes) => hooks.onUploadProgress?.(i, bytes),
          onUploadRetry: (info) => hooks.onUploadRetry?.(i, info),
          signal: groupSignal,
        })),
      ];
      for (const extra of transform.extras?.(item, result) ?? []) {
        await uploader.putSmall(extra.key, extra.body, extra.contentType, { signal: groupSignal });
        keys.push(extra.key);
      }
      hooks.onGroupDone?.(i, item, result);
      return keys;
    } catch (err) {
      const error = err ?? new Error("Upload failed");
      // Stop sibling groups immediately, even if this producer's cleanup is slow
      if (isRunFatal(error) || signal?.aborted) stopRun(error, i);
      groupCtrl.abort(error);
      throw error;
    } finally {
      await Promise.allSettled(drains);
      ctrl.signal.removeEventListener("abort", stopGroup);
    }
  };

  const keysByGroup = []; // manifest order is group order, whatever order they finish in
  const failed = [];
  let next = 0;
  const lane = async () => {
    while (!failure && next < items.length) {
      const i = next++;
      try {
        // err.retry (e.g. a crashed worker): one more go before it counts as failed
        for (let attempt = 1; ; attempt++) {
          try {
            keysByGroup[i] = await runGroup(i);
            break;
          } catch (err) {
            if (!err?.retry || attempt >= GROUP_ATTEMPTS || failure || isRunFatal(err)) throw err;
            hooks.onGroupRetry?.(i, items[i], err);
          }
        }
      } catch (err) {
        if (failure) continue; // a sibling stopped by the first fatal error
        const error = err ?? new Error("Upload failed");
        if (isRunFatal(error) || signal?.aborted) {
          stopRun(error, i);
          continue;
        }
        failed.push({ index: i, item: items[i], error });
        hooks.onGroupFailed?.(i, items[i], error);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: lanes }, lane));
  } finally {
    signal?.removeEventListener("abort", stop);
  }
  if (failure) throw failure;

  const keys = [clientKey, ...keysByGroup.flat()];
  hooks.onFinalising?.();
  if (failed.length) {
    failed.sort((a, b) => a.index - b.index);
    const lines = failed.flatMap(({ item, error }) =>
      item.files.map((file) => `${relativePath(file)}\t${oneLine(error)}`)
    );
    const key = `${keyBase}/_FAILED.txt`;
    await uploader.putSmall(key, new Blob([lines.join("\n") + "\n"], { type: "text/plain" }), "text/plain", { signal });
    keys.push(key);
  }
  await uploader.putSmall(
    `${keyBase}/_MANIFEST.txt`,
    new Blob([keys.join("\n") + "\n"], { type: "text/plain" }),
    "text/plain",
    { signal }
  );
  return { items, keys, failed };
}
