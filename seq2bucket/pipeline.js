// The upload protocol, independent of any UI and of what transforms the files.
//
//   <keyBase>/_CLIENT.json          written by the link uploader's preflight
//   <keyBase>/<relative path>       one object per input (two per pair)
//   <keyBase>/<…>.<extra>           anything the transform adds, e.g. .deacon.json
//   <keyBase>/_MANIFEST.txt         written last: its presence means complete
//
// A transform turns a selected group into upload bodies:
//
//   name                   recorded in _CLIENT.json ("raw", "deacon")
//   outputName(path)       object name for an input path
//   start(group, hooks)    -> { body | stream } or { bodyR1, bodyR2 | streamR1, streamR2 };
//                          may call hooks.onProgress(msg) and hooks.onStats(stats, elapsed)
//   extras(item, result)?  -> [{ key, body, contentType }] uploaded after the group
import { groupRelativePaths } from "./pairing.js?v=87dbf05";
import { VERSION, BUILD_COMMIT } from "./version.js?v=87dbf05";

export const groupFiles = (group) => (group.kind === "paired" ? [group.file1, group.file2] : [group.file]);

// Keys are <keyBase>/<relative path>, so basenames never collide
export function buildUploadItems(groups, keyBase, outputName = (path) => path) {
  return groups.map((group) => {
    const paths = groupRelativePaths(group);
    if (group.kind === "paired") {
      return {
        ...group,
        key: outputName(`${keyBase}/${paths.input}`),
        key2: outputName(`${keyBase}/${paths.input2}`),
      };
    }
    return { ...group, key: outputName(`${keyBase}/${paths.input}`) };
  });
}

// Inputs above a link's per-object cap. Exact for raw uploads; for a filter an upper
// bound, since its output is never larger than its input.
export function findOversizeFiles(groups, maxBytes) {
  if (!maxBytes) return [];
  return groups.flatMap(groupFiles).filter((f) => (f.size || 0) > maxBytes);
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

// _CLIENT.json body. Written before any upload, so it records intent, not outcome.
export function clientRecord({ app, transform, groups, extra = {} }) {
  return {
    started: new Date().toISOString(),
    app,
    app_version: VERSION,
    commit: BUILD_COMMIT,
    transform,
    ...extra,
    groups: groups.length,
    input_bytes: groups.reduce((n, g) => n + (g.size || 0), 0),
    ...clientEnvironment(),
  };
}

// Uploads each input file byte-for-byte, under its own name
export const rawTransform = Object.freeze({
  name: "raw",
  outputName: (path) => path,
  start: (group) =>
    group.kind === "paired" ? { bodyR1: group.file1, bodyR2: group.file2 } : { body: group.file },
});

// Runs the whole protocol. hooks (all optional, all (index, …)):
//   onGroupStart(i, item), onTransformProgress(i, msg), onUploadStart(i, bytes),
//   onUploadProgress(i, bytes), onGroupDone(i, item, result), onFinalising()
// A failure inside the file loop carries err.groupIndex.
export async function runUpload({ groups, keyBase, uploader, transform, hooks = {} }) {
  const items = buildUploadItems(groups, keyBase, transform.outputName);
  if (!items.length) return { items, keys: [] };

  await uploader.preflight(keyBase);

  const keys = []; // every object written, in upload order (manifest contents)
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      hooks.onGroupStart?.(i, item);
      const result = { stats: null, elapsed: 0 };
      const outputs = transform.start(item, {
        onProgress: (msg) => hooks.onTransformProgress?.(i, msg),
        onStats: (stats, elapsed) => {
          result.stats = stats;
          result.elapsed = Number(elapsed) || 0;
        },
      });
      keys.push(
        ...(await uploader.uploadGroup(item, outputs, {
          onUploadStart: (bytes) => hooks.onUploadStart?.(i, bytes),
          onUploadProgress: (bytes) => hooks.onUploadProgress?.(i, bytes),
        }))
      );
      for (const extra of transform.extras?.(item, result) ?? []) {
        await uploader.putSmall(extra.key, extra.body, extra.contentType);
        keys.push(extra.key);
      }
      hooks.onGroupDone?.(i, item, result);
    } catch (err) {
      if (err && typeof err === "object" && err.groupIndex == null) err.groupIndex = i;
      throw err;
    }
  }

  hooks.onFinalising?.();
  await uploader.putSmall(
    `${keyBase}/_MANIFEST.txt`,
    new Blob([keys.join("\n") + "\n"], { type: "text/plain" }),
    "text/plain"
  );
  return { items, keys };
}
