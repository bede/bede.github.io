import { FILTER_DEFAULTS } from "./protocol.js?v=f40b3fc";

// Index download and IndexedDB cache, keyed by URL and shared by both apps.
// Renaming the database would force a re-download
const DB_NAME = "updeacon";
const STORE = "index";

const BASE = "https://objectstorage.uk-london-1.oraclecloud.com/n/lrbvkel2wjot/b/human-genome-bucket/o/deacon/3/";
export const CHECK_INDEX_URL = BASE + "panhuman-1.k31w61c99.pidx"; // sapiometer

// updeacon-s3's indexes, with download sizes and filter params. A magic link may name one
// (options.index, chosen in mint.html), else the default is used
export const FILTER_INDEXES = {
  "panhuman-1.k31w15.pidx": { size: 1845493803, params: FILTER_DEFAULTS },
  "panhuman-1.k31w25c9b16.pidx": {
    size: 555745323,
    params: Object.freeze({ ...FILTER_DEFAULTS, absThreshold: 2, relThreshold: 0.02 }),
  },
};
export const DEFAULT_FILTER_INDEX = "panhuman-1.k31w15.pidx";
export const filterIndexUrl = (filename) => BASE + filename;
// Recognised local filenames use their associated params too; other local indexes use defaults.
export const filterIndexParams = (filename) => FILTER_INDEXES[filename]?.params ?? FILTER_DEFAULTS;

const settle = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

async function withStore(mode, fn) {
  const open = indexedDB.open(DB_NAME, 1);
  open.onupgradeneeded = () => open.result.createObjectStore(STORE);
  const db = await settle(open);
  try {
    return await fn(db.transaction(STORE, mode).objectStore(STORE));
  } finally {
    db.close();
  }
}

export const getCachedIndex = (url) => withStore("readonly", (store) => settle(store.get(url)));

// Every cached index, sapiometer's included
export const clearCachedIndexes = () => withStore("readwrite", (store) => settle(store.clear()));

export async function putCachedIndex(url, blob) {
  // Discourage eviction
  try {
    await navigator.storage?.persist?.();
  } catch (_) {}
  return withStore("readwrite", (store) => settle(store.put(blob, url)));
}

// Delete indexes neither app uses any more. Both share this database on bede.im
export const pruneStaleIndexes = () =>
  withStore("readwrite", async (store) => {
    const keep = [...Object.keys(FILTER_INDEXES).map(filterIndexUrl), CHECK_INDEX_URL];
    const keys = await settle(store.getAllKeys());
    await Promise.all(keys.filter((key) => !keep.includes(key)).map((key) => settle(store.delete(key))));
  });

// -> Blob. Calls onProgress(received, total), total 0 when unknown
export async function downloadIndex(url, onProgress = () => {}) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  const total = Number(resp.headers.get("content-length")) || 0;
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received, total);
  }
  return new Blob(chunks);
}
