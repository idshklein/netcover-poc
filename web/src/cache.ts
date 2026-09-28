/** Tiny IndexedDB cache for Overpass responses (keyed by the query string). */
const DB = 'netcover-cache', STORE = 'overpass';

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await open();
    return await new Promise((res, rej) => {
      const r = db.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => res(r.result as T | undefined);
      r.onerror = () => rej(r.error);
    });
  } catch { return undefined; }
}

export async function cacheSet(key: string, value: unknown): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch { /* quota or private mode: ignore */ }
}

export async function cacheClear(): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((res) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).clear(); tx.oncomplete = () => res(); });
  } catch { /* ignore */ }
}
