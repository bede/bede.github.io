// Deacon filtering for updeacon: drives worker.js (WASM) off the main thread and
// exposes it as a seq2bucket transform. Filter params are FILTER_DEFAULTS
// (deplete mode, panhuman thresholds).
import { MSG, FILTER_DEFAULTS, DEACON_VERSION } from "./protocol.js?v=6667cc5";
import { groupRelativePaths } from "./seq2bucket/pairing.js?v=6667cc5";
import { VERSION } from "./seq2bucket/version.js?v=6667cc5";

const ASSET_VERSION = "6667cc5";

// Filtered output is always gzip; uncompressed inputs get a .gz suffix so the name stays honest
const GZ_RE = /\.gz$/i;
export const gzName = (name) => (GZ_RE.test(name) ? name : name + ".gz");

// One worker, one active filter at a time. onIndexLoaded(info, { k, w }) and
// onError(message) report on the index; errors during a filter reject its stream.
export function createDeaconEngine({ onIndexLoaded, onError }) {
  const worker = new Worker(new URL(`./worker.js?v=${ASSET_VERSION}`, import.meta.url), {
    type: "module",
  });
  let ready = false; // worker has finished WASM init (MSG.READY)
  let pendingIndex = null; // index bytes waiting for READY

  // Route worker replies to the active filter's handlers
  let onOutputBatch = null; // next OUTPUT_CHUNK_BATCH
  let onProgress = null; // PROGRESS for the active filter
  let onFilterError = null; // abort the active pull

  worker.onmessage = (e) => {
    const m = e.data;
    switch (m.type) {
      case MSG.READY:
        ready = true;
        // Hand over the index if it finished loading first
        if (pendingIndex) {
          const buf = pendingIndex;
          pendingIndex = null;
          worker.postMessage({ type: MSG.LOAD_INDEX, data: buf }, [buf]);
        }
        break;
      case MSG.INDEX_LOADED: {
        // Parse k and w from info ("k=31, w=61 (… minimizers)") for summaries
        const kw = /k=(\d+),\s*w=(\d+)/.exec(m.info || "");
        onIndexLoaded(m.info, { k: kw ? Number(kw[1]) : null, w: kw ? Number(kw[2]) : null });
        break;
      }
      case MSG.PROGRESS:
        onProgress?.(m);
        break;
      case MSG.OUTPUT_CHUNK_BATCH:
        onOutputBatch?.(m);
        break;
      case MSG.ERROR:
        if (onFilterError) onFilterError(m.message);
        else onError(m.message);
        break;
      default:
        break;
    }
  };
  worker.postMessage({ type: MSG.INIT });

  const clearHandlers = () => {
    onOutputBatch = null;
    onFilterError = null;
  };

  // ReadableStream of one file's filtered bytes; pull-driven so the consumer paces the filter
  function filterSingle(file, hooks) {
    return new ReadableStream({
      start() {
        onProgress = hooks.onProgress;
        worker.postMessage({ type: MSG.FILTER, data: { file } });
      },
      pull(controller) {
        return new Promise((resolve, reject) => {
          onFilterError = (message) => {
            clearHandlers();
            reject(new Error(message));
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
          worker.postMessage({ type: MSG.PULL });
        });
      },
      cancel() {
        // Drop handlers; worker frees its session on next FILTER
        clearHandlers();
        onProgress = null;
      },
    });
  }

  // Two streams fed by one interleaved worker session; each pulls until its mate's
  // queue has data or the session ends
  function filterPaired(group, hooks) {
    const state = { queues: { r1: [], r2: [] }, done: false, pulling: null, started: false };

    const pump = () => {
      if (state.done || state.pulling) return state.pulling || Promise.resolve();
      state.pulling = new Promise((resolve, reject) => {
        onFilterError = (message) => {
          clearHandlers();
          reject(new Error(message));
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
        worker.postMessage({ type: MSG.PULL });
      }).finally(() => {
        state.pulling = null;
      });
      return state.pulling;
    };

    const makeStream = (mate) =>
      new ReadableStream({
        start() {
          if (state.started) return;
          state.started = true;
          onProgress = hooks.onProgress;
          worker.postMessage({ type: MSG.FILTER, data: { file1: group.file1, file2: group.file2 } });
        },
        async pull(controller) {
          while (!state.queues[mate].length && !state.done) await pump();
          const chunk = state.queues[mate].shift();
          if (chunk) controller.enqueue(chunk);
          else if (state.done) controller.close();
        },
        cancel() {
          clearHandlers();
          onProgress = null;
        },
      });

    return { streamR1: makeStream("r1"), streamR2: makeStream("r2") };
  }

  return {
    loadIndex(buffer) {
      if (ready) worker.postMessage({ type: MSG.LOAD_INDEX, data: buffer }, [buffer]);
      else pendingIndex = buffer;
    },
    reset() {
      worker.postMessage({ type: MSG.RESET });
    },
    // -> { stream } or { streamR1, streamR2 }; hooks.onProgress(msg), hooks.onStats(stats, elapsed)
    filterGroup(group, hooks = {}) {
      if (group.kind === "paired") return filterPaired(group, hooks);
      return { stream: filterSingle(group.file, hooks) };
    },
  };
}

// indexMeta() -> { filename, k, w } of the loaded index, recorded in summaries
export function deaconTransform({ engine, indexMeta }) {
  return {
    name: "deacon",
    outputName: gzName,
    start: (group, hooks) => engine.filterGroup(group, hooks),
    extras: (item, result) => [
      {
        key: `${item.key}.deacon.json`,
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

// Deacon-style JSON summary mirroring the CLI schema; paired groups fill input2/output2
function buildSummary({ item, stats, elapsed, index }) {
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
    updeacon_version: VERSION,
    index: index.filename,
    input: paths.input,
    input2: paths.input2,
    output: item.key,
    output2: item.kind === "paired" ? item.key2 : null,
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
