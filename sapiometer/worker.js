import { MSG, FILTER_DEFAULTS } from "./protocol.js?v=f40b3fc";

// Deacon filtering off the main thread. One output batch per PULL bounds memory
let wasm = null;
let index = null;
const ASSET_VERSION = "f40b3fc";
const OUTPUT_BATCH_BYTES = 4 * 1024 * 1024;
const PROGRESS_MS = 150;

// wasm-bindgen throws Result errors as plain strings
function errText(err) {
  if (err == null) return "Unknown error";
  if (typeof err === "string") return err;
  return err.message || String(err);
}

// Current session, set up by FILTER and drained by PULL
let active = null;

// { files: [file] | [r1, r2], ...FILTER_DEFAULTS overrides }
function startFilter({ files, ...overrides }) {
  if (!index) throw new Error("No index loaded");
  const { deplete, absThreshold, relThreshold, rename, discardQuality } = { ...FILTER_DEFAULTS, ...overrides };
  const gz = files.map((f) => /\.gz$/i.test(f.name));
  // Always gzip output. Paired sessions return { r1, r2 }
  let session, push, finish;
  if (files.length === 2) {
    session = new wasm.PairedFilterSession(
      index, deplete, absThreshold, relThreshold, gz[0], gz[1], true, true, rename, discardQuality
    );
    push = [(c) => session.push_r1(c), (c) => session.push_r2(c)];
    finish = [() => session.finish_r1(), () => session.finish_r2()];
  } else {
    session = new wasm.FilterSession(index, deplete, absThreshold, relThreshold, gz[0], true, rename, discardQuality);
    push = [(c) => ({ r1: session.push_chunk(c) })];
    finish = [() => ({ r1: session.finish() })];
  }
  active = {
    session,
    push,
    finish,
    readers: files.map((f) => f.stream().getReader()),
    ended: files.map(() => false),
    out: files.map(() => []), // pending buffers per file
    outBytes: 0,
    totalBytes: files.reduce((n, f) => n + (f.size || 0), 0),
    processedBytes: 0,
    lastProgressTs: 0,
    t0: performance.now(),
  };
}

// Queue output for transfer, copying views of larger buffers
function append({ r1, r2 }) {
  [r1, r2].forEach((chunk, i) => {
    if (!chunk?.length) return;
    const buffer =
      chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength ? chunk.buffer : chunk.slice().buffer;
    active.out[i].push(buffer);
    active.outBytes += buffer.byteLength;
  });
}

function postProgress() {
  // Mid-stream stats() may be unsupported
  let readsIn = 0;
  let readsOut = 0;
  try {
    const s = active.session.stats();
    readsIn = Number(s?.readsIn || 0);
    readsOut = Number(s?.readsOut || 0);
  } catch (_) {}
  self.postMessage({
    type: MSG.PROGRESS,
    bytesProcessed: active.processedBytes,
    bytesTotal: active.totalBytes,
    readsIn,
    readsOut,
  });
}

// Read input (mates alternately) until a batch is ready or input ends.
// chunks: [[…r1], […r2]], with stats once done
async function pump() {
  const a = active;
  const finished = () => a.ended.every(Boolean);
  while (a.outBytes < OUTPUT_BATCH_BYTES && !finished()) {
    for (let i = 0; i < a.readers.length; i++) {
      if (a.ended[i]) continue;
      const { value, done } = await a.readers[i].read();
      if (done) {
        a.ended[i] = true;
        append(a.finish[i]());
      } else if (value.length) {
        a.processedBytes += value.length;
        append(a.push[i](value));
      }
    }
    const now = performance.now();
    if (now - a.lastProgressTs >= PROGRESS_MS) {
      postProgress();
      a.lastProgressTs = now;
    }
  }

  const chunks = a.out;
  a.out = chunks.map(() => []);
  a.outBytes = 0;
  const msg = { type: MSG.OUTPUT_CHUNK_BATCH, chunks, done: finished() };
  if (msg.done) {
    postProgress();
    msg.stats = a.session.stats();
    msg.elapsed = ((performance.now() - a.t0) / 1000).toFixed(2);
    a.session.free();
    active = null;
  }
  self.postMessage(msg, chunks.flat());
}

function disposeActive() {
  if (!active) return;
  for (const reader of active.readers) reader.cancel().catch(() => {});
  try {
    active.session.free();
  } catch (_) {}
  active = null;
}

self.onmessage = async function (e) {
  const { type, data } = e.data;

  if (type === MSG.INIT) {
    try {
      const mod = await import(`./pkg/deacon_wasm.js?v=${ASSET_VERSION}`);
      const wasmUrl = new URL(`./pkg/deacon_wasm_bg.wasm?v=${ASSET_VERSION}`, import.meta.url);
      await mod.default({ module_or_path: wasmUrl });
      wasm = mod;
      self.postMessage({ type: MSG.READY });
    } catch (err) {
      self.postMessage({ type: MSG.ERROR, message: "Failed to initialize WASM: " + errText(err) });
    }
    return;
  }

  if (type === MSG.LOAD_INDEX) {
    try {
      index = new wasm.WasmIndex(new Uint8Array(data));
      self.postMessage({ type: MSG.INDEX_LOADED, info: index.info() });
    } catch (err) {
      // Already prefixed "Failed to load index: …"
      self.postMessage({ type: MSG.ERROR, message: errText(err) });
    }
    return;
  }

  if (type === MSG.RESET) {
    disposeActive();
    index = null;
    return;
  }

  if (type === MSG.FILTER) {
    try {
      disposeActive();
      startFilter(data);
    } catch (err) {
      self.postMessage({ type: MSG.ERROR, message: "Filtering failed: " + errText(err) });
    }
    return;
  }

  if (type === MSG.PULL) {
    if (!active) {
      self.postMessage({ type: MSG.ERROR, message: "No active filter session" });
      return;
    }
    try {
      await pump();
    } catch (err) {
      disposeActive();
      self.postMessage({ type: MSG.ERROR, message: "Filtering failed: " + errText(err) });
    }
    return;
  }
};
