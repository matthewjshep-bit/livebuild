"use client";

import { DOC_STORE, del, entries, get, put } from "@/lib/storage/db";
import { deleteMediaFor, mediaRef, putMedia, resolveMediaUrl } from "@/lib/media-store";
import type { Plan } from "@/lib/schema";

/**
 * Wizard progress that survives a reload.
 *
 * Previously nothing was written until the very last step, so closing the tab
 * partway through - or simply refreshing - threw away every photo and every
 * room label. That is the most expensive part of the whole flow to redo, and
 * losing it silently is worse than never having started.
 *
 * Photos go into the media store as soon as they are chosen, because a `File`
 * handle does not survive a reload and an object URL is meaningless afterwards.
 * The rest of the draft is small JSON.
 */

const KEY = "draft";

export type DraftPhoto = {
  id: string;
  name: string;
  /** `idb:` reference; the blob is already written. */
  ref: string;
  roomLabel: string | null;
};

export type Draft = {
  propertyId: string;
  label: string;
  step: "photos" | "describe" | "rooms" | "arrange" | "done";
  photos: DraftPhoto[];
  plan: Plan | null;
  /** The plain-English description, so a resumed draft keeps its first pass. */
  description?: string;
  updatedAt: number;
};

/** One draft at a time. A second in-progress tour would be more confusing than
 *  useful, and the finished tours are already listed separately. */
export async function loadDraft(): Promise<Draft | null> {
  return get<Draft>(DOC_STORE, KEY);
}

export async function saveDraft(draft: Draft): Promise<void> {
  await put(DOC_STORE, KEY, { ...draft, updatedAt: Date.now() });
}

export async function clearDraft(discardPhotos: boolean): Promise<void> {
  const draft = await loadDraft();
  await del(DOC_STORE, KEY);
  // On "start over" the photos are rubbish; on a successful build they have
  // already been copied under the property's own prefix.
  if (draft && discardPhotos) await deleteMediaFor(`${draft.propertyId}/`);
}

/**
 * Write a photo to storage and return the draft record for it.
 *
 * Keyed under the property id it will eventually have, so a completed build
 * needs no copy step - the references the wizard already wrote stay valid.
 */
export async function storeDraftPhoto(
  propertyId: string,
  photoId: string,
  file: File,
): Promise<DraftPhoto> {
  const key = `${propertyId}/${photoId}/photo`;
  await putMedia(key, file);
  return { id: photoId, name: file.name, ref: mediaRef(key), roomLabel: null };
}

/** Object URLs for a restored draft, so thumbnails work after a reload. */
export async function resolveDraftUrls(draft: Draft): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  for (const photo of draft.photos) {
    const url = await resolveMediaUrl(photo.ref);
    if (url) urls.set(photo.id, url);
  }
  return urls;
}

export async function listDrafts(): Promise<Array<[string, Draft]>> {
  return entries<Draft>(DOC_STORE);
}
