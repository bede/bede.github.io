// updeacon — client-side fastq/fasta dehosting + uploader for the CLIMB
// S3-compatible store.
//
// Everything runs in the browser. Each selected file is decontaminated with
// Deacon (compiled to WebAssembly, run in a Web Worker) and the filtered output
// is streamed *directly* into the S3 multipart upload as it is produced — so
// dehosting and uploading of a file happen simultaneously and contaminant reads
// never leave the machine. The AWS SDK is vendored locally as a single bundled
// module (vendor/aws-sdk.js) so the page has no runtime CDN dependency.
import { S3Client, Upload } from "./vendor/aws-sdk.js";
import { MSG, FILTER_DEFAULTS, DEACON_VERSION } from "./protocol.js?v=20260617-1";

// --- Fixed configuration -----------------------------------------------------
// CLIMB uses Ceph RADOS Gateway (S3-compatible), not real AWS, so:
//   - `endpoint` points at the gateway,
//   - `region` is a dummy value the gateway ignores but the SDK requires,
//   - `forcePathStyle` is required (RGW does not do virtual-host-style buckets).
const ENDPOINT = "https://s3.climb.ac.uk";
const BUCKET = "cli-artic-drc-co-inrb-uploads";
const REGION = "us-east-1";

const BUILD_COMMIT = "d570daf";

console.log(`updeacon: bucket "${BUCKET}" at ${ENDPOINT} (commit ${BUILD_COMMIT})`);

const ASSET_VERSION = "20260617-1";

// Matches fastq/fasta sequence files, optionally .gz compressed (fq/fa short
// forms included).
const SEQ_RE = /\.(fastq|fq|fasta|fa)(\.gz)?$/i;

// Multipart tuning: 8 MiB parts, up to 4 concurrent parts per file.
const PART_SIZE = 8 * 1024 * 1024;
const QUEUE_SIZE = 4;

// Largest index we'll try to load into browser memory.
const MAX_INDEX_BYTES = 1024 * 1024 * 1024; // 1 GB

// Recommended index, downloaded and cached automatically on first visit. The
// manual drop zone below is only a fallback for when this download fails.
const INDEX_URL =
  "https://objectstorage.uk-london-1.oraclecloud.com/n/lrbvkel2wjot/b/human-genome-bucket/o/deacon/3/panhuman-1.k31w61.idx";
const INDEX_FILENAME = "panhuman-1.k31w61.idx";
const INDEX_DISPLAY_NAME = "panhuman-1 index"; // shown in the panel; filename is kept for summaries

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
const dirZone = $("dir-zone");
const dirInput = $("dir-input");
const dirSummary = $("dir-summary");
const uploadBtn = $("upload-btn");
const resetBtn = $("reset-btn");
const progressWrap = $("progress-wrap");
const dehostProgress = $("dehost-progress");
const dehostLabel = $("dehost-label");
const fileListEl = $("file-list");
const statusEl = $("status");

// Prefill the bucket and server fields with the defaults, preserving any values
// the browser restored. BUCKET/ENDPOINT stay the source of truth for defaults.
bucketEl.value = bucketEl.value || BUCKET;
serverEl.value = serverEl.value || ENDPOINT;

// --- State -------------------------------------------------------------------
let selectedFiles = []; // { file, key } entries, sequence files only
let fileRows = []; // { li, st } DOM rows, one per selected file (same order)
let totalBytes = 0;
let isUploading = false;
let indexLoaded = false;
let indexFilename = ""; // name of the loaded .idx (recorded in summaries)
let indexK = null; // k-mer length parsed from the index info string
let indexW = null; // window size parsed from the index info string
let workerReady = false; // worker has finished WASM init (MSG.READY)
let pendingIndexBuffer = null; // index bytes waiting for the worker to be ready
let indexFailed = false; // auto-download failed; panel acts as a manual drop target

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

// Base counts use decimal SI units (1 Mbp = 1,000,000 bases).
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
  // 2026-06-13T09-12-00Z — filesystem/key-safe ISO 8601 (Zulu) without ms or colons.
  return new Date().toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

// Make a user-supplied name safe to use as a single path segment: trim, collapse
// whitespace/slashes to hyphens, and strip leading/trailing dots and hyphens.
function sanitizeName(s) {
  return (s || "").trim().replace(/[\s/\\]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

// Upload directory name: "<timestamp>" alone, or "<timestamp>--<name>" when the
// user has entered a name. The timestamp is fixed at upload time.
function uploadDirName(timestamp) {
  const name = sanitizeName(runNameEl.value);
  return name ? `${timestamp}--${name}` : timestamp;
}

function updateUploadEnabled() {
  uploadBtn.disabled =
    isUploading ||
    !indexLoaded ||
    selectedFiles.length === 0 ||
    !bucketEl.value.trim() ||
    !serverEl.value.trim() ||
    !accessKeyEl.value.trim() ||
    !secretKeyEl.value.trim();
}

// Build the upload list from a flat array of File objects. Keys are
// `<timestamp>/<relative path>`, preserving the directory structure of the
// selected folder (including the chosen folder name) and keeping filenames
// intact. Preserving full relative paths also means basenames never collide.
function buildFileList(files, timestamp) {
  return files
    .filter((f) => SEQ_RE.test(f.name))
    .map((file) => {
      // webkitRelativePath is e.g. "myrun/laneA/sample.fastq.gz"; fall back to
      // the bare filename if the browser didn't provide a relative path.
      const rel = file.webkitRelativePath || file.name;
      return { file, key: `${timestamp}/${rel}` };
    });
}

function setSelection(files) {
  // `files` here is just for display/count; keys are finalised at upload time
  // so the timestamp reflects when the upload actually starts.
  const seqs = files.filter((f) => SEQ_RE.test(f.name));
  selectedFiles = seqs.map((file) => ({ file, key: null }));
  totalBytes = seqs.reduce((sum, f) => sum + f.size, 0);

  if (seqs.length === 0) {
    dirZone.classList.remove("loaded");
    dirSummary.textContent = files.length
      ? "No fastq/fasta files found in that folder"
      : "";
  } else {
    dirZone.classList.add("loaded");
    dirSummary.textContent = `${seqs.length} sequence file${
      seqs.length === 1 ? "" : "s"
    } selected · ${humanBytes(totalBytes)}`;
  }
  setStatus("");
  progressWrap.style.display = "none";
  renderFileList();
  updateUploadEnabled();
}

// (Re)build the file list from the current selection, one row per file with a
// blank status. Materialised as soon as files are selected; the rows are reused
// (statuses set to "queued", then updated) when the upload starts.
function renderFileList() {
  fileListEl.innerHTML = "";
  fileRows = selectedFiles.map(({ file }) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = file.name;
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

// While a file is being filtered these route the worker's streaming replies to
// the active per-file handlers (one file is processed at a time).
let onOutputBatch = null; // (msg) => void  — next OUTPUT_CHUNK_BATCH
let onDehostProgress = null; // (msg) => void  — PROGRESS for the active file
let onWorkerError = null; // (message) => void — abort the active pull

worker.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case MSG.READY:
      workerReady = true;
      // If the index download/cache lookup already finished, hand it over now.
      if (pendingIndexBuffer) {
        const buf = pendingIndexBuffer;
        pendingIndexBuffer = null;
        worker.postMessage({ type: MSG.LOAD_INDEX, data: buf }, [buf]);
      }
      break;
    case MSG.INDEX_LOADED: {
      indexLoaded = true;
      indexFailed = false;
      indexStatus.classList.remove("failed");
      indexStatus.classList.add("loaded");
      indexProgress.style.display = "none";
      indexRetry.hidden = true;
      indexInfo.textContent = m.info;
      // info looks like "k=31, w=61 (12,345 minimizers)" — pull out k and w for
      // the per-file JSON summaries.
      const kw = /k=(\d+),\s*w=(\d+)/.exec(m.info || "");
      indexK = kw ? Number(kw[1]) : null;
      indexW = kw ? Number(kw[2]) : null;
      setStatus("Index loaded. Select sequences and enter S3 credentials.");
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
        indexInfo.textContent = "";
        setStatus("Error: " + m.message, "error");
      }
      break;
    default:
      break;
  }
};

worker.postMessage({ type: MSG.INIT });

// Returns a ReadableStream of the dehosted bytes of `file`. The stream is
// pull-driven: each `pull` asks the worker for the next output batch, so the S3
// upload (which consumes this stream) paces the WASM filter and memory stays
// bounded. `hooks.onProgress(msg)` fires as input is consumed;
// `hooks.onStats(stats)` fires once when filtering completes.
function dehostStream(file, hooks) {
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
      // Drop our handlers; the worker disposes its session on the next FILTER.
      onOutputBatch = null;
      onDehostProgress = null;
      onWorkerError = null;
    },
  });
}

// --- Index selection (manual fallback) ---------------------------------------
// The index panel only behaves as a drop/click target once auto-download has
// failed (indexFailed); otherwise it's a passive status display.
indexStatus.addEventListener("click", () => {
  if (indexFailed && !isUploading) indexInput.click();
});
indexStatus.addEventListener("dragover", (e) => {
  if (!indexFailed) return;
  e.preventDefault();
  if (!isUploading) indexStatus.classList.add("dragover");
});
indexStatus.addEventListener("dragleave", () => indexStatus.classList.remove("dragover"));
indexStatus.addEventListener("drop", (e) => {
  if (!indexFailed) return;
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
        `Maximum supported size is ${MAX_INDEX_BYTES / 1024 / 1024 / 1024}GB.`,
      "error"
    );
    return;
  }
  indexLoaded = false;
  indexFailed = false;
  indexFilename = file.name;
  indexStatus.classList.remove("loaded", "failed", "dragover");
  indexRetry.hidden = true;
  updateUploadEnabled();
  indexName.textContent = file.name;
  indexInfo.textContent = "Loading…";
  setStatus(`Loading index (${(file.size / 1024 / 1024).toFixed(0)}MB)…`);
  const buf = await file.arrayBuffer();
  sendIndexToWorker(buf);
}

// --- Index auto-download + cache ---------------------------------------------
// The recommended index is fetched once and cached in IndexedDB so reloads are
// instant and work offline. IndexedDB (not localStorage/Cache API) is used
// because it reliably stores the ~850 MB binary blob.
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
  // Ask the browser to keep this large blob around rather than evict it.
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

// Hand index bytes to the worker, or stash them until the worker reports READY.
function sendIndexToWorker(arrayBuffer) {
  if (workerReady) {
    worker.postMessage({ type: MSG.LOAD_INDEX, data: arrayBuffer }, [arrayBuffer]);
  } else {
    pendingIndexBuffer = arrayBuffer;
  }
}

// Stream the index down with progress, returning it as a Blob. Throws on a
// non-OK response or a network/CORS failure.
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

// Turn the index panel itself into the manual fallback: a clickable/droppable
// dashed target with a Retry button. Keeps everything in one box rather than
// stacking a separate drop zone and an error banner.
function showIndexFailure(err) {
  console.error(err);
  indexFailed = true;
  indexProgress.style.display = "none";
  indexName.textContent = INDEX_DISPLAY_NAME;
  indexInfo.textContent =
    `Automatic download failed (${err?.message || err}). ` +
    "Click to select a local .idx, drag one here, or retry.";
  indexRetry.hidden = false;
  indexStatus.classList.remove("loaded");
  indexStatus.classList.add("failed");
  setStatus("");
}

// Orchestrate startup: load the cached index if present, otherwise download and
// cache it, then hand the bytes to the worker for immediate use.
async function initIndex() {
  indexFilename = INDEX_FILENAME;
  indexFailed = false;
  indexName.textContent = INDEX_DISPLAY_NAME;
  indexRetry.hidden = true;
  indexStatus.classList.remove("failed", "loaded", "dragover");
  try {
    const cached = await getCachedIndex(INDEX_URL);
    if (cached) {
      indexInfo.textContent = "Loading cached index…";
      setStatus("Loading cached index…");
      sendIndexToWorker(await cached.arrayBuffer());
      return;
    }
    indexInfo.textContent = "Downloading index…";
    setStatus("Downloading recommended index…");
    showIndexProgress(0, 0);
    const blob = await downloadIndex(INDEX_URL, showIndexProgress);
    await putCachedIndex(INDEX_URL, blob).catch((e) =>
      console.warn("updeacon: failed to cache index", e)
    );
    indexProgress.style.display = "none";
    indexInfo.textContent = "Loading index…";
    setStatus("Loading index…");
    sendIndexToWorker(await blob.arrayBuffer());
  } catch (err) {
    showIndexFailure(err);
  }
}

indexRetry.addEventListener("click", (e) => {
  e.stopPropagation(); // don't trigger the panel's click-to-select fallback
  initIndex();
});

// --- Directory selection -----------------------------------------------------
dirZone.addEventListener("click", () => {
  if (!isUploading) dirInput.click();
});

dirInput.addEventListener("change", () => {
  setSelection(Array.from(dirInput.files));
});

// Drag-and-drop of a folder (Chromium/WebKit) via the entries API.
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

// Recursively walk dropped FileSystemEntry objects into a flat File[] list,
// stamping webkitRelativePath so collision handling works the same as the picker.
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
        // Some browsers make this read-only; key falls back to basename.
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
  // readEntries returns at most ~100 entries per call; loop until exhausted.
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
// Access key ID persistence is left to the browser's native form autofill (the
// field has a name + autocomplete). The secret key field has autocomplete off,
// so the browser won't offer to remember it.
[bucketEl, serverEl, accessKeyEl, secretKeyEl].forEach((el) =>
  el.addEventListener("input", updateUploadEnabled)
);

// Keep the greyed, non-editable "<timestamp>--" prefix in the name field showing
// the current Zulu time, so the caret sits right after the "--". (If no name is
// entered the final directory drops the "--"; see uploadDirName.) The real value
// is captured when the upload actually starts.
function tickNamePrefix() {
  namePrefixEl.textContent = `${timestampPrefix()}--`;
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

async function uploadAll() {
  const accessKeyId = accessKeyEl.value.trim();
  const secretAccessKey = secretKeyEl.value.trim();
  const bucket = bucketEl.value.trim();
  const endpoint = serverEl.value.trim();

  const timestamp = timestampPrefix();
  const dirPrefix = uploadDirName(timestamp); // <timestamp> or <timestamp>--<name>
  const items = buildFileList(
    selectedFiles.map((s) => s.file),
    dirPrefix
  );
  if (!items.length) return;

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

  // Reuse the rows already materialised at selection time, resetting them to
  // "queued" (order matches `items`, which is built from the same selection).
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

  // Overall progress is an exact % of input bytes dehosted (we know the source
  // sizes). Per-file rows additionally show bytes uploaded.
  let dehostedBefore = 0; // input bytes of fully-dehosted files
  let totalBasesIn = 0; // input bases dehosted (from per-file stats)

  let completed = 0;
  let inFileLoop = false;
  try {
    // Write a marker object recording the uploader's access key ID into the
    // timestamped directory before any sequence files. Doubles as an early
    // CORS/credentials check before the (potentially large) uploads start.
    setStatus(`Creating ${dirPrefix}/access_key_id …`);
    await new Upload({
      client,
      params: {
        Bucket: bucket,
        Key: `${dirPrefix}/access_key_id`,
        Body: new Blob([accessKeyId], { type: "text/plain" }),
        ContentType: "text/plain",
      },
    }).done();

    inFileLoop = true;
    setStatus(`Filtering and uploading to ${dirPrefix}`);
    for (let i = 0; i < items.length; i++) {
      const { file, key } = items[i];
      rows[i].li.className = "active";
      rows[i].st.textContent = "filtering…";

      let curProcessed = 0; // input bytes dehosted for this file
      let curUploaded = 0; // output bytes uploaded for this file
      let fileStats = null;
      let fileElapsed = 0;

      const renderRow = () => {
        const dpct = file.size ? Math.min(100, (curProcessed / file.size) * 100) : 100;
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

      const stream = dehostStream(file, { onProgress, onStats });
      const up = new Upload({
        client,
        params: { Bucket: bucket, Key: key, Body: stream },
        queueSize: QUEUE_SIZE,
        partSize: PART_SIZE,
      });
      up.on("httpUploadProgress", (p) => {
        curUploaded = p.loaded || 0;
        renderRow();
      });

      await up.done();

      // Upload a Deacon-style JSON summary alongside the dehosted file.
      const summary = buildSummary({ file, key, stats: fileStats, elapsed: fileElapsed });
      await new Upload({
        client,
        params: {
          Bucket: bucket,
          Key: `${key}.deacon.json`,
          Body: new Blob([JSON.stringify(summary, null, 2)], { type: "application/json" }),
          ContentType: "application/json",
        },
      }).done();

      dehostedBefore += file.size;
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
    dehostLabel.textContent = `Processed ${humanBases(totalBasesIn)} of input across ${completed} file${completed === 1 ? "" : "s"}.`;
    setStatus(`Upload complete (${dirPrefix})`, "success");
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

// Build a Deacon-style JSON summary for one dehosted file, mirroring the schema
// the `deacon` CLI emits. Counts come from the WASM session's stats; thresholds
// and version come from the shared config. Fields that don't apply to the
// browser pipeline (paired reads, renaming, separate total timing) are left at
// their inert defaults.
function buildSummary({ file, key, stats, elapsed }) {
  const seqsIn = Number(stats?.readsIn || 0);
  const seqsOut = Number(stats?.readsOut || 0);
  const bpIn = Number(stats?.basesIn || 0);
  const bpOut = Number(stats?.basesOut || 0);
  const t = Number(elapsed) || 0;
  const prop = (num, den) => (den > 0 ? num / den : 0);
  const rate = (n) => (t > 0 ? Math.round(n / t) : 0);
  return {
    version: DEACON_VERSION,
    index: indexFilename,
    input: file.webkitRelativePath || file.name,
    input2: null,
    output: key,
    output2: null,
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
  // The overwhelmingly common browser-upload failure is a missing/incorrect
  // CORS policy on the bucket; surface a hint rather than a bare network error.
  if (
    name === "TypeError" ||
    /CORS|Failed to fetch|NetworkError|Load failed/i.test(msg)
  ) {
    return (
      `Upload failed: ${msg}\n\n` +
      `This is usually a CORS or network issue. The bucket must allow PUT/POST ` +
      `from this origin and expose the ETag header — see the README.`
    );
  }
  if (/AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|403/i.test(name + msg)) {
    return `Upload failed (authentication/authorisation): ${name}: ${msg}\n\nCheck the access key, secret key, and bucket permissions.`;
  }
  return `Upload failed: ${name}: ${msg}`;
}

// --- Startup -----------------------------------------------------------------
// Kick off the index download/cache lookup, in parallel with WASM init;
// sendIndexToWorker queues the bytes until the worker reports READY. Invoked
// last so all module-level declarations (IndexedDB constants, helpers) are
// initialized before it runs.
initIndex();
