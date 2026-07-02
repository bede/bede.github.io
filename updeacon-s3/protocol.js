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

// Deacon filter params (deplete mode, panhuman defaults); shared by worker and main thread
export const FILTER_DEFAULTS = Object.freeze({
  deplete: true,
  absThreshold: 2,
  relThreshold: 0.05,
  prefixLength: 0,
  rename: false,
  outputFasta: false,
});

// Host-check thresholds (-a 1 -r 0, deplete): a read is host on a single k-mer hit
export const DETECT_DEFAULTS = Object.freeze({
  deplete: true,
  absThreshold: 1,
  relThreshold: 0,
});

// deacon crate version the bundled WASM was built from; bump when regenerating pkg/
export const DEACON_VERSION = "deacon 0.15.0";

export const UPDEACON_VERSION = "0.2.0";
