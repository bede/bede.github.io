// updeacon-s3: filter fa/fq with Deacon in the browser, then upload via sssender
import { DEACON_VERSION } from "./protocol.js?v=6684013";
import { createDeaconEngine, deaconTransform, gzName, logFilterParams } from "./deacon.js?v=6684013";
import { SEQ_RE, describeGroups, isPaired, pairSequenceFiles } from "./pairing.js?v=6684013";
import { VERSION, BUILD_COMMIT } from "./version.js?v=6684013";
import { purgeStaleSpools } from "./sssender/core/spool.js?v=6684013";
import { findOversizeFiles } from "./sssender/core/pipeline.js?v=6684013";
import { makeRunView, renderFileList } from "./sssender/ui/run-view.js?v=6684013";
import { bindCancel, bindSelection, readMagicLink, showMode, uploadSelection } from "./sssender/ui/upload-page.js?v=6684013";
import {
  bindCredentialForm,
  bindUploadName,
  humanBytes,
  makeBusyIndicator,
  makeStatus,
  oversizeMessage,
  setButtonDisabled,
  summariseSelection,
} from "./sssender/ui/ui.js?v=6684013";

// --- Fixed configuration -----------------------------------------------------
const APP = "updeacon";
const ROOT = "updeacon/"; // credential uploads, kept in step with mint.html's data-root
const SPOOL_DIR = "updeacon-spool"; // predates sssender. Renaming would orphan old spools
const MAX_INDEX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

const INDEX_URL =
  "https://objectstorage.uk-london-1.oraclecloud.com/n/lrbvkel2wjot/b/human-genome-bucket/o/deacon/3/panhuman-1.k31w25c9b16.pidx";
const INDEX_FILENAME = "panhuman-1.k31w25c9b16.pidx";
const INDEX_DISPLAY_NAME = "Index: panhuman-1"; // shown in panel; filename kept for summaries

const { link: LINK, linkError } = readMagicLink();

// --- DOM ---------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const indexStatus = $("index-status");
const indexInput = $("index-input");
const indexName = $("index-name");
const indexInfo = $("index-info");
const indexProgress = $("index-progress");
const indexRetry = $("index-retry");
const indexDownload = $("index-download");
const uploadBtn = $("upload-btn");
const filterBtn = $("filter-btn");
const resetBtn = $("reset-btn");
const progressWrap = $("progress-wrap");
const runProgress = $("run-progress");
const runLabel = $("run-label");
const purgeIndexEl = $("purge-index");

const setStatus = makeStatus($("status"));
const uploadName = bindUploadName({ prefixEl: $("name-prefix"), inputEl: $("run-name") });
const busyIndicator = makeBusyIndicator({ progress: runProgress });
const cancel = bindCancel({ button: $("cancel-btn"), setStatus });
const creds = bindCredentialForm({
  server: $("server"),
  bucket: $("bucket"),
  accessKey: $("access-key"),
  secretKey: $("secret-key"),
  onInput() {
    updateUploadEnabled();
    // Don't overwrite an oversize/pairing error, or a live run's progress
    if (!isBusy && !uploadCompleted && !oversizeFiles.length) setStatus(readyStatus());
  },
});

// --- State -------------------------------------------------------------------
let selectedFiles = []; // work groups, each one file or an R1/R2 pair
let fileRows = []; // { li, st } DOM rows, one per selected group (same order)
let isBusy = false; // filtering or uploading; blocks other actions
let uploadCompleted = false; // upload finished; lock buttons until next selection
let indexLoaded = false;
let indexFilename = ""; // name of the loaded .idx (recorded in summaries)
let indexK = null; // k-mer length parsed from the index info string
let indexW = null; // window size parsed from the index info string
let indexFailed = false; // download failed; panel acts as a manual drop target
let indexNeedsDownload = false; // not cached; panel click starts the download
let oversizeFiles = []; // inputs above the link's per-object cap
let indexFile = null; // a dropped local index, else the cached copy is used

const indexMeta = () => ({ filename: indexFilename, k: indexK, w: indexW });

// --- Mode: magic link vs S3 credentials --------------------------------------
// Link errors go in the banner, as initIndex() overwrites #status
const linkExpired = showMode({
  link: LINK,
  linkError,
  app: APP,
  version: VERSION,
  commit: BUILD_COMMIT,
  bucket: creds.bucket,
  onTick: () => updateUploadEnabled(),
});
if (LINK) purgeStaleSpools({ dir: SPOOL_DIR });

// --- Helpers -----------------------------------------------------------------
function humanBases(bp) {
  const units = ["bp", "kbp", "Mbp", "Gbp", "Tbp"];
  let i = 0;
  while (bp >= 1000 && i < units.length - 1) {
    bp /= 1000;
    i++;
  }
  return `${bp.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

// What the user still has to do, given index, selection and mode
function readyStatus() {
  if (!indexLoaded) return "";
  if (!selectedFiles.length) {
    return LINK
      ? "Index loaded. Select sequences to filter and upload"
      : "Index loaded. Select sequences and enter S3 credentials";
  }
  if (LINK && linkExpired()) return "";
  if (!LINK && !creds.filled()) return "Enter S3 credentials to upload, or press 'Filter only'";
  return "Press either 'Filter & upload' or 'Filter only' to begin";
}

function updateUploadEnabled() {
  if (!indexLoaded || uploadCompleted) {
    setButtonDisabled(uploadBtn, true);
    setButtonDisabled(filterBtn, true);
    return;
  }
  const haveFiles = selectedFiles.length > 0;
  // Filter only never touches S3, so a bad link doesn't disable it
  setButtonDisabled(filterBtn, isBusy || !haveFiles);
  const uploadBlocked = LINK ? linkExpired() || oversizeFiles.length > 0 : !creds.filled();
  setButtonDisabled(uploadBtn, isBusy || !haveFiles || !!linkError || uploadBlocked);
}

function setBusy(busy) {
  isBusy = busy;
  resetBtn.disabled = busy;
  updateUploadEnabled();
  selection.render();
  if (busy) busyIndicator.start();
  else busyIndicator.finish();
}

// --- Selection ---------------------------------------------------------------
// "2 pairs, 1 unpaired", only when something paired
function pairingDetails(sel) {
  const pairs = sel.groups.filter(isPaired).length;
  const unpaired = sel.groups.length - pairs;
  if (!pairs) return [];
  return [`${pairs} pair${pairs === 1 ? "" : "s"}`, ...(unpaired ? [`${unpaired} unpaired`] : [])];
}

const selection = bindSelection({
  options: { accept: (f) => SEQ_RE.test(f.name), group: pairSequenceFiles },
  summarise: (sel) =>
    sel.error ? "Pairing error" : summariseSelection(sel, { noun: "sequence file", details: pairingDetails }),
  isBusy: () => isBusy,
  onChange(sel) {
    busyIndicator.stop(); // a new selection or Reset clears a finished run's title
    uploadCompleted = false; // fresh selection clears the post-upload lock
    uploadName.rearm(); // a link is reusable
    selectedFiles = sel.groups;
    oversizeFiles = LINK ? findOversizeFiles(selectedFiles, LINK.maxBytes) : [];
    if (sel.error) setStatus(sel.error, "error");
    else if (oversizeFiles.length) {
      setStatus(
        oversizeMessage(oversizeFiles, LINK.maxBytes, "Remove these files, or upload them with S3 credentials."),
        "error"
      );
    } else setStatus(readyStatus());
    progressWrap.style.display = "none";
    fileRows = renderFileList($("file-list"), selectedFiles);
    updateUploadEnabled();
  },
});

resetBtn.addEventListener("click", () => {
  if (!isBusy) selection.reset();
});

// --- Deacon engine -----------------------------------------------------------
const engine = createDeaconEngine({
  // After a crash, as the dead worker had the bytes
  async reloadIndex() {
    const source = indexFile ?? (await getCachedIndex(INDEX_URL));
    if (!source) throw new Error("the index is no longer cached; load it again");
    return source.arrayBuffer();
  },
  onIndexLoaded(info, { k, w }) {
    indexLoaded = true;
    indexFailed = false;
    indexNeedsDownload = false;
    indexK = k;
    indexW = w;
    indexStatus.classList.remove("failed", "needs-download");
    indexStatus.classList.add("loaded");
    indexProgress.style.display = "none";
    indexRetry.hidden = true;
    indexDownload.hidden = true;
    clearIndexLoading();
    indexInfo.textContent = info;
    setStatus(readyStatus());
    updateUploadEnabled();
  },
  onError(message) {
    clearIndexLoading();
    indexInfo.textContent = "";
    setStatus("Error: " + message, "error");
  },
});

// --- Index selection ---------------------------------------------------------
// Click to download (uncached) or select a local .idx (failed). Drop works in either state
indexStatus.addEventListener("click", () => {
  if (isBusy) return;
  if (indexNeedsDownload) downloadAndLoadIndex();
  else if (indexFailed) indexInput.click();
});
indexStatus.addEventListener("dragover", (e) => {
  if (!(indexNeedsDownload || indexFailed)) return;
  e.preventDefault();
  if (!isBusy) indexStatus.classList.add("dragover");
});
indexStatus.addEventListener("dragleave", () => indexStatus.classList.remove("dragover"));
indexStatus.addEventListener("drop", (e) => {
  if (!(indexNeedsDownload || indexFailed)) return;
  e.preventDefault();
  indexStatus.classList.remove("dragover");
  if (isBusy) return;
  if (e.dataTransfer.files.length > 0) loadIndexFile(e.dataTransfer.files[0]);
});
indexInput.addEventListener("change", () => {
  if (indexInput.files.length > 0) loadIndexFile(indexInput.files[0]);
});

async function loadIndexFile(file) {
  if (file.size > MAX_INDEX_BYTES) {
    setStatus(
      `Index file too large for browser use (${(file.size / 1024 / 1024).toFixed(0)}MB). ` +
        `Maximum supported size is ${MAX_INDEX_BYTES / 1024 / 1024 / 1024}GB`,
      "error"
    );
    return;
  }
  indexLoaded = false;
  indexFailed = false;
  indexNeedsDownload = false;
  indexFilename = file.name;
  indexFile = file;
  indexStatus.classList.remove("loaded", "failed", "needs-download", "dragover");
  indexRetry.hidden = true;
  indexDownload.hidden = true;
  updateUploadEnabled();
  indexName.textContent = file.name;
  showIndexLoading("Loading");
  setStatus(`Loading index (${(file.size / 1024 / 1024).toFixed(0)}MB)…`);
  engine.loadIndex(await file.arrayBuffer());
}

// --- Index auto-download + cache ---------------------------------------------
// Cache in IndexedDB (handles the ~850 MB blob) for instant offline reloads. The
// database name predates sssender, and renaming it would force a re-download.
const IDB_NAME = "updeacon";
const IDB_STORE = "index";

function openIdxDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbRequest(makeReq) {
  return new Promise((resolve, reject) => {
    const req = makeReq();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getCachedIndex(url) {
  const db = await openIdxDB();
  try {
    return await idbRequest(() => db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(url));
  } finally {
    db.close();
  }
}

async function putCachedIndex(url, blob) {
  // Ask the browser not to evict this large blob
  if (navigator.storage?.persist) {
    try {
      await navigator.storage.persist();
    } catch (_) {}
  }
  const db = await openIdxDB();
  try {
    await idbRequest(() => db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).put(blob, url));
  } finally {
    db.close();
  }
}

async function clearCachedIndex(url) {
  const db = await openIdxDB();
  try {
    await idbRequest(() => db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).delete(url));
  } finally {
    db.close();
  }
}

// GC cached indexes other than keepUrl (keyed by URL, else linger forever). Runs on startup
async function pruneStaleIndexes(keepUrl) {
  const db = await openIdxDB();
  try {
    const store = db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE);
    const keys = await idbRequest(() => store.getAllKeys());
    await Promise.all(keys.filter((key) => key !== keepUrl).map((key) => idbRequest(() => store.delete(key))));
  } finally {
    db.close();
  }
}

function showIndexLoading(label) {
  indexInfo.textContent = label;
  indexInfo.classList.add("loading-dots");
}

function clearIndexLoading() {
  indexInfo.classList.remove("loading-dots");
}

async function downloadIndex(url, onProgress) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  const total = Number(resp.headers.get("content-length")) || 0;
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received, total);
  }
  return new Blob(chunks);
}

function showIndexProgress(received, total) {
  clearIndexLoading();
  indexProgress.style.display = "";
  if (total) {
    const pct = (received / total) * 100;
    indexProgress.removeAttribute("indeterminate");
    indexProgress.value = pct;
    indexInfo.textContent = `${humanBytes(received)} / ${humanBytes(total)} (${pct.toFixed(0)}%)`;
  } else {
    indexProgress.removeAttribute("value"); // indeterminate
    indexInfo.textContent = `${humanBytes(received)} downloaded`;
  }
}

function showIndexNeedsDownload() {
  indexNeedsDownload = true;
  indexFailed = false;
  clearIndexLoading();
  indexProgress.style.display = "none";
  indexRetry.hidden = true;
  indexDownload.hidden = false;
  indexDownload.classList.remove("pulse-glow");
  void indexDownload.offsetWidth;
  indexDownload.classList.add("pulse-glow");
  indexName.textContent = ""; // download button stands in for the title
  indexInfo.textContent = "No Deacon index cached. Click to download or drop an .idx/.pidx file.";
  indexStatus.classList.remove("loaded", "failed");
  indexStatus.classList.add("needs-download");
  setStatus("");
  updateUploadEnabled();
}

function showIndexFailure(err) {
  console.error(err);
  indexFailed = true;
  indexNeedsDownload = false;
  clearIndexLoading();
  indexProgress.style.display = "none";
  indexName.textContent = INDEX_DISPLAY_NAME;
  indexInfo.textContent =
    `Download failed (${err?.message || err}). ` +
    "Click to select a local .idx/.pidx file, drag one here, or retry.";
  indexRetry.hidden = false;
  indexDownload.hidden = true;
  indexStatus.classList.remove("loaded", "needs-download");
  indexStatus.classList.add("failed");
  setStatus("");
  updateUploadEnabled();
}

// Load cached index if present, else prompt to download (no automatic download)
async function initIndex() {
  indexFile = null;
  indexFilename = INDEX_FILENAME;
  indexFailed = false;
  indexNeedsDownload = false;
  indexName.textContent = INDEX_DISPLAY_NAME;
  indexRetry.hidden = true;
  indexDownload.hidden = true;
  indexStatus.classList.remove("failed", "needs-download", "loaded", "dragover");
  pruneStaleIndexes(INDEX_URL).catch((e) => console.warn("updeacon: failed to prune stale cached indexes", e));
  try {
    const cached = await getCachedIndex(INDEX_URL);
    if (cached) {
      showIndexLoading("Loading cached index");
      setStatus("Loading cached index…");
      engine.loadIndex(await cached.arrayBuffer());
      return;
    }
    showIndexNeedsDownload();
  } catch (err) {
    showIndexFailure(err);
  }
}

async function downloadAndLoadIndex() {
  indexFile = null;
  indexNeedsDownload = false;
  indexFailed = false;
  indexFilename = INDEX_FILENAME;
  indexName.textContent = INDEX_DISPLAY_NAME; // restore title (needs-download hid it)
  indexRetry.hidden = true;
  indexDownload.hidden = true;
  indexStatus.classList.remove("needs-download", "failed", "dragover");
  updateUploadEnabled();
  try {
    indexInfo.textContent = "Downloading index…";
    setStatus("Downloading index…");
    showIndexProgress(0, 0);
    const blob = await downloadIndex(INDEX_URL, showIndexProgress);
    await putCachedIndex(INDEX_URL, blob).catch((e) => console.warn("updeacon: failed to cache index", e));
    indexProgress.style.display = "none";
    showIndexLoading("Loading index");
    setStatus("Loading index…");
    engine.loadIndex(await blob.arrayBuffer());
  } catch (err) {
    showIndexFailure(err);
  }
}

indexDownload.addEventListener("click", (e) => {
  e.stopPropagation(); // don't double-trigger via the panel's click handler
  downloadAndLoadIndex();
});

indexRetry.addEventListener("click", (e) => {
  e.stopPropagation(); // don't trigger the panel's click handler
  downloadAndLoadIndex();
});

purgeIndexEl.addEventListener("click", async (e) => {
  e.preventDefault();
  if (isBusy) return;
  // Update the UI first, as Safari's IndexedDB can stall on delete
  indexLoaded = false;
  engine.reset();
  updateUploadEnabled();
  showIndexNeedsDownload();
  setStatus("Clearing index cache…");
  try {
    await clearCachedIndex(INDEX_URL);
    setStatus("Index cache cleared");
  } catch (err) {
    console.warn("updeacon: failed to clear cached index", err);
    setStatus("Couldn't clear the index cache: " + (err?.message || err), "error");
  }
});

// --- Filter only -------------------------------------------------------------
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const FILTERING = { verb: "filtering", past: "filtered" }; // for the run view

const readsText = (verb) => (_item, { stats }) => {
  const readsIn = Number(stats?.readsIn || 0);
  const readsOut = Number(stats?.readsOut || 0);
  return readsIn ? `done. ${readsOut.toLocaleString()}/${readsIn.toLocaleString()} reads ${verb}` : "done";
};

// Filter locally and download: no S3, no credentials
async function filterOnly() {
  const groups = selectedFiles;
  if (!groups.length) return;
  logFilterParams(indexMeta());
  const signal = cancel.start();
  setBusy(true);
  setStatus("Filtering…");

  const view = makeRunView({
    wrap: progressWrap,
    bar: runProgress,
    label: runLabel,
    rows: fileRows,
    groups,
    transform: FILTERING,
    doneText: readsText("kept"),
  });
  let totalBasesIn = 0;
  const skipped = []; // groups whose input Deacon couldn't read
  let current = 0;
  try {
    for (let i = 0; i < groups.length; i++) {
      signal.throwIfAborted();
      current = i;
      const group = groups[i];
      view.onGroupStart(i);
      let result;
      let blobs = null;
      // As in uploads: one more go after a crash, then skip
      for (let attempt = 1; ; attempt++) {
        result = { stats: null };
        // Response.blob() drains in memory. A pair drains together, as the worker
        // interleaves them. The signal lets Cancel stop mid-file
        const outputs = engine.filterGroup(group, {
          onProgress: (m) => view.onTransformProgress(i, m),
          onStats: (stats) => (result.stats = stats),
        });
        try {
          blobs = await Promise.all(
            outputs.map((o) => new Response(o.stream.pipeThrough(new TransformStream(), { signal })).blob())
          );
          break;
        } catch (err) {
          if (signal.aborted) throw signal.reason;
          if (err?.retry && attempt < 2) {
            view.onGroupRetry(i, group, err);
            continue;
          }
          if (err?.kind !== "input") throw err;
          console.warn(`updeacon: skipped ${group.label}:`, err);
          skipped.push(group);
          view.onGroupFailed(i, group, err);
          break;
        }
      }
      if (!blobs) continue;
      blobs.forEach((blob, j) => downloadBlob(blob, gzName(group.files[j].name)));
      totalBasesIn += Number(result.stats?.basesIn || 0);
      view.onGroupDone(i, group, result);
    }
    const done = describeGroups(groups.filter((g) => !skipped.includes(g)));
    view.finish(`Processed ${humanBases(totalBasesIn)} of input across ${done}.`);
    if (skipped.length) {
      setStatus(
        `Filtering finished: ${done} downloaded, but ${describeGroups(skipped)} couldn't be read and ` +
          `${skipped.length === 1 ? "was" : "were"} skipped. Hover a failed row for the reason.`,
        "error"
      );
    } else setStatus(`Filtering complete: ${done} downloaded`, "success");
  } catch (err) {
    busyIndicator.stop();
    if (signal.aborted) {
      view.cancel();
      setStatus("Filtering cancelled. Files already filtered have been downloaded.");
    } else {
      view.fail(current);
      console.error(err);
      setStatus("Filtering failed: " + (err?.message || err), "error");
    }
  } finally {
    cancel.end();
    setBusy(false);
  }
}

// --- Filter & upload ---------------------------------------------------------
async function uploadAll() {
  const groups = selectedFiles;
  if (!groups.length) return;
  // Own timestamped dir inside the prefix, so a reused link never overwrites
  const keyBase = (LINK ? LINK.prefix : ROOT) + uploadName.commit();
  logFilterParams(indexMeta());
  let totalBasesIn = 0;
  uploadCompleted = await uploadSelection({
    groups,
    keyBase,
    link: LINK,
    creds,
    transform: deaconTransform({ engine, indexMeta }),
    client: { app: APP, appVersion: VERSION, commit: BUILD_COMMIT, extra: { deacon_version: DEACON_VERSION } },
    spoolDir: SPOOL_DIR,
    rows: fileRows,
    view: { transform: FILTERING, doneText: readsText("uploaded") },
    runLabel: "Filtering and uploading",
    describe: describeGroups,
    onGroupDone: (_i, _item, result) => (totalBasesIn += Number(result.stats?.basesIn || 0)),
    finishText: (done) => `Processed ${humanBases(totalBasesIn)} of input across ${describeGroups(done)}.`,
    setStatus,
    setBusy,
    busyIndicator,
    cancel,
  });
  updateUploadEnabled(); // lock the buttons until the next selection
}

uploadBtn.addEventListener("click", uploadAll);
filterBtn.addEventListener("click", filterOnly);

// --- Startup -----------------------------------------------------------------
// Start index load in parallel with WASM init (bytes queue until READY). Last, so all decls exist
initIndex();
