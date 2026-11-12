// Index download and IndexedDB cache, keyed by URL and shared by both apps.
// Renaming the database would force a re-download
const DB_NAME = "updeacon";
const STORE = "index";

const BASE = "https://objectstorage.uk-london-1.oraclecloud.com/n/lrbvkel2wjot/b/human-genome-bucket/o/deacon/3/";
export const FILTER_INDEX_URL = BASE + "panhuman-1.k31w25c9b16.pidx"; // updeacon-s3
export const CHECK_INDEX_URL = BASE + "panhuman-1.k31w61c99.pidx"; // sapiometer

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

export const clearCachedIndex = (url) => withStore("readwrite", (store) => settle(store.delete(url)));

export async function putCachedIndex(url, blob) {
  // Discourage eviction
  try {
    await navigator.storage?.persist?.();
  } catch (_) {}
  return withStore("readwrite", (store) => settle(store.put(blob, url)));
}

// Delete indexes neither app uses. Both share this database on bede.im
export const pruneStaleIndexes = () =>
  withStore("readwrite", async (store) => {
    const keep = [FILTER_INDEX_URL, CHECK_INDEX_URL];
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
