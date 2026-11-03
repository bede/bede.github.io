// updeacon-s3: filter fa/fq with Deacon in the browser, then upload to S3 via seq2bucket
import { DEACON_VERSION } from "./protocol.js?v=6667cc5";
import { createDeaconEngine, deaconTransform, gzName, logFilterParams } from "./deacon.js?v=6667cc5";
import { describeGroups } from "./seq2bucket/pairing.js?v=6667cc5";
import { parseMagicLink } from "./seq2bucket/link.js?v=6667cc5";
import { purgeStaleSpools } from "./seq2bucket/spool.js?v=6667cc5";
import { clientRecord, findOversizeFiles, runUpload } from "./seq2bucket/pipeline.js?v=6667cc5";
import { makeLinkUploader } from "./seq2bucket/uploaders.js?v=6667cc5";
import { VERSION, BUILD_COMMIT } from "./seq2bucket/version.js?v=6667cc5";
import {
  bindCredentialForm,
  bindFilePicker,
  bindUploadName,
  formatError,
  humanBases,
  humanBytes,
  makeBusyIndicator,
  makeRunView,
  makeStatus,
  oversizeMessage,
  renderFileList,
  renderLinkBanner,
  renderLinkError,
  selectSequences,
  setButtonDisabled,
} from "./seq2bucket/ui.js?v=6667cc5";

// --- Fixed configuration -----------------------------------------------------
const MAX_INDEX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

const INDEX_URL =
  "https://objectstorage.uk-london-1.oraclecloud.com/n/lrbvkel2wjot/b/human-genome-bucket/o/deacon/3/panhuman-1.k31w25c9b16.pidx";
const INDEX_FILENAME = "panhuman-1.k31w25c9b16.pidx";
const INDEX_DISPLAY_NAME = "Index: panhuman-1"; // shown in panel; filename kept for summaries

// --- Magic link --------------------------------------------------------------
// Signed POST policy in the fragment, so it never reaches the web server
let LINK = null;
let linkError = null;
try {
  LINK = parseMagicLink(location.hash);
} catch (err) {
  linkError = err.message;
}

// --- DOM ---------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
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
const runProgress = $("run-progress");
const runLabel = $("run-label");
const fileListEl = $("file-list");
const purgeIndexEl = $("purge-index");
const credsEl = $("creds");
const linkBannerEl = $("link-banner");
const usageCredsEl = $("usage-creds");
const usageLinkEl = $("usage-link");

const setStatus = makeStatus($("status"));
const uploadName = bindUploadName({ prefixEl: $("name-prefix"), inputEl: $("run-name") });
// No heading animation on updeacon; this just puts the percentage in the tab title
const busyIndicator = makeBusyIndicator({ mascot: null, progress: runProgress, name: "updeacon-s3" });
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
let selectedFiles = []; // work groups: single file or paired R1/R2
let fileRows = []; // { li, st } DOM rows, one per selected group (same order)
let isBusy = false; // filtering or uploading; blocks other actions
let uploadCompleted = false; // upload finished; lock buttons until next selection
let indexLoaded = false;
let indexFilename = ""; // name of the loaded .idx (recorded in summaries)
let indexK = null; // k-mer length parsed from the index info string
let indexW = null; // window size parsed from the index info string
let indexFailed = false; // download failed; panel acts as a manual drop target
let indexNeedsDownload = false; // not cached; panel click starts the download
let linkExpired = false; // magic link is past its expiry (server enforces too)
let oversizeFiles = []; // inputs above the link's per-object cap

const indexMeta = () => ({ filename: indexFilename, k: indexK, w: indexW });

// --- Helpers -----------------------------------------------------------------
// What the user still has to do, given index, selection and mode
function readyStatus() {
  if (!indexLoaded) return "";
  if (!selectedFiles.length) {
    return LINK
      ? "Index loaded. Select sequences to filter and upload"
      : "Index loaded. Select sequences and enter S3 credentials";
  }
  if (LINK && linkExpired) return "";
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
  const uploadBlocked = LINK ? linkExpired || oversizeFiles.length > 0 : !creds.filled();
  setButtonDisabled(uploadBtn, isBusy || !haveFiles || !!linkError || uploadBlocked);
}

function setBusy(busy) {
  isBusy = busy;
  resetBtn.disabled = busy;
  updateUploadEnabled();
  if (busy) busyIndicator.start();
  else busyIndicator.finish();
}

// --- Mode: magic link vs S3 credentials --------------------------------------
function renderBanner() {
  linkExpired = renderLinkBanner(linkBannerEl, LINK);
}

function initMode() {
  if (linkError) {
    // Banner, not #status: initIndex() overwrites #status moments later
    credsEl.hidden = true;
    renderLinkError(linkBannerEl, `${linkError} Ask whoever sent it for a new one.`);
    return;
  }
  if (!LINK) {
    console.log(`updeacon ${VERSION}: credential mode, bucket "${creds.bucket()}" (commit ${BUILD_COMMIT})`);
    return;
  }

  // Never log the link itself: the signature is a bearer credential
  console.log(
    `updeacon ${VERSION}: magic-link upload to "${LINK.bucket}/${LINK.prefix}" ` +
      `at ${LINK.endpoint} (commit ${BUILD_COMMIT})`
  );
  credsEl.hidden = true;
  $("mint-entry").hidden = true; // link recipients have no keys to sign with
  usageCredsEl.hidden = true;
  usageLinkEl.hidden = false;
  linkBannerEl.hidden = false;
  renderBanner();
  setInterval(renderBanner, 60000); // tick the countdown, and expire in place
  purgeStaleSpools();
}

// --- Selection ---------------------------------------------------------------
function setSelection(files) {
  busyIndicator.stop(); // a new selection or Reset clears a finished run's title
  uploadCompleted = false; // fresh selection clears the post-upload lock
  uploadName.rearm(); // a link is reusable
  const sel = selectSequences(files);
  selectedFiles = sel.groups;
  dirSummary.textContent = sel.summary;
  dirZone.classList.toggle("loaded", sel.groups.length > 0);
  oversizeFiles = LINK ? findOversizeFiles(selectedFiles, LINK.maxBytes) : [];
  if (sel.error) setStatus(sel.error, "error");
  else if (oversizeFiles.length) {
    setStatus(
      oversizeMessage(oversizeFiles, LINK.maxBytes, "Remove these files, or upload them with S3 credentials."),
      "error"
    );
  } else setStatus(readyStatus());
  progressWrap.style.display = "none";
  fileRows = renderFileList(fileListEl, selectedFiles);
  updateUploadEnabled();
}

bindFilePicker({ zone: dirZone, input: dirInput, isBusy: () => isBusy, onFiles: setSelection });

resetBtn.addEventListener("click", () => {
  if (isBusy) return;
  dirInput.value = "";
  setSelection([]);
});

// --- Deacon engine -----------------------------------------------------------
const engine = createDeaconEngine({
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
// Click to download (uncached) or select a local .idx (failed); drop works in either state
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
// database name predates seq2bucket; renaming it would force a re-download.
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

// GC cached indexes other than keepUrl (keyed by URL, else linger forever); run on startup
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
  // Update the UI first — Safari's IndexedDB can stall on delete
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
  setBusy(true);
  setStatus("Filtering…");

  const view = makeRunView({
    wrap: progressWrap,
    bar: runProgress,
    label: runLabel,
    rows: fileRows,
    groups,
    filtering: true,
    doneText: readsText("kept"),
  });
  let totalBasesIn = 0;
  let completed = 0;
  try {
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      view.onGroupStart(i);
      const result = { stats: null };
      // Response.blob() drains the pull-stream, materialising output in memory
      const outputs = engine.filterGroup(group, {
        onProgress: (m) => view.onTransformProgress(i, m),
        onStats: (stats) => (result.stats = stats),
      });
      if (group.kind === "paired") {
        const [blob1, blob2] = await Promise.all([
          new Response(outputs.streamR1).blob(),
          new Response(outputs.streamR2).blob(),
        ]);
        downloadBlob(blob1, gzName(group.file1.name));
        downloadBlob(blob2, gzName(group.file2.name));
      } else {
        downloadBlob(await new Response(outputs.stream).blob(), gzName(group.file.name));
      }
      totalBasesIn += Number(result.stats?.basesIn || 0);
      view.onGroupDone(i, group, result);
      completed++;
    }
    const done = describeGroups(groups.slice(0, completed));
    view.finish(`Processed ${humanBases(totalBasesIn)} of input across ${done}.`);
    setStatus(`Filtering complete: ${done} downloaded`, "success");
  } catch (err) {
    busyIndicator.stop();
    view.fail(completed);
    console.error(err);
    setStatus("Filtering failed: " + (err?.message || err), "error");
  } finally {
    setBusy(false);
  }
}

// --- Filter & upload ---------------------------------------------------------
async function uploadAll() {
  const groups = selectedFiles;
  if (!groups.length) return;
  const dirName = uploadName.commit();
  // Own timestamped dir inside the prefix, so a reused link never overwrites
  const keyBase = LINK ? LINK.prefix + dirName : dirName;

  logFilterParams(indexMeta());
  setBusy(true);
  setStatus(`Uploading to ${dirName}/ …`);

  const uploader = LINK
    ? makeLinkUploader({
        link: LINK,
        buildClientRecord: () =>
          clientRecord({
            app: "updeacon",
            transform: "deacon",
            groups,
            extra: { deacon_version: DEACON_VERSION },
          }),
        humanBytes,
        onStatus: setStatus,
        runVerb: "Filtering and uploading",
      })
    : creds.uploader({ onStatus: setStatus });

  const view = makeRunView({
    wrap: progressWrap,
    bar: runProgress,
    label: runLabel,
    rows: fileRows,
    groups,
    filtering: true,
    streaming: !LINK, // credential mode streams filtered output into a multipart upload
    doneText: readsText("uploaded"),
  });
  let totalBasesIn = 0;
  let completed = 0;
  try {
    await runUpload({
      groups,
      keyBase,
      uploader,
      transform: deaconTransform({ engine, indexMeta }),
      hooks: {
        ...view,
        onGroupStart(i, item) {
          if (i === 0) setStatus(`Filtering and uploading to ${keyBase}`);
          view.onGroupStart(i, item);
        },
        onGroupDone(i, item, result) {
          totalBasesIn += Number(result.stats?.basesIn || 0);
          completed++;
          view.onGroupDone(i, item, result);
        },
        onFinalising() {
          view.finish(
            `Processed ${humanBases(totalBasesIn)} of input across ${describeGroups(groups.slice(0, completed))}.`
          );
          setStatus("Finalising (writing manifest) …");
        },
      },
    });
    setStatus(`Upload complete (${keyBase})`, "success");
    uploadCompleted = true; // lock buttons until next selection
  } catch (err) {
    busyIndicator.stop();
    if (err?.groupIndex != null) view.fail(err.groupIndex);
    console.error(err);
    setStatus(formatError(err), "error");
  } finally {
    setBusy(false);
  }
}

uploadBtn.addEventListener("click", uploadAll);
filterBtn.addEventListener("click", filterOnly);

// --- Startup -----------------------------------------------------------------
// Start index load in parallel with WASM init (bytes queue until READY); last so all decls exist
initMode();
initIndex();
