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

const KEY_PREFIX = "mattermatt:property:";
const INDEX_KEY = "mattermatt:index";

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

export function listPropertyIds(): string[] {
  if (!canUseStorage()) return [];
  try {
    return JSON.parse(window.localStorage.getItem(INDEX_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
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
