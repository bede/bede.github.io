// Deacon filtering on a worker, plus an sssender transform for updeacon-s3
import { MSG, FILTER_DEFAULTS, DEACON_VERSION } from "./protocol.js?v=3c29449-dirty-20261112164946";
import { relativePath } from "./sssender/core/select.js?v=3c29449-dirty-20261112164946";
import { VERSION } from "./version.js?v=3c29449-dirty-20261112164946";

const ASSET_VERSION = "3c29449-dirty-20261112164946";

// Output is always gzip
const GZ_RE = /\.gz$/i;
export const gzName = (name) => (GZ_RE.test(name) ? name : name + ".gz");

// Filter failures mean bad input (corrupt gzip, not FASTA/Q), so skip the file
function filterError(message) {
  const err = new Error(message);
  err.kind = "input";
  return err;
}

// No progress this long on a pending PULL means a wedged worker
export const FILTER_STALL_MS = 3 * 60 * 1000;

function crashError(stalled) {
  const err = new Error(
    stalled
      ? "Deacon stopped responding while filtering this file."
      : "Deacon crashed while filtering this file. It may have run out of memory."
  );
  err.kind = "input"; // skipped if it recurs
  err.retry = true; // once, with a fresh worker
  return err;
}

// One worker, one filter at a time. onIndexLoaded(info, { k, w }) and onError(message)
// report on the index, and filter errors reject the filter's streams. params override
// FILTER_DEFAULTS. A crash or stall fails the active filter with crashError, then a new
// worker reloads the index from reloadIndex() -> ArrayBuffer. Filters wait for it
export function createDeaconEngine({
  onIndexLoaded,
  onError,
  reloadIndex,
  params = {},
  stallMs = FILTER_STALL_MS,
  makeWorker = () => new Worker(new URL(`./worker.js?v=${ASSET_VERSION}`, import.meta.url), { type: "module" }),
  setTimerFn = setTimeout,
  clearTimerFn = clearTimeout,
}) {
  let worker = null;
  let ready = false; // WASM initialised
  let pendingIndex = null; // held until READY
  let indexLoaded = false; // so a crash can reload it
  let restarting = null; // Promise while a new worker reloads the index
  let restartLoaded = null; // { resolve, reject } for that reload

  // Route worker replies to the active filter's handlers
  let onOutputBatch = null;
  let onProgress = null;
  let onFilterError = null;

  let watchdog = null;
  const disarm = () => {
    if (watchdog !== null) clearTimerFn(watchdog);
    watchdog = null;
  };
  const arm = () => {
    disarm();
    watchdog = setTimerFn(() => crash(true), stallMs);
  };

  const clearHandlers = () => {
    onOutputBatch = null;
    onFilterError = null;
  };

  const post = (msg, transfer) => worker.postMessage(msg, transfer || []);
  const pull = () => {
    arm(); // only a pending pull can stall
    post({ type: MSG.PULL });
  };

  function onMessage(e) {
    const m = e.data;
    switch (m.type) {
      case MSG.READY:
        ready = true;
        // Index arrived before READY
        if (pendingIndex) {
          const buf = pendingIndex;
          pendingIndex = null;
          post({ type: MSG.LOAD_INDEX, data: buf }, [buf]);
        }
        break;
      case MSG.INDEX_LOADED: {
        indexLoaded = true;
        if (restartLoaded) {
          restartLoaded.resolve();
          restartLoaded = null;
          break;
        }
        // info: "k=31, w=61 (… minimizers)"
        const kw = /k=(\d+),\s*w=(\d+)/.exec(m.info || "");
        onIndexLoaded(m.info, { k: kw ? Number(kw[1]) : null, w: kw ? Number(kw[2]) : null });
        break;
      }
      case MSG.PROGRESS:
        if (watchdog !== null) arm();
        onProgress?.(m);
        break;
      case MSG.OUTPUT_CHUNK_BATCH:
        disarm();
        onOutputBatch?.(m);
        break;
      case MSG.ERROR:
        disarm();
        if (onFilterError) onFilterError(filterError(m.message));
        else if (restartLoaded) {
          restartLoaded.reject(new Error(m.message));
          restartLoaded = null;
        }
        // A pull after its filter failed is harmless
        else if (m.message !== "No active filter session") onError(m.message);
        break;
    }
  }

  function spawn() {
    ready = false;
    worker = makeWorker();
    worker.onmessage = onMessage;
    worker.onerror = (e) => {
      e?.preventDefault?.();
      crash(false);
    };
    worker.onmessageerror = () => crash(false);
    post({ type: MSG.INIT });
  }

  function loadIndex(buffer) {
    if (ready) post({ type: MSG.LOAD_INDEX, data: buffer }, [buffer]);
    else pendingIndex = buffer;
  }

  function crash(stalled) {
    disarm();
    const fail = onFilterError;
    clearHandlers();
    onProgress = null;
    const dead = worker;
    dead.onmessage = dead.onerror = dead.onmessageerror = null;
    dead.terminate();
    console.warn(`updeacon: Deacon worker ${stalled ? "stalled" : "crashed"}, restarting it`);
    spawn();
    if (!indexLoaded) {
      onError(stalled ? "Deacon stopped responding." : "Deacon crashed while starting.");
    } else if (!restarting) {
      restarting = (async () => {
        const buffer = await reloadIndex();
        await new Promise((resolve, reject) => {
          restartLoaded = { resolve, reject };
          loadIndex(buffer);
        });
      })().then(
        () => {
          restarting = null;
        },
        (cause) => {
          // Stays rejected until the page loads an index
          const err = new Error(`Couldn't reload the Deacon index after a crash: ${cause?.message || cause}`, { cause });
          err.kind = "storage";
          throw err;
        }
      );
      restarting.catch(() => {}); // reported to waiting filters
    }
    fail?.(crashError(stalled));
  }

  // Filters wait out a restart, and a failed reload rejects them
  const whenReady = () => restarting ?? Promise.resolve();

  // -> [{ stream }] per file, sharing one session. Each pulls until its queue has data, so
  // the consumer paces the filter. Calls hooks.onProgress(msg) and hooks.onStats(stats, elapsed)
  function filterGroup(group, hooks = {}) {
    const queues = group.files.map(() => []);
    let done = false;
    let pulling = null;
    let started = null;

    const pump = () =>
      (pulling ??= new Promise((resolve, reject) => {
        onFilterError = (err) => {
          clearHandlers();
          reject(err);
        };
        onOutputBatch = (m) => {
          clearHandlers();
          m.chunks.forEach((bufs, i) => queues[i].push(...bufs.map((b) => new Uint8Array(b))));
          if (m.done) {
            done = true;
            onProgress = null;
            hooks.onStats?.(m.stats, m.elapsed);
          }
          resolve();
        };
        pull();
      }).finally(() => {
        pulling = null;
      }));

    // Streams share one FILTER
    const start = () =>
      (started ??= whenReady().then(() => {
        onProgress = hooks.onProgress;
        post({ type: MSG.FILTER, data: { ...params, files: group.files } });
      }));

    return queues.map((queue) => ({
      stream: new ReadableStream({
        start,
        async pull(controller) {
          while (!queue.length && !done) await pump();
          if (queue.length) controller.enqueue(queue.shift());
          else controller.close();
        },
        cancel() {
          // The worker frees its session on the next FILTER
          disarm();
          clearHandlers();
          onProgress = null;
        },
      }),
    }));
  }

  spawn();

  return {
    loadIndex(buffer) {
      restarting = null; // a fresh index clears a failed reload
      loadIndex(buffer);
    },
    reset() {
      indexLoaded = false;
      post({ type: MSG.RESET });
    },
    filterGroup,
  };
}

// indexMeta() -> { filename, k, w } of the loaded index, recorded in summaries
export function deaconTransform({ engine, indexMeta }) {
  return {
    name: "deacon",
    outputName: gzName,
    concurrency: 1, // one worker
    start: (group, hooks) => engine.filterGroup(group, hooks),
    extras: (item, result) => [
      {
        key: `${item.keys[0]}.deacon.json`,
        body: new Blob([JSON.stringify(buildSummary({ item, ...result, index: indexMeta() }), null, 2)], {
          type: "application/json",
        }),
        contentType: "application/json",
      },
    ],
  };
}

export function logFilterParams({ filename, k, w }) {
  console.log("updeacon: deacon filter params", {
    index: filename,
    k,
    w,
    deplete: FILTER_DEFAULTS.deplete,
    abs_threshold: FILTER_DEFAULTS.absThreshold,
    rel_threshold: FILTER_DEFAULTS.relThreshold,
    prefix_length: FILTER_DEFAULTS.prefixLength,
  });
}

// Summary in the deacon CLI's JSON schema
function buildSummary({ item, stats, elapsed, index }) {
  const [input, input2 = null] = item.files.map(relativePath);
  const seqsIn = Number(stats?.readsIn || 0);
  const seqsOut = Number(stats?.readsOut || 0);
  const bpIn = Number(stats?.basesIn || 0);
  const bpOut = Number(stats?.basesOut || 0);
  const t = Number(elapsed) || 0;
  const prop = (num, den) => (den > 0 ? num / den : 0);
  const rate = (n) => (t > 0 ? Math.round(n / t) : 0);
  return {
    version: DEACON_VERSION,
    updeacon_version: VERSION,
    index: index.filename,
    input,
    input2,
    output: item.keys[0],
    output2: item.keys[1] ?? null,
    k: index.k,
    w: index.w,
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
