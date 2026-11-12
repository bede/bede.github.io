// updeacon-s3: filter fa/fq with Deacon in the browser, then upload via sssender
import { DEACON_VERSION } from "./protocol.js?v=3c29449-dirty-20261112164946";
import { createDeaconEngine, deaconTransform, gzName, logFilterParams } from "./deacon.js?v=3c29449-dirty-20261112164946";
import {
  FILTER_INDEX_URL as INDEX_URL,
  clearCachedIndex,
  downloadIndex,
  getCachedIndex,
  pruneStaleIndexes,
  putCachedIndex,
} from "./index-cache.js?v=3c29449-dirty-20261112164946";
import { SEQ_RE, describeGroups, isPaired, pairSequenceFiles } from "./pairing.js?v=3c29449-dirty-20261112164946";
import { VERSION, BUILD_COMMIT } from "./version.js?v=3c29449-dirty-20261112164946";
import { purgeStaleSpools } from "./sssender/core/spool.js?v=3c29449-dirty-20261112164946";
import { findOversizeFiles } from "./sssender/core/pipeline.js?v=3c29449-dirty-20261112164946";
import { makeRunView, renderFileList } from "./sssender/ui/run-view.js?v=3c29449-dirty-20261112164946";
import { bindCancel, bindSelection, readMagicLink, showMode, uploadSelection } from "./sssender/ui/upload-page.js?v=3c29449-dirty-20261112164946";
import {
  bindCredentialForm,
  bindUploadName,
  humanBytes,
  makeBusyIndicator,
  makeStatus,
  oversizeMessage,
  plural,
  setButtonDisabled,
  summariseSelection,
} from "./sssender/ui/ui.js?v=3c29449-dirty-20261112164946";

const APP = "updeacon";
const ROOT = "updeacon/"; // matches mint.html's data-root
const SPOOL_DIR = "updeacon-spool"; // renaming would orphan old spools
const MAX_INDEX_BYTES = 2 * 1024 * 1024 * 1024;
const INDEX_FILENAME = INDEX_URL.split("/").pop();
const INDEX_DISPLAY_NAME = "Index: panhuman-1";

const { link: LINK, linkError } = readMagicLink();

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
for (const a of document.querySelectorAll(".index-link")) a.href = INDEX_URL;

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

let selectedFiles = []; // groups
let fileRows = [];
let isBusy = false;
let uploadCompleted = false; // locks buttons until the next selection
let oversizeFiles = []; // inputs above the link's per-object cap
let indexState = "loading"; // see setIndexState
let indexFile = null; // a dropped index, else use the cache
let indexFilename = "";
let indexK = null;
let indexW = null;

const indexMeta = () => ({ filename: indexFilename, k: indexK, w: indexW });
const indexLoaded = () => indexState === "loaded";
const indexDroppable = () => indexState === "needs-download" || indexState === "failed";

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
  if (!indexLoaded()) return "";
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
  if (!indexLoaded() || uploadCompleted) {
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

// "2 pairs, 1 unpaired", only when something paired
function pairingDetails(sel) {
  const pairs = sel.groups.filter(isPaired).length;
  const unpaired = sel.groups.length - pairs;
  if (!pairs) return [];
  return [plural(pairs, "pair"), ...(unpaired ? [`${unpaired} unpaired`] : [])];
}

const selection = bindSelection({
  options: { accept: (f) => SEQ_RE.test(f.name), group: pairSequenceFiles },
  summarise: (sel) =>
    sel.error ? "Pairing error" : summariseSelection(sel, { noun: "sequence file", details: pairingDetails }),
  isBusy: () => isBusy,
  onChange(sel) {
    busyIndicator.stop(); // clears a finished run's title
    uploadCompleted = false;
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

// Index panel: loading, downloading, loaded, needs-download or failed.
// The last two accept a dropped index
function setIndexState(state, { name = INDEX_DISPLAY_NAME, info = "" } = {}) {
  indexState = state;
  indexStatus.classList.remove("loaded", "needs-download", "failed", "dragover");
  if (indexLoaded() || indexDroppable()) indexStatus.classList.add(state);
  indexName.textContent = name;
  indexInfo.textContent = info;
  indexInfo.classList.toggle("loading-dots", state === "loading");
  indexProgress.style.display = state === "downloading" ? "" : "none";
  indexRetry.hidden = state !== "failed";
  indexDownload.hidden = state !== "needs-download";
  updateUploadEnabled();
}

function showIndexNeedsDownload() {
  // The download button stands in for the title
  setIndexState("needs-download", {
    name: "",
    info: "No Deacon index cached. Click to download or drop an .idx/.pidx file.",
  });
  // Restart the animation
  indexDownload.classList.remove("pulse-glow");
  void indexDownload.offsetWidth;
  indexDownload.classList.add("pulse-glow");
  setStatus("");
}

function showIndexFailure(reason) {
  const info = `${reason.replace(/\.$/, "")}. Click to select a local .idx/.pidx file, drag one here, or retry.`;
  setIndexState("failed", { info });
  setStatus("");
}

function showIndexProgress(received, total) {
  if (total) {
    const pct = (received / total) * 100;
    indexProgress.value = pct;
    indexInfo.textContent = `${humanBytes(received)} / ${humanBytes(total)} (${pct.toFixed(0)}%)`;
  } else {
    indexProgress.removeAttribute("value");
    indexInfo.textContent = `${humanBytes(received)} downloaded`;
  }
}

const engine = createDeaconEngine({
  // After a crash, as the dead worker had the bytes
  async reloadIndex() {
    const source = indexFile ?? (await getCachedIndex(INDEX_URL));
    if (!source) throw new Error("the index is no longer cached. Load it again");
    return source.arrayBuffer();
  },
  onIndexLoaded(info, { k, w }) {
    indexK = k;
    indexW = w;
    setIndexState("loaded", { name: indexName.textContent, info });
    setStatus(readyStatus());
  },
  onError(message) {
    if (!indexLoaded()) showIndexFailure(message);
    setStatus("Error: " + message, "error");
  },
});

// Click to download (uncached) or select a local .idx (failed). Drop works in either state
indexStatus.addEventListener("click", () => {
  if (isBusy) return;
  if (indexState === "needs-download") downloadAndLoadIndex();
  else if (indexState === "failed") indexInput.click();
});
indexStatus.addEventListener("dragover", (e) => {
  if (!indexDroppable()) return;
  e.preventDefault();
  if (!isBusy) indexStatus.classList.add("dragover");
});
indexStatus.addEventListener("dragleave", () => indexStatus.classList.remove("dragover"));
indexStatus.addEventListener("drop", (e) => {
  if (!indexDroppable()) return;
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
  indexFilename = file.name;
  indexFile = file;
  setIndexState("loading", { name: file.name, info: "Loading" });
  setStatus(`Loading index (${(file.size / 1024 / 1024).toFixed(0)}MB)…`);
  engine.loadIndex(await file.arrayBuffer());
}

// Load the cached index, else prompt to download
async function initIndex() {
  indexFile = null;
  indexFilename = INDEX_FILENAME;
  setIndexState("loading");
  pruneStaleIndexes().catch((e) => console.warn("updeacon: failed to prune stale cached indexes", e));
  try {
    const cached = await getCachedIndex(INDEX_URL);
    if (!cached) return showIndexNeedsDownload();
    setIndexState("loading", { info: "Loading cached index" });
    setStatus("Loading cached index…");
    engine.loadIndex(await cached.arrayBuffer());
  } catch (err) {
    console.error(err);
    showIndexFailure(`Couldn't read the index cache (${err?.message || err})`);
  }
}

async function downloadAndLoadIndex() {
  indexFile = null;
  indexFilename = INDEX_FILENAME;
  setIndexState("downloading");
  setStatus("Downloading index…");
  try {
    showIndexProgress(0, 0);
    const blob = await downloadIndex(INDEX_URL, showIndexProgress);
    await putCachedIndex(INDEX_URL, blob).catch((e) => console.warn("updeacon: failed to cache index", e));
    setIndexState("loading", { info: "Loading index" });
    setStatus("Loading index…");
    engine.loadIndex(await blob.arrayBuffer());
  } catch (err) {
    console.error(err);
    showIndexFailure(`Download failed (${err?.message || err})`);
  }
}

for (const button of [indexDownload, indexRetry]) {
  button.addEventListener("click", (e) => {
    e.stopPropagation(); // the panel's own click handler would download again
    downloadAndLoadIndex();
  });
}

purgeIndexEl.addEventListener("click", async (e) => {
  e.preventDefault();
  if (isBusy) return;
  // Update the UI first, as Safari's IndexedDB can stall on delete
  engine.reset();
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

const FILTERING = { verb: "filtering", past: "filtered" };

const readsText = (verb) => (_item, { stats }) => {
  const readsIn = Number(stats?.readsIn || 0);
  const readsOut = Number(stats?.readsOut || 0);
  return readsIn ? `done. ${readsOut.toLocaleString()}/${readsIn.toLocaleString()} reads ${verb}` : "done";
};

// Filter and download locally, no S3
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
  const skipped = []; // unreadable groups
  let current = 0;
  try {
    for (let i = 0; i < groups.length; i++) {
      signal.throwIfAborted();
      current = i;
      const group = groups[i];
      view.onGroupStart(i);
      let result;
      let blobs = null;
      // Retry once after a crash, then skip, as in uploads
      for (let attempt = 1; ; attempt++) {
        result = { stats: null };
        // Mates drain together, as the worker interleaves them. signal lets Cancel stop mid-file
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
  updateUploadEnabled();
}

uploadBtn.addEventListener("click", uploadAll);
filterBtn.addEventListener("click", filterOnly);

// The engine holds the index until WASM is ready
initIndex();
