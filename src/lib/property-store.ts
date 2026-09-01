"use client";

import { deleteMediaFor, resolveMediaUrl } from "@/lib/media-store";
import { buildWalkGraph } from "@/lib/plan/walkgraph";
import { Property, parseProperty } from "@/lib/schema";

/**
 * Persistence for the proof of concept: localStorage plus JSON import/export.
 *
 * Deliberately not a database. The property document is small, the editor has a
 * single user, and keeping the file as the unit of exchange means a property can
 * be handed to the Python pipeline and back without any server in the loop.
 */

const KEY_PREFIX = "livebuild:property:";
const INDEX_KEY = "livebuild:index";

/**
 * The keys these used to be written under, before the product was renamed.
 *
 * Prefix rather than an explicit list, because the old scheme covered the
 * documents, the index and the publish passphrase alike, and a browser that
 * built a house last week has all three.
 */
const LEGACY_PREFIX = "mattermatt:";

let migrated = false;

/**
 * Carry anything written under the old name forward, once per page load.
 *
 * A rename that changes a storage key is a rename that loses the user's work:
 * the documents would still be sitting in localStorage, and nothing would ever
 * look for them again. So the old keys are read across before the first read
 * of the new ones.
 *
 * Copy, verify, then delete - in that order. If the write fails (quota, private
 * mode) the original is still there to be found on the next load, which is why
 * the removal is guarded by a read-back rather than assumed to have worked.
 * An already-migrated key is left alone rather than overwritten, so a stale old
 * copy can never clobber newer work.
 */
function migrateLegacyKeys(): void {
  if (migrated || !canUseStorage()) return;
  migrated = true;
  try {
    const legacy: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(LEGACY_PREFIX)) legacy.push(key);
    }
    // Collected first, then rewritten: mutating localStorage while iterating it
    // by index shifts the keys still to come and would skip half of them.
    for (const key of legacy) {
      const renamed = `livebuild:${key.slice(LEGACY_PREFIX.length)}`;
      const value = window.localStorage.getItem(key);
      if (value === null) continue;
      if (window.localStorage.getItem(renamed) === null) {
        window.localStorage.setItem(renamed, value);
        if (window.localStorage.getItem(renamed) !== value) continue;
      }
      window.localStorage.removeItem(key);
    }
  } catch {
    // Nothing is lost by giving up here: the old keys are untouched.
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
      // future scheme - `livebuild:property:foo:meta` - and reading it as a
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
  migrateLegacyKeys();

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
  migrateLegacyKeys();
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
      depth: node.depth ? await resolveMediaUrl(node.depth) : null,
    })),
  );
  return { ...property, nodes };
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
