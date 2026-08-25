"use client";

import { MEDIA_STORE, del, deleteByPrefix, entries, get, keys, put } from "@/lib/storage/db";

/**
 * Photos and depth maps for locally-authored properties.
 *
 * References are stored in the property document as `idb:<key>`, resolved to
 * object URLs when the document is loaded. Bundled samples keep plain paths, so
 * both kinds of property flow through the same viewer.
 */

const PREFIX = "idb:";

export function isManagedRef(ref: string): boolean {
  return ref.startsWith(PREFIX);
}

export function mediaRef(key: string): string {
  return PREFIX + key;
}

/**
 * The storage key inside a reference.
 *
 * Refs may carry a `?v=` cache-buster, added when a photo is replaced so the
 * object-URL cache below does not keep serving the old blob. That suffix is not
 * part of the key, and failing to strip it silently broke every replaced photo:
 * the lookup missed, `resolveMediaUrl` returned null, and the node fell back to
 * a blank image with no error anywhere.
 */
export function refToKey(ref: string): string {
  return (isManagedRef(ref) ? ref.slice(PREFIX.length) : ref).split("?")[0];
}

export async function putMedia(key: string, blob: Blob): Promise<string> {
  await put(MEDIA_STORE, key, blob);
  // Drop any cached URL for this key so a replacement is actually seen.
  const cached = urlCache.get(key);
  if (cached) {
    URL.revokeObjectURL(cached);
    urlCache.delete(key);
  }
  return mediaRef(key);
}

export async function getMedia(key: string): Promise<Blob | null> {
  return get<Blob>(MEDIA_STORE, key);
}

// Object URLs are revoked only when their blob is replaced or deleted. A tour
// holds several textures at once, and revoking eagerly would pull a blob out
// from under a texture still loading.
const urlCache = new Map<string, string>();

export async function resolveMediaUrl(ref: string): Promise<string | null> {
  if (!isManagedRef(ref)) return ref;
  const key = refToKey(ref);

  const cached = urlCache.get(key);
  if (cached) return cached;

  const blob = await getMedia(key);
  if (!blob) return null;

  const url = URL.createObjectURL(blob);
  urlCache.set(key, url);
  return url;
}

export async function deleteMedia(key: string): Promise<void> {
  await del(MEDIA_STORE, key);
  const url = urlCache.get(key);
  if (url) {
    URL.revokeObjectURL(url);
    urlCache.delete(key);
  }
}

/** Remove every blob belonging to a property or draft. */
export async function deleteMediaFor(prefix: string): Promise<number> {
  for (const [key, url] of urlCache) {
    if (key.startsWith(prefix)) {
      URL.revokeObjectURL(url);
      urlCache.delete(key);
    }
  }
  return deleteByPrefix(MEDIA_STORE, prefix);
}

export async function mediaKeys(): Promise<string[]> {
  return keys(MEDIA_STORE);
}

/** Total bytes held per key prefix, for the storage panel. */
export async function mediaSizes(): Promise<Map<string, number>> {
  const all = await entries<Blob>(MEDIA_STORE);
  const sizes = new Map<string, number>();
  for (const [key, blob] of all) {
    sizes.set(key, blob?.size ?? 0);
  }
  return sizes;
}
