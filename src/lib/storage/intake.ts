"use client";

import { DOC_STORE, del, entries, get, put } from "@/lib/storage/db";
import { mediaRef, putMedia, resolveMediaUrl } from "@/lib/media-store";
import type { BuildEvidence } from "@/lib/build/gather";
import type { ListingFacts, ListingFootprint } from "@/lib/listing/types";
import type { Plan } from "@/lib/schema";

/**
 * An import in progress, one record per tour.
 *
 * This replaces a single `"draft"` slot, and the slot is worth describing
 * because everything that went wrong followed from it. There was exactly one,
 * so a second import had nowhere to go: the wizard met you with "you have a
 * tour in progress" and would not let past it. The record also outlived the
 * build it belonged to - the autosave effect rewrote it moments after the build
 * cleared it - so that prompt appeared after *every* build, and the only way
 * through was "Start over", which deleted every photograph under the property's
 * prefix. That prefix is the finished tour's own. It emptied completed work.
 *
 * Keyed by property id, the whole class of problem goes away: an import belongs
 * to its tour, several can exist at once, and clearing one can only ever affect
 * the one it names.
 *
 * The photographs themselves are not in here, only references. They go into the
 * media store the moment they are chosen, because a `File` handle does not
 * survive a reload and an object URL means nothing afterwards.
 */

const PREFIX = "intake:";

export type IntakePhoto = {
  id: string;
  name: string;
  /** `idb:` reference; the blob is already written. */
  ref: string;
  roomLabel: string | null;
  /** Set when the label came from the vision pass rather than from a person. */
  guessed?: "high" | "low";
};

export type Intake = {
  propertyId: string;
  label: string;
  photos: IntakePhoto[];
  /** The plain-English description, so a resumed import keeps its first pass. */
  description?: string;
  /** What the listing lookup found, so resuming does not re-scrape. */
  facts?: ListingFacts | null;
  footprint?: ListingFootprint | null;
  site?: { lat: number; lon: number } | null;
  /**
   * What the evidence pass found, so resuming does not pay for it twice.
   *
   * Optional, and absent from every record written before the layout stage
   * existed, which read back as `undefined` and resume on the photos screen
   * exactly as they always did. No migration.
   */
  evidence?: BuildEvidence | null;
  /**
   * The layout as drawn so far.
   *
   * The single most valuable thing on this record. Everything else here can be
   * recovered by asking again - the photographs are already in the media store,
   * the listing can be re-scraped, the classifier can be re-run. A hand-drawn
   * ten-room house cannot be recovered from anything, and losing it to a
   * refreshed tab would be the worst failure this feature has.
   */
  layout?: Plan | null;
  /** Where the wizard was. Absent means "photos", which every old record was. */
  stage?: "photos" | "layout";
  updatedAt: number;
};

export async function loadIntake(propertyId: string): Promise<Intake | null> {
  return get<Intake>(DOC_STORE, PREFIX + propertyId);
}

export async function saveIntake(intake: Intake): Promise<void> {
  await put(DOC_STORE, PREFIX + intake.propertyId, { ...intake, updatedAt: Date.now() });
}

/**
 * Forget an import.
 *
 * The photographs are deliberately left alone. They live under the property's
 * own prefix and the finished tour's nodes point straight at them - deleting
 * them here is precisely the bug this module exists to end. Photographs go when
 * the property goes, through `deleteProperty`.
 */
export async function clearIntake(propertyId: string): Promise<void> {
  await del(DOC_STORE, PREFIX + propertyId);
}

/** Every import still in progress, newest first. */
export async function listIntakes(): Promise<Intake[]> {
  const all = await entries<Intake>(DOC_STORE);
  return all
    .filter(([key]) => key.startsWith(PREFIX))
    .map(([, value]) => value)
    .filter((intake): intake is Intake => Boolean(intake?.propertyId))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Write a photo to storage and return the record for it.
 *
 * Keyed under the property id it already has, so a completed build needs no
 * copy step - the references the wizard wrote stay valid for the tour's nodes.
 */
export async function storeIntakePhoto(
  propertyId: string,
  photoId: string,
  file: File,
): Promise<IntakePhoto> {
  const key = `${propertyId}/${photoId}/photo`;
  await putMedia(key, file);
  return { id: photoId, name: file.name, ref: mediaRef(key), roomLabel: null };
}

/** Object URLs for a restored import, so thumbnails work after a reload. */
export async function resolveIntakeUrls(intake: Intake): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  for (const photo of intake.photos) {
    const url = await resolveMediaUrl(photo.ref);
    if (url) urls.set(photo.id, url);
  }
  return urls;
}
