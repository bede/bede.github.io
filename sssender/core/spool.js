// OPFS spool for magic-link uploads. POST Object needs the whole body before the
// request, so a transformed stream is written to a private temp file first. Inputs
// that are already whole Files (raw uploads) never come through here.
//
// Each app may spool to its own OPFS `dir`. Renaming it orphans older spools

export const DEFAULT_SPOOL_DIR = "sssender-spool";
const STALE_SPOOL_MS = 6 * 60 * 60 * 1000; // don't reap a sibling tab's live spools
export const MEMORY_SPOOL_MAX_BYTES = 64 * 1024 * 1024;

const SESSION_ID = Math.random().toString(36).slice(2, 10);

function spoolSupported() {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function" &&
    typeof FileSystemFileHandle !== "undefined" &&
    typeof FileSystemFileHandle.prototype.createWritable === "function"
  );
}

function spoolStorageError(message, cause = null) {
  const err = new Error(message, cause ? { cause } : undefined);
  err.kind = "storage";
  return err;
}

// Prepare storage before filtering starts. Input size is used only to prevent an
// unbounded in-memory fallback when OPFS is unavailable. Actual quota is enforced
// by the OPFS write because compressed filtered output size is not known yet.
export async function prepareSpoolStorage(
  requiredBytes,
  {
    supported = spoolSupported(),
    persistFn = () => navigator.storage?.persist?.(),
  } = {}
) {
  if (!supported) {
    if (requiredBytes > MEMORY_SPOOL_MAX_BYTES) {
      throw spoolStorageError(
        `This browser cannot spool a ${Math.ceil(requiredBytes / 1024 / 1024)}MB filtered file to ` +
          `private storage. Use a current browser with OPFS support for large magic-link uploads.`
      );
    }
    return { opfs: false };
  }

  try {
    await persistFn?.();
  } catch (_) {
    // Persistence is a best-effort eviction safeguard, not a requirement.
  }
  return { opfs: true };
}

async function spoolDir(dir) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(dir, { create: true });
}

// part tells a group's outputs apart ("1", "2")
export function spoolName(n, part = "") {
  return `${SESSION_ID}-${n}${part ? `-${part}` : ""}.bin`;
}

// POST needs the whole body up front, so spool to OPFS to bound memory. `signal`
// stops the copy and cancels the stream.
export async function spoolToFile(stream, name, { expectedBytes = 0, dir = DEFAULT_SPOOL_DIR, signal } = {}) {
  if (!spoolSupported()) {
    if (expectedBytes > MEMORY_SPOOL_MAX_BYTES) {
      throw spoolStorageError(
        "This browser cannot use private file storage for a large magic-link upload."
      );
    }
    return new Response(stream).blob(); // bounded fallback for older browsers
  }
  try {
    const handle = await (await spoolDir(dir)).getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await stream.pipeTo(writable, signal ? { signal } : {}); // closes the writable
    return handle.getFile();
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    if (/QuotaExceeded|NotAllowed|NoModificationAllowed/i.test(err?.name || "")) {
      throw spoolStorageError(
        "The browser could not reserve enough private storage for the filtered upload.",
        err
      );
    }
    throw err;
  }
}

export async function releaseSpool(name, { dir = DEFAULT_SPOOL_DIR } = {}) {
  if (!spoolSupported()) return;
  try {
    await (await spoolDir(dir)).removeEntry(name);
  } catch (_) {
    // Already gone
  }
}

// Reap spools from a crashed session, age-gated so sibling tabs survive
export async function purgeStaleSpools({ dir = DEFAULT_SPOOL_DIR, now = Date.now() } = {}) {
  if (!spoolSupported()) return;
  const root = await navigator.storage.getDirectory().catch(() => null);
  if (!root) return;
  try {
    const handle = await root.getDirectoryHandle(dir);
    for await (const [name, entry] of handle.entries()) {
      if (name.startsWith(`${SESSION_ID}-`)) continue;
      const file = await entry.getFile();
      if (now - file.lastModified > STALE_SPOOL_MS) await handle.removeEntry(name);
    }
  } catch (_) {
    // Missing dir, or best-effort failure
  }
}
