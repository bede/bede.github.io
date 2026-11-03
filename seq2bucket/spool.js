// OPFS spool for magic-link uploads. POST Object needs the whole body before the
// request, so a filtered stream is written to a private temp file first. Inputs
// that are already whole Files (raw uploads) never come through here.

const SPOOL_DIR = "updeacon-spool"; // name predates seq2bucket; renaming would orphan old spools
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
// unbounded in-memory fallback when OPFS is unavailable; actual quota is enforced
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

async function spoolDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(SPOOL_DIR, { create: true });
}

export function spoolName(n, mate = "") {
  return `${SESSION_ID}-${n}${mate ? `-${mate}` : ""}.bin`;
}

// POST needs the whole body up front; spool to OPFS to bound memory
export async function spoolToFile(stream, name, { expectedBytes = 0 } = {}) {
  if (!spoolSupported()) {
    if (expectedBytes > MEMORY_SPOOL_MAX_BYTES) {
      throw spoolStorageError(
        "This browser cannot use private file storage for a large magic-link upload."
      );
    }
    return new Response(stream).blob(); // bounded fallback for older browsers
  }
  try {
    const dir = await spoolDir();
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await stream.pipeTo(writable); // closes the writable
    return handle.getFile();
  } catch (err) {
    if (/QuotaExceeded|NotAllowed|NoModificationAllowed/i.test(err?.name || "")) {
      throw spoolStorageError(
        "The browser could not reserve enough private storage for the filtered upload.",
        err
      );
    }
    throw err;
  }
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
  const root = await navigator.storage.getDirectory().catch(() => null);
  if (!root) return;
  try {
    const dir = await root.getDirectoryHandle(SPOOL_DIR);
    for await (const [name, handle] of dir.entries()) {
      if (name.startsWith(`${SESSION_ID}-`)) continue;
      const file = await handle.getFile();
      if (now - file.lastModified > STALE_SPOOL_MS) await dir.removeEntry(name);
    }
  } catch (_) {
    // Missing dir, or best-effort failure
  }
}
