"use client";

/**
 * The one IndexedDB connection, shared by everything that persists.
 *
 * Two stores, split by how the data behaves rather than by what it is:
 *
 *   media - photo and depth blobs, large and immutable once written
 *   docs  - small JSON records (wizard drafts, and anything else that outgrows
 *           localStorage's quota or its synchronous API)
 *
 * localStorage still holds the finished property documents. It is synchronous,
 * which the editor's autosave relies on, and those documents are kilobytes. The
 * blobs never go near it - a set of listing photos is tens of megabytes and
 * would blow the quota on the first import.
 */

/**
 * Kept under the old product name on purpose.
 *
 * A database cannot be renamed in place: the only way to move to `livebuild` is
 * to open both, copy every record across and delete the original - and this
 * store holds the photo and depth blobs, tens of megabytes per house. That is a
 * quota-doubling copy with a real chance of failing halfway, in exchange for a
 * string nobody ever sees. The localStorage keys were worth renaming because
 * they are kilobytes; this is not.
 */
const DB_NAME = "mattermatt";
const DB_VERSION = 2;

export const MEDIA_STORE = "media";
export const DOC_STORE = "docs";

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      // Creating only what is missing, so a database written by v1 - which had
      // no docs store - upgrades in place rather than losing its photos.
      if (!db.objectStoreNames.contains(MEDIA_STORE)) db.createObjectStore(MEDIA_STORE);
      if (!db.objectStoreNames.contains(DOC_STORE)) db.createObjectStore(DOC_STORE);
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Another tab is holding an older version of the database open."));
  });

  return dbPromise;
}

export async function put(store: string, key: string, value: unknown): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function get<T>(store: string, key: string): Promise<T | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const request = tx.objectStore(store).get(key);
    request.onsuccess = () => resolve((request.result as T) ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function del(store: string, key: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    // Deletion failing is not worth interrupting anyone over; the record simply
    // stays, and the storage panel will still list it.
    tx.onerror = () => resolve();
  });
}

export async function keys(store: string): Promise<string[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const request = tx.objectStore(store).getAllKeys();
    request.onsuccess = () => resolve(request.result as string[]);
    request.onerror = () => reject(request.error);
  });
}

export async function entries<T>(store: string): Promise<Array<[string, T]>> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const objectStore = tx.objectStore(store);
    const keyRequest = objectStore.getAllKeys();
    const valueRequest = objectStore.getAll();
    tx.oncomplete = () =>
      resolve(
        (keyRequest.result as string[]).map((k, i) => [k, (valueRequest.result as T[])[i]]),
      );
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteByPrefix(store: string, prefix: string): Promise<number> {
  const all = await keys(store);
  const doomed = all.filter((k) => k.startsWith(prefix));
  for (const key of doomed) await del(store, key);
  return doomed.length;
}

/**
 * How much has been stored, as reported by the browser.
 *
 * An estimate, and the browser is entitled to round it - but it is the only
 * number that reflects the actual quota, which is what matters when a large
 * import is about to fail.
 */
export async function storageUsage(): Promise<{ used: number; quota: number } | null> {
  try {
    if (!navigator.storage?.estimate) return null;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { used: usage, quota };
  } catch {
    return null;
  }
}

/**
 * Ask the browser not to evict this origin's data under storage pressure.
 *
 * Without it IndexedDB is "best effort" and may be cleared when the device runs
 * low - which for this app means someone's photos and half-built tour vanish
 * with no warning. Chrome grants it silently for engaged sites; Firefox may
 * prompt. Failure is not fatal, just less safe.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
