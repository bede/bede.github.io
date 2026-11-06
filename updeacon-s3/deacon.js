// Deacon filtering for updeacon: drives worker.js (WASM) off the main thread and
// exposes it as an sssender transform. Filter params are FILTER_DEFAULTS
// (deplete mode, panhuman thresholds).
import { MSG, FILTER_DEFAULTS, DEACON_VERSION } from "./protocol.js?v=bd47d2f";
import { relativePath } from "./sssender/core/select.js?v=bd47d2f";
import { VERSION } from "./version.js?v=bd47d2f";

const ASSET_VERSION = "bd47d2f";

// Filtered output is always gzip, so uncompressed inputs get a .gz suffix to keep the name honest
const GZ_RE = /\.gz$/i;
export const gzName = (name) => (GZ_RE.test(name) ? name : name + ".gz");

// A filter failure means a bad input (corrupt gzip, not FASTA/Q, unreadable), so skip the file
function filterError(message) {
  const err = new Error(message);
  err.kind = "input";
  return err;
}

// No progress this long on a pending PULL means a wedged worker (it reports every 150 ms)
export const FILTER_STALL_MS = 3 * 60 * 1000;

function crashError(stalled) {
  const err = new Error(
    stalled
      ? "Deacon stopped responding while filtering this file."
      : "Deacon crashed while filtering this file; it may have run out of memory."
  );
  err.kind = "input"; // skipped if it recurs, likely too big for the browser
  err.retry = true; // one more go with a fresh worker
  return err;
}

// One worker, one active filter at a time. onIndexLoaded(info, { k, w }) and
// onError(message) report on the index. Errors during a filter reject its stream.
//
// On a crash (worker.onerror) or stall (FILTER_STALL_MS) the active filter fails with a
// crashError. A new worker reloads the index from reloadIndex() -> ArrayBuffer, as the
// old bytes were transferred away. Filters started meanwhile wait for it.
export function createDeaconEngine({
  onIndexLoaded,
  onError,
  reloadIndex,
  stallMs = FILTER_STALL_MS,
  makeWorker = () => new Worker(new URL(`./worker.js?v=${ASSET_VERSION}`, import.meta.url), { type: "module" }),
  setTimerFn = setTimeout,
  clearTimerFn = clearTimeout,
}) {
  let worker = null;
  let ready = false; // worker has finished WASM init (MSG.READY)
  let pendingIndex = null; // index bytes waiting for READY
  let indexLoaded = false; // an index has loaded at least once, so a crash can recover
  let restarting = null; // Promise while a replacement worker reloads the index
  let restartLoaded = null; // { resolve, reject } for that reload

  // Route worker replies to the active filter's handlers
  let onOutputBatch = null; // next OUTPUT_CHUNK_BATCH
  let onProgress = null; // PROGRESS for the active filter
  let onFilterError = null; // abort the active pull, with an Error

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
    arm(); // only a filter that's been asked for output can stall
    post({ type: MSG.PULL });
  };

  function onMessage(e) {
    const m = e.data;
    switch (m.type) {
      case MSG.READY:
        ready = true;
        // Hand over the index if it finished loading first
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
        // Parse k and w from info ("k=31, w=61 (… minimizers)") for summaries
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
      default:
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
    console.warn(`updeacon: Deacon worker ${stalled ? "stalled" : "crashed"}; restarting it`);
    spawn();
    if (!indexLoaded) {
      // Nothing to recover without a loaded index
      onError(stalled ? "Deacon stopped responding." : "Deacon crashed while starting.");
    } else if (!restarting) {
      restarting = (async () => {
        const buffer = await reloadIndex();
        await new Promise((resolve, reject) => {
          restartLoaded = { resolve, reject };
          loadIndex(buffer);
        });
      })()
        .catch((cause) => {
          // Every later file would fail too, so stop the run
          const err = new Error(`Couldn't reload the Deacon index after a crash: ${cause?.message || cause}`, { cause });
          err.kind = "storage";
          throw err;
        })
        .finally(() => {
          restarting = null;
        });
      restarting.catch(() => {}); // reported by the next filter waiting on it
    }
    fail?.(crashError(stalled));
  }

  // Filters wait out a restart, and a failed reload rejects them
  const whenReady = () => restarting ?? Promise.resolve();

  // ReadableStream of one file's filtered bytes, pull-driven so the consumer paces the filter
  function filterSingle(file, hooks) {
    return new ReadableStream({
      async start() {
        await whenReady();
        onProgress = hooks.onProgress;
        post({ type: MSG.FILTER, data: { file } });
      },
      pull(controller) {
        return new Promise((resolve, reject) => {
          onFilterError = (err) => {
            clearHandlers();
            reject(err);
          };
          onOutputBatch = (m) => {
            onOutputBatch = null;
            for (const buf of m.chunks) controller.enqueue(new Uint8Array(buf));
            if (m.done) {
              onFilterError = null;
              onProgress = null;
              hooks.onStats?.(m.stats, m.elapsed);
              controller.close();
            }
            resolve();
          };
          pull();
        });
      },
      cancel() {
        // Drop handlers. The worker frees its session on the next FILTER
        disarm();
        clearHandlers();
        onProgress = null;
      },
    });
  }

  // Two streams fed by one interleaved worker session. Each pulls until its mate's
  // queue has data or the session ends
  function filterPaired([file1, file2], hooks) {
    const state = { queues: { r1: [], r2: [] }, done: false, pulling: null, started: null };

    const pump = () => {
      if (state.done || state.pulling) return state.pulling || Promise.resolve();
      state.pulling = new Promise((resolve, reject) => {
        onFilterError = (err) => {
          clearHandlers();
          reject(err);
        };
        onOutputBatch = (m) => {
          clearHandlers();
          for (const buf of m.chunksR1 || []) state.queues.r1.push(new Uint8Array(buf));
          for (const buf of m.chunksR2 || []) state.queues.r2.push(new Uint8Array(buf));
          if (m.done) {
            state.done = true;
            onProgress = null;
            hooks.onStats?.(m.stats, m.elapsed);
          }
          resolve();
        };
        pull();
      }).finally(() => {
        state.pulling = null;
      });
      return state.pulling;
    };

    // Both mates' start() share one FILTER
    const begin = () =>
      (state.started ??= whenReady().then(() => {
        onProgress = hooks.onProgress;
        post({ type: MSG.FILTER, data: { file1, file2 } });
      }));

    const makeStream = (mate) =>
      new ReadableStream({
        start: begin,
        async pull(controller) {
          while (!state.queues[mate].length && !state.done) await pump();
          const chunk = state.queues[mate].shift();
          if (chunk) controller.enqueue(chunk);
          else if (state.done) controller.close();
        },
        cancel() {
          disarm();
          clearHandlers();
          onProgress = null;
        },
      });

    return [{ stream: makeStream("r1") }, { stream: makeStream("r2") }];
  }

  spawn();

  return {
    loadIndex,
    reset() {
      indexLoaded = false;
      post({ type: MSG.RESET });
    },
    // -> [{ stream }] for a single file, [{ stream }, { stream }] for an R1/R2 pair.
    // Calls hooks.onProgress(msg) and hooks.onStats(stats, elapsed)
    filterGroup(group, hooks = {}) {
      if (group.files.length === 2) return filterPaired(group.files, hooks);
      return [{ stream: filterSingle(group.files[0], hooks) }];
    },
  };
}

// indexMeta() -> { filename, k, w } of the loaded index, recorded in summaries
export function deaconTransform({ engine, indexMeta }) {
  return {
    name: "deacon",
    outputName: gzName,
    concurrency: 1, // one worker, one active filter
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

// Deacon-style JSON summary mirroring the CLI schema. Paired groups fill input2/output2
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
