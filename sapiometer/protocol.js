export const MSG = Object.freeze({
  INIT: "init",
  READY: "ready",
  ERROR: "error",
  LOAD_INDEX: "load_index",
  INDEX_LOADED: "index_loaded",
  RESET: "reset",
  FILTER: "filter",
  PULL: "pull",
  PROGRESS: "progress",
  OUTPUT_CHUNK_BATCH: "output_chunk_batch",
});

// updeacon-s3 filter params (deplete, panhuman defaults)
export const FILTER_DEFAULTS = Object.freeze({
  deplete: true,
  absThreshold: 2,
  relThreshold: 0.02,
  prefixLength: 0,
  rename: false,
  discardQuality: false,
});

// sapiometer thresholds (-a 1 -r 0, deplete). A read is human on a single minimizer hit
export const CHECK_DEFAULTS = Object.freeze({
  deplete: true,
  absThreshold: 1,
  relThreshold: 0,
});

// deacon crate version the bundled WASM was built from. Bump when regenerating pkg/
export const DEACON_VERSION = "deacon 0.19.1";
