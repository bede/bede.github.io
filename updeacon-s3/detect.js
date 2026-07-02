// updeacon-check: in-browser host-content check
import { MSG, DETECT_DEFAULTS } from "./protocol.js?v=20260702-141439";
import { SEQ_RE, pairSequenceFiles } from "./pairing.js";

const ASSET_VERSION = "20260702-141439";

const INDEX_URL =
  "https://objectstorage.uk-london-1.oraclecloud.com/n/lrbvkel2wjot/b/human-genome-bucket/o/deacon/3/panhuman-1.k31w61c99.pidx";

const WARN_THRESHOLD = 0.01; // >1% host → amber
const HIGH_THRESHOLD = 0.05; // >5% host → red

// --- DOM ---------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const dropZone = $("drop-zone");
const fileInput = $("file-input");
const dropSummary = $("drop-summary");
const statusEl = $("status");

// --- State -------------------------------------------------------------------
let workerReady = false;
let indexLoaded = false;
let indexLoadPromise = null;
let busy = false;

// --- Helpers -----------------------------------------------------------------
function setStatus(msg, kind) {
  statusEl.textContent = msg || "";
  statusEl.className = kind || "";
}

// --- WASM worker -------------------------------------------------------------
const worker = new Worker(`./worker.js?v=${ASSET_VERSION}`, { type: "module" });

let onOutputBatch = null;
let onWorkerError = null;
let onIndexLoaded = null;

worker.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case MSG.READY:
      workerReady = true;
      break;
    case MSG.INDEX_LOADED:
      indexLoaded = true;
      if (onIndexLoaded) {
        const cb = onIndexLoaded;
        onIndexLoaded = null;
        cb();
      }
      break;
    case MSG.OUTPUT_CHUNK_BATCH:
      if (onOutputBatch) onOutputBatch(m);
      break;
    case MSG.ERROR:
      if (onWorkerError) onWorkerError(m.message);
      else setStatus("Error: " + m.message, "error");
      break;
    default:
      break;
  }
};

worker.postMessage({ type: MSG.INIT });

// --- Index cache (IndexedDB) -------------------------------------------------
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

async function downloadIndex(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  return resp.blob();
}

function sendIndexToWorker(arrayBuffer) {
  worker.postMessage({ type: MSG.LOAD_INDEX, data: arrayBuffer }, [arrayBuffer]);
}

function waitForWorkerReady() {
  if (workerReady) return Promise.resolve();
  return new Promise((resolve) => {
    const tick = () => (workerReady ? resolve() : setTimeout(tick, 50));
    tick();
  });
}

function ensureIndexLoaded() {
  if (indexLoaded) return Promise.resolve();
  if (indexLoadPromise) return indexLoadPromise;

  indexLoadPromise = (async () => {
    await waitForWorkerReady();

    const loaded = new Promise((resolve, reject) => {
      onIndexLoaded = resolve;
      onWorkerError = (message) => {
        onWorkerError = null;
        reject(new Error(message));
      };
    });

    const cached = await getCachedIndex(INDEX_URL);
    if (cached) {
      setStatus("Loading host index…");
      sendIndexToWorker(await cached.arrayBuffer());
    } else {
      setStatus("Downloading host index…");
      const blob = await downloadIndex(INDEX_URL);
      await putCachedIndex(INDEX_URL, blob).catch((err) =>
        console.warn("updeacon: failed to cache index", err)
      );
      setStatus("Loading host index…");
      sendIndexToWorker(await blob.arrayBuffer());
    }

    await loaded;
    onWorkerError = null;
  })().catch((err) => {
    indexLoadPromise = null;
    throw err;
  });

  return indexLoadPromise;
}

// --- Checking ----------------------------------------------------------------
function scanSingleStream(file, hooks) {
  return new ReadableStream({
    start() {
      worker.postMessage({ type: MSG.FILTER, data: { file, ...DETECT_DEFAULTS } });
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
            if (hooks.onStats) hooks.onStats(m.stats);
            controller.close();
          }
          resolve();
        };
        worker.postMessage({ type: MSG.PULL });
      });
    },
    cancel() {
      onOutputBatch = null;
      onWorkerError = null;
    },
  });
}

function scanPairedStreams(group, hooks) {
  const state = { queues: { r1: [], r2: [] }, done: false, pulling: null, started: false };

  const clearHandlers = () => {
    onWorkerError = null;
    onOutputBatch = null;
  };

  const pump = () => {
    if (state.done || state.pulling) return state.pulling || Promise.resolve();
    state.pulling = new Promise((resolve, reject) => {
      onWorkerError = (message) => {
        clearHandlers();
        reject(new Error(message));
      };
      onOutputBatch = (m) => {
        clearHandlers();
        for (const buf of m.chunksR1 || []) state.queues.r1.push(new Uint8Array(buf));
        for (const buf of m.chunksR2 || []) state.queues.r2.push(new Uint8Array(buf));
        if (m.done) {
          state.done = true;
          if (hooks.onStats) hooks.onStats(m.stats);
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
      start() {
        if (!state.started) {
          state.started = true;
          worker.postMessage({
            type: MSG.FILTER,
            data: { file1: group.file1, file2: group.file2, ...DETECT_DEFAULTS },
          });
        }
      },
      async pull(controller) {
        while (!state.queues[mate].length && !state.done) {
          await pump();
        }
        const chunk = state.queues[mate].shift();
        if (chunk) controller.enqueue(chunk);
        else if (state.done) controller.close();
      },
      cancel() {
        clearHandlers();
      },
    });

  return { streamR1: makeStream("r1"), streamR2: makeStream("r2") };
}

async function drain(stream) {
  const reader = stream.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

async function scanGroup(group) {
  let stats = null;
  const onStats = (s) => {
    stats = s;
  };
  if (group.kind === "paired") {
    const { streamR1, streamR2 } = scanPairedStreams(group, { onStats });
    await Promise.all([drain(streamR1), drain(streamR2)]);
  } else {
    const stream = scanSingleStream(group.file, { onStats });
    await drain(stream);
  }
  return stats;
}

// --- Result rendering --------------------------------------------------------
function tier(maxFrac) {
  if (maxFrac > HIGH_THRESHOLD) return { cls: "high-host", verdict: "High host content detected" };
  if (maxFrac > WARN_THRESHOLD) return { cls: "warn", verdict: "Moderate host content detected" };
  return { cls: "pass", verdict: "Host check passed" };
}

function resultText(results, verdict) {
  const stat = (r) =>
    `${(r.hostFrac * 100).toFixed(1)}% host (${r.hostReads.toLocaleString()} of ${r.readsIn.toLocaleString()} reads)`;
  if (results.length === 1) return `${verdict}. ${stat(results[0])}`;
  return [`${verdict}.`, ...results.map((r) => `${r.label}: ${stat(r)}`)].join("\n");
}

// --- File selection ----------------------------------------------------------
async function handleFiles(files) {
  if (busy) return;
  const seqs = files.filter((f) => SEQ_RE.test(f.name));
  if (seqs.length === 0) {
    dropZone.classList.remove("loaded");
    dropSummary.textContent = files.length ? "No fasta/fastq files found." : "";
    return;
  }

  let groups;
  try {
    groups = pairSequenceFiles(seqs);
  } catch (err) {
    dropZone.classList.remove("loaded");
    dropSummary.textContent = "Pairing error";
    setStatus(err?.message || String(err), "error");
    return;
  }

  const pairs = groups.filter((g) => g.kind === "paired").length;
  const singles = groups.length - pairs;
  const parts = [];
  if (pairs) parts.push(`${pairs} pair${pairs === 1 ? "" : "s"}`);
  if (singles) parts.push(`${singles} single${singles === 1 ? "" : "s"}`);
  dropZone.classList.add("loaded");
  dropSummary.textContent = `${seqs.length} file${seqs.length === 1 ? "" : "s"} · ${parts.join(", ")}`;

  busy = true;
  dropZone.classList.add("busy");

  try {
    setStatus("Preparing host index…");
    await ensureIndexLoaded();

    const results = [];
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      setStatus(`Checking ${i + 1} of ${groups.length}: ${group.label}`);
      const stats = await scanGroup(group);
      const readsIn = Number(stats?.readsIn || 0);
      const readsOut = Number(stats?.readsOut || 0);
      const hostReads = readsIn - readsOut;
      results.push({
        label: group.label,
        readsIn,
        hostReads,
        hostFrac: readsIn > 0 ? hostReads / readsIn : 0,
      });
    }

    const maxFrac = Math.max(0, ...results.map((r) => r.hostFrac));
    const { cls, verdict } = tier(maxFrac);
    const text = resultText(results, verdict);
    setStatus(text, cls);
    console.log("updeacon-check:", text);
  } catch (err) {
    console.error(err);
    setStatus("Detection failed: " + (err?.message || err), "error");
  } finally {
    busy = false;
    dropZone.classList.remove("busy");
  }
}

// --- Drop-zone wiring ---------------------------------------------------------
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
