export const MSG = Object.freeze({
  INIT: "init",
  READY: "ready",
  ERROR: "error",
  LOAD_INDEX: "load_index",
  INDEX_LOADED: "index_loaded",
  RESET: "reset",
  RESET_DONE: "reset_done",
  FILTER: "filter",
  PULL: "pull",
  PROGRESS: "progress",
  STAGE: "stage",
  OUTPUT_CHUNK_BATCH: "output_chunk_batch",
});

export const STAGE = Object.freeze({
  FINALIZING: "finalizing",
});

// Deacon filter parameters — deplete mode with the panhuman defaults. Shared by
// the worker (which configures the WASM session) and the main thread (which
// records them in each file's JSON summary), so they stay in lockstep.
export const FILTER_DEFAULTS = Object.freeze({
  deplete: true,
  absThreshold: 2,
  relThreshold: 0.05,
  prefixLength: 0,
});

// Version of the `deacon` crate the bundled WASM (pkg/) was built from. Bump this
// when regenerating pkg/ so the JSON summaries report the right version.
export const DEACON_VERSION = "deacon 0.15.0";

export const UPDEACON_VERSION = "0.2.0";
