"use client";

import { deleteMediaFor, resolveMediaUrl } from "@/lib/media-store";
import { buildWalkGraph } from "@/lib/plan/walkgraph";
import { Property, parseProperty } from "@/lib/schema";
import { INDEX_KEY, PROPERTY_PREFIX, STORAGE_NS } from "@/lib/storage/namespace";

/**
 * Persistence for the proof of concept: localStorage plus JSON import/export.
 *
 * Deliberately not a database. The property document is small, the editor has a
 * single user, and keeping the file as the unit of exchange means a property can
 * be handed to the Python pipeline and back without any server in the loop.
 */

// Both spelled out in one place - see `storage/namespace`, which explains why
// they still carry the old product name.
const KEY_PREFIX = PROPERTY_PREFIX;

/**
 * Keys written while the app briefly renamed its own storage.
 *
 * This is here because the rename actually happened, in this repository, and it
 * took people's houses with it. The app moved every `mattermatt:` key to
 * `livebuild:` and deleted the original; the rename was then reverted, and
 * every tour built in between was left sitting under a prefix nothing looks for
 * any more. A house that vanishes off the home page is indistinguishable from a
 * house that was never built.
 *
 * So it is carried back, and - unlike last time - the carrying-back **stays**.
 * A migration is cheap to keep and expensive to have needed: it costs one scan
 * of localStorage on first read, and deleting it is what turned the first
 * rename into data loss the second time round. There is no third name planned;
 * that is exactly what would have been said about the second.
 *
 * Only localStorage was ever affected. The photographs live in IndexedDB, which
 * kept its name throughout precisely because it cannot be renamed in place, so
 * nothing of the expensive half was ever at risk.
 */
const ORPHANED_PREFIX = "livebuild:";

let recovered = false;

/**
 * Bring anything stranded by the rename back under the name in use.
 *
 * Copy, verify, then delete - in that order, and the removal is guarded by a
 * read-back rather than assumed. If the write fails, on quota or in a private
 * window, the stranded copy is still there to be found on the next load, which
 * is the whole point of doing it in that order.
 *
 * A key that already exists under the current name is left alone and the
 * stranded copy dropped: the current one is either the same document or a newer
 * one, and a stale copy must never clobber newer work.
 *
 * Runs once per page load, because it walks the whole of localStorage and
 * every read would otherwise pay for it. `force` exists so the recovery can be
 * exercised more than once in a test - this is the one piece of behaviour here
 * that runs exactly when somebody's houses are missing, so being able to test
 * it twice is worth one argument.
 */
export function recoverOrphanedKeys(force = false): void {
  if ((recovered && !force) || !canUseStorage()) return;
  recovered = true;
  try {
    const stranded: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(ORPHANED_PREFIX)) stranded.push(key);
    }
    // Collected first, then rewritten: mutating localStorage while walking it
    // by index shifts the keys still to come and would skip half of them.
    for (const key of stranded) {
      const restored = `${STORAGE_NS}:${key.slice(ORPHANED_PREFIX.length)}`;
      const value = window.localStorage.getItem(key);
      if (value === null) continue;
      if (window.localStorage.getItem(restored) === null) {
        window.localStorage.setItem(restored, value);
        if (window.localStorage.getItem(restored) !== value) continue;
      }
      window.localStorage.removeItem(key);
    }
  } catch {
    // Nothing is lost by giving up here: the stranded keys are untouched and
    // the next load tries again.
  }
}

function canUseStorage(): boolean {
  // Storage throws outright in some privacy modes rather than returning null,
  // and this module is imported during SSR where `window` does not exist.
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch {
    return false;
  }
}

/**
 * Neighbours are derived data, so they are recomputed on every read as well as
 * every write. A document that has never been saved - a freshly fetched bundled
 * sample, say - would otherwise arrive with no walk graph at all, and the tour
 * would render a room you cannot step out of.
 */
function withWalkGraph(property: Property): Property {
  return { ...property, nodes: buildWalkGraph(property.plan, property.nodes) };
}

/**
 * Every property actually in storage, found by looking rather than by asking.
 *
 * The index is a convenience - it preserves order, and reading one key beats
 * enumerating hundreds - but it must never be the only record that a tour
 * exists. Scanning is the ground truth, and cheap: localStorage holds tens of
 * keys here, not thousands.
 */
function scanPropertyIds(): string[] {
  if (!canUseStorage()) return [];
  const found: string[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(KEY_PREFIX)) continue;
      const id = key.slice(KEY_PREFIX.length);
      // An id is a single path segment. Anything else is a key from some
      // future scheme - `mattermatt:property:foo:meta` - and reading it as a
      // property named `foo:meta` would put a phantom on the home page.
      if (id && !id.includes(":") && !id.includes("/")) found.push(id);
    }
  } catch {
    return [];
  }
  return found;
}

/**
 * The saved properties, in the order they were added.
 *
 * Backed by the index and **corrected against what is really there**. The index
 * used to be trusted alone, and a single unparseable value made every tour
 * vanish at once: `JSON.parse` threw, this returned an empty list, the home page
 * showed nothing, and the next save wrote an index containing only the property
 * being saved - cementing the loss. The documents were never gone; nothing was
 * looking for them.
 *
 * So a document present in storage but missing from the index is listed anyway,
 * and an id in the index with no document behind it is dropped.
 */
export function listPropertyIds(): string[] {
  if (!canUseStorage()) return [];
  recoverOrphanedKeys();

  let indexed: string[] = [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(INDEX_KEY) ?? "[]");
    if (Array.isArray(parsed)) indexed = parsed.filter((id) => typeof id === "string");
  } catch {
    // A corrupt index is a lost ordering, not lost work.
  }

  const real = new Set(scanPropertyIds());
  const ordered = indexed.filter((id) => real.has(id));
  for (const id of real) if (!ordered.includes(id)) ordered.push(id);
  return ordered;
}

export function saveProperty(property: Property): void {
  if (!canUseStorage()) return;
  try {
    // Neighbours are always derived on save, so the stored document is
    // internally consistent no matter how it was edited.
    const withGraph: Property = {
      ...property,
      nodes: buildWalkGraph(property.plan, property.nodes),
    };
    // The document first, the index second. A crash between the two leaves a
    // property that is present but unlisted, which `listPropertyIds` now
    // recovers - whereas the other order would leave an index entry pointing at
    // nothing.
    window.localStorage.setItem(KEY_PREFIX + property.id, JSON.stringify(withGraph));

    const index = new Set(listPropertyIds());
    index.add(property.id);
    window.localStorage.setItem(INDEX_KEY, JSON.stringify([...index]));
  } catch {
    // Quota or private-mode failure. The user still has Export, so losing the
    // autosave is a degraded experience rather than lost work.
  }
}

export function loadProperty(id: string): Property | null {
  if (!canUseStorage()) return null;
  // Also here, not only in the listing: a `/tour/<id>` link opened directly
  // never goes near the home page, and a shared link that 404s is exactly the
  // way somebody finds out their house is gone.
  recoverOrphanedKeys();
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + id);
    return raw ? withWalkGraph(parseProperty(JSON.parse(raw))) : null;
  } catch {
    return null;
  }
}

export function deleteProperty(id: string): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.removeItem(KEY_PREFIX + id);
    const index = listPropertyIds().filter((x) => x !== id);
    window.localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    /* ignore */
  }
  // The document is small; its photos are not. Leaving them behind would fill
  // the quota with blobs nothing references any more.
  void deleteMediaFor(`${id}/`);
}

/** Bundled demo properties live under `public/properties/<id>/property.json`. */
export async function fetchBundledProperty(id: string): Promise<Property | null> {
  try {
    const res = await fetch(`/properties/${id}/property.json`, { cache: "no-store" });
    if (!res.ok) return null;
    return withWalkGraph(parseProperty(await res.json()));
  } catch {
    return null;
  }
}

/**
 * Swap every `idb:` media reference for an object URL the renderer can load.
 *
 * Done once here rather than inside the components, so nothing downstream has
 * to know that a photo might live in IndexedDB rather than at a URL.
 */
export async function hydrateMedia(property: Property): Promise<Property> {
  const nodes = await Promise.all(
    property.nodes.map(async (node) => ({
      ...node,
      photo: (await resolveMediaUrl(node.photo)) ?? node.photo,
    })),
  );
  const exteriorPhotos = await Promise.all(
    (property.exteriorPhotos ?? []).map(async (p) => ({
      ...p,
      photo: (await resolveMediaUrl(p.photo)) ?? p.photo,
    })),
  );
  return { ...property, nodes, exteriorPhotos };
}

/** Saved copy wins, so edits to a bundled demo survive a reload. */
export async function resolveProperty(id: string): Promise<Property | null> {
  const found = loadProperty(id) ?? (await fetchBundledProperty(id));
  return found ? hydrateMedia(found) : null;
}

export function downloadProperty(property: Property): void {
  const blob = new Blob([JSON.stringify(property, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${property.id}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
