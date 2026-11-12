// sapiometer: in-browser human-content check
import { CHECK_DEFAULTS } from "./protocol.js?v=3c29449-dirty-20261112164946";
import { createDeaconEngine } from "./deacon.js?v=3c29449-dirty-20261112164946";
import { CHECK_INDEX_URL, downloadIndex, getCachedIndex, putCachedIndex } from "./index-cache.js?v=3c29449-dirty-20261112164946";
import { SEQ_RE, pairSequenceFiles } from "./pairing.js?v=3c29449-dirty-20261112164946";

const WARN_THRESHOLD = 0.01; // >1% human is amber
const HIGH_THRESHOLD = 0.05; // >5% human is red

const $ = (id) => document.getElementById(id);
const dropZone = $("drop-zone");
const fileInput = $("file-input");
const dropSummary = $("drop-summary");
const statusEl = $("status");

let busy = false;
let indexLoad = null;
let indexWaiter = null; // { resolve, reject } for indexLoad

function setStatus(msg, kind) {
  statusEl.textContent = msg || "";
  statusEl.className = kind || "";
}

function setProgress(pct) {
  statusEl.style.setProperty("--progress", `${Math.max(0, Math.min(100, pct))}%`);
}

const engine = createDeaconEngine({
  params: CHECK_DEFAULTS,
  async reloadIndex() {
    const cached = await getCachedIndex(CHECK_INDEX_URL);
    if (!cached) throw new Error("the index is no longer cached");
    return cached.arrayBuffer();
  },
  onIndexLoaded() {
    indexWaiter?.resolve();
    indexWaiter = null;
  },
  onError(message) {
    if (!indexWaiter) return setStatus("Error: " + message, "error");
    indexWaiter.reject(new Error(message));
    indexWaiter = null;
  },
});

// Load the index, downloading it if uncached
function ensureIndexLoaded() {
  indexLoad ??= (async () => {
    const loaded = new Promise((resolve, reject) => (indexWaiter = { resolve, reject }));
    let blob = await getCachedIndex(CHECK_INDEX_URL);
    if (!blob) {
      setStatus("Downloading a tiny panhuman index (26MB)…");
      blob = await downloadIndex(CHECK_INDEX_URL);
      await putCachedIndex(CHECK_INDEX_URL, blob).catch((err) => console.warn("sapiometer: failed to cache index", err));
    }
    setStatus("Loading human index…");
    engine.loadIndex(await blob.arrayBuffer());
    await loaded;
  })().catch((err) => {
    indexLoad = indexWaiter = null;
    throw err;
  });
  return indexLoad;
}

// Discard output, keep stats
async function scanGroup(group, onProgress) {
  let stats = null;
  const outputs = engine.filterGroup(group, { onProgress, onStats: (s) => (stats = s) });
  await Promise.all(outputs.map((o) => o.stream.pipeTo(new WritableStream())));
  return stats;
}

function resultText(readsIn, readsOut) {
  const human = readsIn - readsOut;
  const frac = readsIn > 0 ? human / readsIn : 0;
  const counts = `(${(frac * 100).toFixed(1)}%; ${human.toLocaleString()}/${readsIn.toLocaleString()} sequences)`;
  if (frac > HIGH_THRESHOLD) return [`High human content ${counts}. Share with caution.`, "high"];
  if (frac > WARN_THRESHOLD) return [`Moderate human content ${counts}`, "warn"];
  return [`Low human content ${counts}`, "pass"];
}

async function handleFiles(files) {
  if (busy) return;
  const seqs = files.filter((f) => SEQ_RE.test(f.name));
  dropZone.classList.remove("loaded");
  if (!seqs.length) {
    dropSummary.textContent = files.length ? "No fasta/fastq files found." : "";
    return;
  }
  let groups;
  try {
    groups = pairSequenceFiles(seqs);
  } catch (err) {
    dropSummary.textContent = "Pairing error";
    setStatus(err?.message || String(err), "error");
    return;
  }
  if (groups.length !== 1) {
    dropSummary.textContent = "Drop a single file or one R1/R2 pair.";
    setStatus("");
    return;
  }

  const group = groups[0];
  dropZone.classList.add("loaded");
  dropSummary.textContent = `${group.files.length === 2 ? "Pair" : "Single"}: ${group.label}`;
  busy = true;
  dropZone.classList.add("busy");

  const onProgress = (m) => {
    setProgress(m.bytesTotal ? (m.bytesProcessed / m.bytesTotal) * 100 : 0);
    if (m.readsIn > 0) setStatus(...resultText(Number(m.readsIn), Number(m.readsOut || 0)));
  };

  try {
    setStatus("Preparing human index…");
    await ensureIndexLoaded();
    setStatus(`Checking ${group.label}…`);
    setProgress(0);
    // Retry once after a crash
    const stats = await scanGroup(group, onProgress).catch((err) => {
      if (err?.retry) return scanGroup(group, onProgress);
      throw err;
    });
    const [text, kind] = resultText(Number(stats?.readsIn || 0), Number(stats?.readsOut || 0));
    setProgress(100);
    setStatus(text, kind);
    console.log("sapiometer:", text);
  } catch (err) {
    console.error(err);
    statusEl.style.removeProperty("--progress");
    setStatus("Check failed: " + (err?.message || err), "error");
  } finally {
    busy = false;
    dropZone.classList.remove("busy");
  }
}

dropZone.addEventListener("click", () => {
  if (!busy) fileInput.click();
});
fileInput.addEventListener("change", () => {
  handleFiles(Array.from(fileInput.files));
  fileInput.value = "";
});
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (!busy) dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  if (busy) return;
  handleFiles(Array.from(e.dataTransfer.files || []));
});
