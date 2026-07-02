// Updeacon client fa/fq dehosting & direct-to-s3 upload
import { S3Client, Upload } from "./vendor/aws-sdk.js";
import { MSG, FILTER_DEFAULTS, DEACON_VERSION, UPDEACON_VERSION } from "./protocol.js?v=20260702-141439";
import { SEQ_RE, groupRelativePaths, pairSequenceFiles } from "./pairing.js";

// --- Fixed configuration -----------------------------------------------------
// Ceph RADOS Gateway, not AWS: dummy region, forcePathStyle required (no vhost buckets)
const ENDPOINT = "https://s3.climb.ac.uk";
const BUCKET = "cli-artic-drc-co-inrb-uploads";
const REGION = "us-east-1";

const BUILD_COMMIT = "d5e2c44";

console.log(`updeacon ${UPDEACON_VERSION}: bucket "${BUCKET}" at ${ENDPOINT} (commit ${BUILD_COMMIT})`);

const ASSET_VERSION = "20260702-141439";

const PART_SIZE = 8 * 1024 * 1024;
const QUEUE_SIZE = 4;

const MAX_INDEX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

const INDEX_URL =
  "https://objectstorage.uk-london-1.oraclecloud.com/n/lrbvkel2wjot/b/human-genome-bucket/o/deacon/3/panhuman-1.k31w21.pidx";
const INDEX_FILENAME = "panhuman-1.k31w21.pidx";
const INDEX_DISPLAY_NAME = "Index: panhuman-1"; // shown in panel; filename kept for summaries

// --- DOM ---------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const bucketEl = $("bucket");
const serverEl = $("server");
const accessKeyEl = $("access-key");
const secretKeyEl = $("secret-key");
const runNameEl = $("run-name");
const namePrefixEl = $("name-prefix");
const indexStatus = $("index-status");
const indexInput = $("index-input");
const indexName = $("index-name");
const indexInfo = $("index-info");
const indexProgress = $("index-progress");
const indexRetry = $("index-retry");
const indexDownload = $("index-download");
const dirZone = $("dir-zone");
const dirInput = $("dir-input");
const dirSummary = $("dir-summary");
const uploadBtn = $("upload-btn");
const filterBtn = $("filter-btn");
const resetBtn = $("reset-btn");
const progressWrap = $("progress-wrap");
const dehostProgress = $("dehost-progress");
const dehostLabel = $("dehost-label");
const fileListEl = $("file-list");
const statusEl = $("status");
const purgeIndexEl = $("purge-index");

bucketEl.value = bucketEl.value || BUCKET;
serverEl.value = serverEl.value || ENDPOINT;

// --- State -------------------------------------------------------------------
let selectedFiles = []; // work groups: single file or paired R1/R2
let fileRows = []; // { li, st } DOM rows, one per selected group (same order)
let totalBytes = 0;
let isUploading = false;
let uploadCompleted = false; // upload finished; lock buttons until next selection
let frozenPrefix = null; // timestamp committed at upload time
let indexLoaded = false;
let indexFilename = ""; // name of the loaded .idx (recorded in summaries)
let indexK = null; // k-mer length parsed from the index info string
let indexW = null; // window size parsed from the index info string
let workerReady = false; // worker has finished WASM init (MSG.READY)
let pendingIndexBuffer = null; // index bytes waiting for the worker to be ready
let indexFailed = false; // download failed; panel acts as a manual drop target
let indexNeedsDownload = false; // not cached; panel click starts the download

// --- Helpers -----------------------------------------------------------------
function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = kind || "";
}

function humanBytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

function humanBases(bp) {
  const units = ["bp", "kbp", "Mbp", "Gbp", "Tbp"];
  let i = 0;
  while (bp >= 1000 && i < units.length - 1) {
    bp /= 1000;
    i++;
  }
  return `${bp.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

function timestampPrefix() {
  // Key-safe ISO 8601 (Zulu), no ms or colons
  return new Date().toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

function sanitizeName(s) {
  return (s || "").trim().replace(/[\s/\\]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

function uploadDirName(timestamp) {
  const name = sanitizeName(runNameEl.value);
  return name ? `${timestamp}--${name}` : timestamp;
}

function setButtonDisabled(btn, disabled) {
  btn.disabled = disabled;
  btn.classList.toggle("pulse-glow", !disabled);
}

function updateUploadEnabled() {
  if (!indexLoaded || uploadCompleted) {
    setButtonDisabled(uploadBtn, true);
    setButtonDisabled(filterBtn, true);
    return;
  }
  const haveFiles = selectedFiles.length > 0;
  setButtonDisabled(filterBtn, isUploading || !haveFiles);
  setButtonDisabled(
    uploadBtn,
    isUploading ||
      !haveFiles ||
      !bucketEl.value.trim() ||
      !serverEl.value.trim() ||
      !accessKeyEl.value.trim() ||
      !secretKeyEl.value.trim()
  );
}

// Build upload items; keys are <timestamp>/<relative path> so basenames never collide
function buildUploadItems(groups, timestamp) {
  return groups.map((group) => {
    const paths = groupRelativePaths(group);
    if (group.kind === "paired") {
      return {
        ...group,
        key: `${timestamp}/${paths.input}`,
        key2: `${timestamp}/${paths.input2}`,
      };
    }
    return {
      ...group,
      key: `${timestamp}/${paths.input}`,
    };
  });
}

function setSelection(files) {
  uploadCompleted = false; // fresh selection clears the post-upload lock
  const seqs = files.filter((f) => SEQ_RE.test(f.name));
  try {
    selectedFiles = pairSequenceFiles(seqs);
  } catch (err) {
    selectedFiles = [];
    totalBytes = 0;
    dirZone.classList.remove("loaded");
    dirSummary.textContent = "Pairing error";
    setStatus(err?.message || String(err), "error");
    renderFileList();
    updateUploadEnabled();
    return;
  }
  totalBytes = selectedFiles.reduce((sum, group) => sum + group.size, 0);

  if (seqs.length === 0) {
    dirZone.classList.remove("loaded");
    dirSummary.textContent = files.length
      ? "No fastq/fasta files found in that folder"
      : "";
  } else {
    dirZone.classList.add("loaded");
    const pairs = selectedFiles.filter((group) => group.kind === "paired").length;
    const singles = selectedFiles.length - pairs;
    const parts = [];
    if (pairs) parts.push(`${pairs} pair${pairs === 1 ? "" : "s"}`);
    if (singles) parts.push(`${singles} unpaired`);
    dirSummary.textContent = `${seqs.length} sequence file${
      seqs.length === 1 ? "" : "s"
    } selected (${parts.join(", ")}) · ${humanBytes(totalBytes)}`;
  }
  setStatus("");
  progressWrap.style.display = "none";
  renderFileList();
  updateUploadEnabled();
}

function renderFileList() {
  fileListEl.innerHTML = "";
  fileRows = selectedFiles.map((group) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = group.label;
    const st = document.createElement("span");
    st.className = "st";
    li.append(name, st);
    fileListEl.appendChild(li);
    return { li, st };
  });
  fileListEl.style.display = fileRows.length ? "" : "none";
}

// --- WASM worker (dehosting) -------------------------------------------------
const worker = new Worker(`./worker.js?v=${ASSET_VERSION}`, { type: "module" });

// Route worker replies to the active per-file handlers (one file at a time)
let onOutputBatch = null; // (msg) => void  — next OUTPUT_CHUNK_BATCH
let onDehostProgress = null; // (msg) => void  — PROGRESS for the active file
let onWorkerError = null; // (message) => void — abort the active pull

worker.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case MSG.READY:
      workerReady = true;
      // Hand over the index if it finished loading first
      if (pendingIndexBuffer) {
        const buf = pendingIndexBuffer;
        pendingIndexBuffer = null;
        worker.postMessage({ type: MSG.LOAD_INDEX, data: buf }, [buf]);
      }
      break;
    case MSG.INDEX_LOADED: {
      indexLoaded = true;
      indexFailed = false;
      indexNeedsDownload = false;
      indexStatus.classList.remove("failed", "needs-download");
      indexStatus.classList.add("loaded");
      indexProgress.style.display = "none";
      indexRetry.hidden = true;
      indexDownload.hidden = true;
      clearIndexLoading();
      indexInfo.textContent = m.info;
      // Parse k and w from info ("k=31, w=61 (… minimizers)") for summaries
      const kw = /k=(\d+),\s*w=(\d+)/.exec(m.info || "");
      indexK = kw ? Number(kw[1]) : null;
      indexW = kw ? Number(kw[2]) : null;
      setStatus("Index loaded. Select sequences and enter S3 credentials");
      updateUploadEnabled();
      break;
    }
    case MSG.PROGRESS:
      if (onDehostProgress) onDehostProgress(m);
      break;
    case MSG.OUTPUT_CHUNK_BATCH:
      if (onOutputBatch) onOutputBatch(m);
      break;
    case MSG.ERROR:
      if (onWorkerError) onWorkerError(m.message);
      else {
        clearIndexLoading();
        indexInfo.textContent = "";
        setStatus("Error: " + m.message, "error");
      }
      break;
    default:
      break;
  }
};

worker.postMessage({ type: MSG.INIT });

// ReadableStream of one file's dehosted bytes; pull-driven so the S3 consumer paces the filter
function dehostSingleStream(file, hooks) {
  return new ReadableStream({
    start() {
      onDehostProgress = hooks.onProgress;
      worker.postMessage({ type: MSG.FILTER, data: { file } });
    },
    pull(controller) {
      return new Promise((resolve, reject) => {
        onWorkerError = (message) => {
          onWorkerError = null;
          onOutputBatch = null;
          reject(new Error(message));
        };
        onOutputBatch = (m) => {
          onOutputBatch = null;
          for (const buf of m.chunks) controller.enqueue(new Uint8Array(buf));
          if (m.done) {
            onWorkerError = null;
            onDehostProgress = null;
            if (hooks.onStats) hooks.onStats(m.stats, m.elapsed);
            controller.close();
          }
          resolve();
        };
        worker.postMessage({ type: MSG.PULL });
      });
    },
    cancel() {
      // Drop handlers; worker frees its session on next FILTER
      onOutputBatch = null;
      onDehostProgress = null;
      onWorkerError = null;
    },
  });
}

function dehostGroup(group, hooks) {
  if (group.kind === "paired") {
    return dehostPairedStreams(group, hooks);
  }
  return { stream: dehostSingleStream(group.file, hooks) };
}

function dehostPairedStreams(group, hooks) {
  const state = {
    queues: { r1: [], r2: [] },
    done: false,
    pulling: null,
    started: false,
  };

  const clearHandlers = () => {
    onWorkerError = null;
    onOutputBatch = null;
  };

  const pump = () => {
    if (state.done || state.pulling) return state.pulling || Promise.resolve();
    state.pulling = new Promise((resolve, reject) => {
      onWorkerError = (message) => {
        clearHandlers();
        const err = new Error(message);
        reject(err);
      };
      onOutputBatch = (m) => {
        clearHandlers();
        for (const buf of m.chunksR1 || []) state.queues.r1.push(new Uint8Array(buf));
        for (const buf of m.chunksR2 || []) state.queues.r2.push(new Uint8Array(buf));
        if (m.done) {
          state.done = true;
          onDehostProgress = null;
          if (hooks.onStats) hooks.onStats(m.stats, m.elapsed);
        }
        resolve();
      };
      worker.postMessage({ type: MSG.PULL });
    }).finally(() => {
      state.pulling = null;
    });
    return state.pulling;
  };

  const makeStream = (mate) =>
    new ReadableStream({
      start(controller) {
        if (!state.started) {
          state.started = true;
          onDehostProgress = hooks.onProgress;
          worker.postMessage({
            type: MSG.FILTER,
            data: { file1: group.file1, file2: group.file2 },
          });
        }
      },
      async pull(controller) {
        while (!state.queues[mate].length && !state.done) {
          await pump();
        }
        const chunk = state.queues[mate].shift();
        if (chunk) {
          controller.enqueue(chunk);
        } else if (state.done) {
          controller.close();
        }
      },
      cancel() {
        clearHandlers();
        onDehostProgress = null;
      },
    });

  return { streamR1: makeStream("r1"), streamR2: makeStream("r2") };
}

// --- Index selection ----------------------------------------------------------
// Click to download (uncached) or select a local .idx (failed); drop works in either state
indexStatus.addEventListener("click", () => {
  if (isUploading) return;
  if (indexNeedsDownload) downloadAndLoadIndex();
  else if (indexFailed) indexInput.click();
});
indexStatus.addEventListener("dragover", (e) => {
  if (!(indexNeedsDownload || indexFailed)) return;
  e.preventDefault();
  if (!isUploading) indexStatus.classList.add("dragover");
});
indexStatus.addEventListener("dragleave", () => indexStatus.classList.remove("dragover"));
indexStatus.addEventListener("drop", (e) => {
  if (!(indexNeedsDownload || indexFailed)) return;
  e.preventDefault();
  indexStatus.classList.remove("dragover");
  if (isUploading) return;
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
  indexStatus.classList.remove("loaded", "failed", "needs-download", "dragover");
  indexRetry.hidden = true;
  indexDownload.hidden = true;
  updateUploadEnabled();
  indexName.textContent = file.name;
  showIndexLoading("Loading");
  setStatus(`Loading index (${(file.size / 1024 / 1024).toFixed(0)}MB)…`);
  const buf = await file.arrayBuffer();
  sendIndexToWorker(buf);
}

// --- Index auto-download + cache ---------------------------------------------
// Cache in IndexedDB (handles the ~850 MB blob) for instant offline reloads
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
    return await idbRequest(() =>
      db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(url)
    );
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
    await idbRequest(() =>
      db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).put(blob, url)
    );
  } finally {
    db.close();
  }
}

async function clearCachedIndex(url) {
  const db = await openIdxDB();
  try {
    await idbRequest(() =>
      db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).delete(url)
    );
  } finally {
    db.close();
  }
}

// GC cached indexes other than keepUrl (keyed by URL, else linger forever); run on startup
async function pruneStaleIndexes(keepUrl) {
  const db = await openIdxDB();
  try {
    const store = db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE);
    const keys = await idbRequest(() => store.getAllKeys());
    await Promise.all(
      keys
        .filter((key) => key !== keepUrl)
        .map((key) => idbRequest(() => store.delete(key)))
    );
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

function sendIndexToWorker(arrayBuffer) {
  if (workerReady) {
    worker.postMessage({ type: MSG.LOAD_INDEX, data: arrayBuffer }, [arrayBuffer]);
  } else {
    pendingIndexBuffer = arrayBuffer;
  }
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
  indexInfo.textContent =
    "No Deacon index cached. Click to download or drop an .idx/.pidx file.";
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
  indexFilename = INDEX_FILENAME;
  indexFailed = false;
  indexNeedsDownload = false;
  indexName.textContent = INDEX_DISPLAY_NAME;
  indexRetry.hidden = true;
  indexDownload.hidden = true;
  indexStatus.classList.remove("failed", "needs-download", "loaded", "dragover");
  pruneStaleIndexes(INDEX_URL).catch((e) =>
    console.warn("updeacon: failed to prune stale cached indexes", e)
  );
  try {
    const cached = await getCachedIndex(INDEX_URL);
    if (cached) {
      showIndexLoading("Loading cached index");
      setStatus("Loading cached index…");
      sendIndexToWorker(await cached.arrayBuffer());
      return;
    }
    showIndexNeedsDownload();
  } catch (err) {
    showIndexFailure(err);
  }
}

async function downloadAndLoadIndex() {
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
    await putCachedIndex(INDEX_URL, blob).catch((e) =>
      console.warn("updeacon: failed to cache index", e)
    );
    indexProgress.style.display = "none";
    showIndexLoading("Loading index");
    setStatus("Loading index…");
    sendIndexToWorker(await blob.arrayBuffer());
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
  if (isUploading) return;
  // Update the UI first — Safari's IndexedDB can stall on delete
  indexLoaded = false;
  worker.postMessage({ type: MSG.RESET });
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

// --- Directory selection -----------------------------------------------------
dirZone.addEventListener("click", () => {
  if (!isUploading) dirInput.click();
});

dirInput.addEventListener("change", () => {
  setSelection(Array.from(dirInput.files));
});

dirZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (!isUploading) dirZone.classList.add("dragover");
});
dirZone.addEventListener("dragleave", () => dirZone.classList.remove("dragover"));
dirZone.addEventListener("drop", async (e) => {
  e.preventDefault();
  dirZone.classList.remove("dragover");
  if (isUploading) return;
  const items = Array.from(e.dataTransfer.items)
    .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (items.length) {
    const files = await collectEntries(items);
    setSelection(files);
  } else {
    setSelection(Array.from(e.dataTransfer.files || []));
  }
});

// Flatten dropped FileSystemEntry tree to File[], stamping webkitRelativePath like the picker
async function collectEntries(entries, prefix = "") {
  const out = [];
  for (const entry of entries) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      try {
        Object.defineProperty(file, "webkitRelativePath", {
          value: prefix + entry.name,
          configurable: true,
        });
      } catch (_) {
        // Read-only in some browsers; key falls back to basename
      }
      out.push(file);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const children = await readAllEntries(reader);
      out.push(...(await collectEntries(children, prefix + entry.name + "/")));
    }
  }
  return out;
}

function readAllEntries(reader) {
  // readEntries returns ~100 entries per call; loop until exhausted
  return new Promise((resolve, reject) => {
    const all = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) resolve(all);
        else {
          all.push(...batch);
          next();
        }
      }, reject);
    next();
  });
}

// --- Upload ------------------------------------------------------------------
[bucketEl, serverEl, accessKeyEl, secretKeyEl].forEach((el) =>
  el.addEventListener("input", updateUploadEnabled)
);

// Tick the greyed "<timestamp>--" prefix; real value captured at upload start. Once committed,
// freeze to that timestamp so the field matches what's uploaded.
function tickNamePrefix() {
  namePrefixEl.textContent = `${frozenPrefix ?? timestampPrefix()}--`;
}
tickNamePrefix();
setInterval(tickNamePrefix, 1000);

resetBtn.addEventListener("click", () => {
  if (isUploading) return;
  dirInput.value = "";
  setSelection([]);
  dirSummary.textContent = "";
  dirZone.classList.remove("loaded");
});

uploadBtn.addEventListener("click", uploadAll);

filterBtn.addEventListener("click", filterOnly);

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

// Filter locally and download — no S3, no credentials
async function filterOnly() {
  const groups = selectedFiles;
  if (!groups.length) return;

  console.log("updeacon: deacon filter params", {
    index: indexFilename,
    k: indexK,
    w: indexW,
    deplete: FILTER_DEFAULTS.deplete,
    abs_threshold: FILTER_DEFAULTS.absThreshold,
    rel_threshold: FILTER_DEFAULTS.relThreshold,
    prefix_length: FILTER_DEFAULTS.prefixLength,
  });

  isUploading = true; // reuse the busy flag: blocks other buttons + reset
  updateUploadEnabled();
  resetBtn.disabled = true;
  setStatus("Filtering…");

  progressWrap.style.display = "block";
  dehostProgress.value = 0;
  dehostLabel.textContent = "";
  fileRows.forEach(({ li, st }) => {
    li.className = "";
    st.textContent = "queued";
  });
  const rows = fileRows;

  let dehostedBefore = 0; // input bytes of fully-dehosted files
  let totalBasesIn = 0;
  let completed = 0;
  try {
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      rows[i].li.className = "active";
      rows[i].st.textContent = "filtering…";

      let curProcessed = 0;
      let fileStats = null;

      const renderRow = () => {
        const dpct = group.size ? Math.min(100, (curProcessed / group.size) * 100) : 100;
        rows[i].st.textContent = `filtered ${dpct.toFixed(0)}%`;
      };
      const onProgress = (m) => {
        curProcessed = m.bytesProcessed || 0;
        const pct = totalBytes ? ((dehostedBefore + curProcessed) / totalBytes) * 100 : 0;
        dehostProgress.value = pct;
        dehostLabel.textContent =
          `Filtering ${i + 1} of ${groups.length} · ` +
          `${humanBytes(dehostedBefore + curProcessed)} / ${humanBytes(totalBytes)} ` +
          `(${pct.toFixed(1)}%)`;
        renderRow();
      };
      const onStats = (stats) => {
        fileStats = stats;
      };

      // Response.blob() drains the pull-stream, materialising output in memory
      const outputs = dehostGroup(group, { onProgress, onStats });
      if (group.kind === "paired") {
        const [blob1, blob2] = await Promise.all([
          new Response(outputs.streamR1).blob(),
          new Response(outputs.streamR2).blob(),
        ]);
        downloadBlob(blob1, group.file1.name);
        downloadBlob(blob2, group.file2.name);
      } else {
        const blob = await new Response(outputs.stream).blob();
        downloadBlob(blob, group.file.name);
      }

      dehostedBefore += group.size;
      totalBasesIn += Number(fileStats?.basesIn || 0);
      rows[i].li.className = "done";
      const readsIn = Number(fileStats?.readsIn || 0);
      const readsOut = Number(fileStats?.readsOut || 0);
      rows[i].st.textContent = readsIn
        ? `done · ${readsOut.toLocaleString()}/${readsIn.toLocaleString()} reads kept`
        : "done";
      completed++;
    }

    dehostProgress.value = 100;
    dehostLabel.textContent = `Processed ${humanBases(totalBasesIn)} of input across ${completed} group${completed === 1 ? "" : "s"}.`;
    setStatus(`Filtering complete: ${completed} pair${completed === 1 ? "" : "s"} downloaded`, "success");
  } catch (err) {
    const idx = completed; // the file that failed
    if (rows[idx]) {
      rows[idx].li.className = "failed";
      rows[idx].st.textContent = "failed";
    }
    console.error(err);
    setStatus("Filtering failed: " + (err?.message || err), "error");
  } finally {
    isUploading = false;
    resetBtn.disabled = false;
    updateUploadEnabled();
  }
}

async function uploadAll() {
  const accessKeyId = accessKeyEl.value.trim();
  const secretAccessKey = secretKeyEl.value.trim();
  const bucket = bucketEl.value.trim();
  const endpoint = serverEl.value.trim();

  const timestamp = timestampPrefix();
  const dirPrefix = uploadDirName(timestamp);
  const items = buildUploadItems(selectedFiles, dirPrefix);
  if (!items.length) return;

  // Commit to this name: freeze the ticking prefix and lock the field
  frozenPrefix = timestamp;
  runNameEl.readOnly = true;
  tickNamePrefix();

  console.log("updeacon: deacon filter params", {
    index: indexFilename,
    k: indexK,
    w: indexW,
    deplete: FILTER_DEFAULTS.deplete,
    abs_threshold: FILTER_DEFAULTS.absThreshold,
    rel_threshold: FILTER_DEFAULTS.relThreshold,
    prefix_length: FILTER_DEFAULTS.prefixLength,
  });

  isUploading = true;
  updateUploadEnabled();
  resetBtn.disabled = true;
  setStatus(`Uploading to ${dirPrefix}/ …`);

  progressWrap.style.display = "block";
  dehostProgress.value = 0;
  dehostLabel.textContent = "";
  fileRows.forEach(({ li, st }) => {
    li.className = "";
    st.textContent = "queued";
  });
  const rows = fileRows;

  const client = new S3Client({
    endpoint,
    region: REGION,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  let dehostedBefore = 0; // input bytes of fully-dehosted files
  let totalBasesIn = 0; // input bases dehosted (from per-file stats)

  let completed = 0;
  let inFileLoop = false;
  const uploadedKeys = []; // every object written, in upload order (manifest contents)
  try {
    // CORS probe: RGW returns the CORS header on an anonymous 403, so this resolves iff CORS works
    setStatus("Checking connection …");
    let corsOk = false;
    try {
      await fetch(`${endpoint}/${bucket}`, {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
      });
      corsOk = true;
    } catch (_) {
      corsOk = false;
    }
    if (!corsOk) {
      const e = new Error("Can't reach the object store from this page.");
      e.updeaconCause = "cors";
      throw e;
    }

    // Credential check (writes _ACCESS_KEY_ID.txt); CORS passed, so any failure here is credentials
    setStatus(`Checking credentials …`);
    try {
      await new Upload({
        client,
        params: {
          Bucket: bucket,
          Key: `${dirPrefix}/_ACCESS_KEY_ID.txt`,
          Body: new Blob([accessKeyId], { type: "text/plain" }),
          ContentType: "text/plain",
        },
      }).done();
    } catch (err) {
      err.updeaconCause = "credentials";
      throw err;
    }

    inFileLoop = true;
    setStatus(`Filtering and uploading to ${dirPrefix}`);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      rows[i].li.className = "active";
      rows[i].st.textContent = "filtering…";

      let curProcessed = 0; // input bytes dehosted for this group
      let curUploaded = 0; // output bytes uploaded for this group
      let fileStats = null;
      let fileElapsed = 0;

      const renderRow = () => {
        const dpct = item.size ? Math.min(100, (curProcessed / item.size) * 100) : 100;
        rows[i].st.textContent = `filtered ${dpct.toFixed(0)}% · uploaded ${humanBytes(curUploaded)}`;
      };
      const onProgress = (m) => {
        curProcessed = m.bytesProcessed || 0;
        const pct = totalBytes ? ((dehostedBefore + curProcessed) / totalBytes) * 100 : 0;
        dehostProgress.value = pct;
        dehostLabel.textContent =
          `Filtering ${i + 1} of ${items.length} · ` +
          `${humanBytes(dehostedBefore + curProcessed)} / ${humanBytes(totalBytes)} ` +
          `(${pct.toFixed(1)}%)`;
        renderRow();
      };
      const onStats = (stats, elapsed) => {
        fileStats = stats;
        fileElapsed = Number(elapsed) || 0;
      };

      const outputs = dehostGroup(item, { onProgress, onStats });
      if (item.kind === "paired") {
        let uploadedR1 = 0;
        let uploadedR2 = 0;
        const upR1 = new Upload({
          client,
          params: { Bucket: bucket, Key: item.key, Body: outputs.streamR1 },
          queueSize: QUEUE_SIZE,
          partSize: PART_SIZE,
        });
        const upR2 = new Upload({
          client,
          params: { Bucket: bucket, Key: item.key2, Body: outputs.streamR2 },
          queueSize: QUEUE_SIZE,
          partSize: PART_SIZE,
        });
        upR1.on("httpUploadProgress", (p) => {
          uploadedR1 = p.loaded || 0;
          curUploaded = uploadedR1 + uploadedR2;
          renderRow();
        });
        upR2.on("httpUploadProgress", (p) => {
          uploadedR2 = p.loaded || 0;
          curUploaded = uploadedR1 + uploadedR2;
          renderRow();
        });
        await Promise.all([upR1.done(), upR2.done()]);
        uploadedKeys.push(item.key, item.key2);
      } else {
        const up = new Upload({
          client,
          params: { Bucket: bucket, Key: item.key, Body: outputs.stream },
          queueSize: QUEUE_SIZE,
          partSize: PART_SIZE,
        });
        up.on("httpUploadProgress", (p) => {
          curUploaded = p.loaded || 0;
          renderRow();
        });
        await up.done();
        uploadedKeys.push(item.key);
      }

      // Upload a Deacon-style JSON summary alongside the file
      const summary = buildSummary({ item, stats: fileStats, elapsed: fileElapsed });
      const summaryKey = `${item.key}.deacon.json`;
      await new Upload({
        client,
        params: {
          Bucket: bucket,
          Key: summaryKey,
          Body: new Blob([JSON.stringify(summary, null, 2)], { type: "application/json" }),
          ContentType: "application/json",
        },
      }).done();
      uploadedKeys.push(summaryKey);

      dehostedBefore += item.size;
      totalBasesIn += Number(fileStats?.basesIn || 0);
      rows[i].li.className = "done";
      const readsIn = Number(fileStats?.readsIn || 0);
      const readsOut = Number(fileStats?.readsOut || 0);
      rows[i].st.textContent = readsIn
        ? `done · ${readsOut.toLocaleString()}/${readsIn.toLocaleString()} reads uploaded`
        : "done";
      completed++;
    }

    dehostProgress.value = 100;
    dehostLabel.textContent = `Processed ${humanBases(totalBasesIn)} of input across ${completed} group${completed === 1 ? "" : "s"}.`;

    // Write the manifest last, signalling upload completion
    setStatus("Finalising (writing manifest) …");
    await new Upload({
      client,
      params: {
        Bucket: bucket,
        Key: `${dirPrefix}/_MANIFEST.txt`,
        Body: new Blob([uploadedKeys.join("\n") + "\n"], { type: "text/plain" }),
        ContentType: "text/plain",
      },
    }).done();

    setStatus(`Upload complete (${dirPrefix})`, "success");
    uploadCompleted = true; // lock buttons until next selection
  } catch (err) {
    const idx = completed; // the file that failed
    if (inFileLoop && rows[idx]) {
      rows[idx].li.className = "failed";
      rows[idx].st.textContent = "failed";
    }
    console.error(err);
    setStatus(formatError(err), "error");
  } finally {
    isUploading = false;
    resetBtn.disabled = false;
    updateUploadEnabled();
  }
}

// Deacon-style JSON summary mirroring the CLI schema; paired groups fill input2/output2
function buildSummary({ item, stats, elapsed }) {
  const paths = groupRelativePaths(item);
  const seqsIn = Number(stats?.readsIn || 0);
  const seqsOut = Number(stats?.readsOut || 0);
  const bpIn = Number(stats?.basesIn || 0);
  const bpOut = Number(stats?.basesOut || 0);
  const t = Number(elapsed) || 0;
  const prop = (num, den) => (den > 0 ? num / den : 0);
  const rate = (n) => (t > 0 ? Math.round(n / t) : 0);
  return {
    version: DEACON_VERSION,
    updeacon_version: UPDEACON_VERSION,
    index: indexFilename,
    input: paths.input,
    input2: paths.input2,
    output: item.key,
    output2: item.kind === "paired" ? item.key2 : null,
    k: indexK,
    w: indexW,
    abs_threshold: FILTER_DEFAULTS.absThreshold,
    rel_threshold: FILTER_DEFAULTS.relThreshold,
    prefix_length: FILTER_DEFAULTS.prefixLength,
    deplete: FILTER_DEFAULTS.deplete,
    rename: false,
    rename_random: false,
    seqs_in: seqsIn,
    seqs_out: seqsOut,
    seqs_out_proportion: prop(seqsOut, seqsIn),
    seqs_removed: seqsIn - seqsOut,
    seqs_removed_proportion: prop(seqsIn - seqsOut, seqsIn),
    bp_in: bpIn,
    bp_out: bpOut,
    bp_out_proportion: prop(bpOut, bpIn),
    bp_removed: bpIn - bpOut,
    bp_removed_proportion: prop(bpIn - bpOut, bpIn),
    time: t,
    seqs_per_second: rate(seqsIn),
    bp_per_second: rate(bpIn),
    seqs_per_second_total: rate(seqsIn),
    bp_per_second_total: rate(bpIn),
  };
}

function formatError(err) {
  const name = err?.name || "Error";
  const msg = err?.message || String(err);
  // Preflight tags the cause definitively (see uploadAll)
  if (err?.updeaconCause === "credentials") {
    return (
      `Authentication failed. Check S3 credentials and try again.`
    );
  }
  if (err?.updeaconCause === "cors") {
    return (
      `Connection failed. Couldn't reach the object store from this page. The ` +
      `bucket must allow PUT/POST from this origin and expose the ETag header.`
    );
  }
  // fetch() throws TypeError on network/CORS failures; message varies by browser
  if (
    name === "TypeError" ||
    /CORS|Failed to fetch|NetworkError|Load failed/i.test(msg)
  ) {
    return (
      `${msg}. Check bucket CORS policy. The bucket must allow ` +
      `PUT/POST from this origin and expose the ETag header.`
    );
  }
  if (/AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|403/i.test(name + msg)) {
    return `${name}. Check the access key, secret key, and bucket permissions.`;
  }
  return `${name}. ${msg}`;
}

// --- Startup -----------------------------------------------------------------
// Start index load in parallel with WASM init (bytes queue until READY); last so all decls exist
initIndex();
