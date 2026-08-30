"use client";

import type { ListingResult } from "@/lib/listing/types";

/**
 * Client helpers for importing a listing and auto-labelling its photos.
 *
 * Both are optional upgrades. Without an Apify token there is no import button;
 * without an Anthropic key there is no auto-tagging - and in either case the
 * wizard works exactly as it did, by hand.
 */

/**
 * Photos are downscaled to this before classification.
 *
 * Measured against the synthetic demo house, 512px, 1024px and full size all
 * scored the same - those rooms are flat untextured boxes and no amount of
 * resolution makes them identifiable. Real listing photos carry detail that
 * plausibly does matter (cabinet handles, taps, tile), so this sits above the
 * point where it was shown not to hurt, and well below what would strain a
 * request body.
 */
const CLASSIFY_EDGE = 768;
const CLASSIFY_BATCH = 6;

/** Look a property up by street address or by listing URL. */
export async function lookupListing(query: string): Promise<ListingResult> {
  const isUrl = /^https?:\/\//i.test(query.trim());
  const response = await fetch("/api/listing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(isUrl ? { url: query } : { address: query }),
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(
      detail.message ??
        {
          "not-configured": "Listing lookup is not set up on this deployment.",
          timeout: "Zillow took too long to answer. Try again, or add the photos by hand.",
          "no-address-in-link":
            "That link does not contain an address. Paste the street address instead.",
          "nothing-found":
            "Nothing was found there. Try the full street address, with the city and state.",
        }[detail.error as string] ??
        "Could not find that address.",
    );
  }

  return response.json();
}

/**
 * How long to wait for one photograph before giving up on it.
 *
 * The proxy already gives up on Zillow after thirty seconds, but that guards
 * the wrong half: the browser had no limit of its own, and reading the body can
 * stall long after the headers arrived. A live import of a 38-photo listing hung
 * on photo 32 for a quarter of an hour behind a progress bar that never moved,
 * which is indistinguishable from the app being broken - and is very likely how
 * a house ends up built with no photographs in it at all.
 *
 * Generous rather than tight: these are 200-300KB JPEGs and a slow connection
 * is not a failure. What matters is that there is a limit.
 */
const PHOTO_TIMEOUT_MS = 45_000;

/**
 * How many photographs to pull at once.
 *
 * One at a time meant a 38-photo listing spent well over a minute downloading
 * before anything else could start, and every one of those seconds looked to
 * the user like the app deciding whether to work. Four is enough to hide most
 * of the latency without turning our own proxy into the bottleneck.
 */
const PHOTO_CONCURRENCY = 4;

/**
 * Fetch a listing photo as a blob.
 *
 * Goes through our own proxy: Zillow serves the image happily but sends no CORS
 * headers, so a direct fetch cannot read the bytes and an `<img>` cannot be
 * turned into a blob for storage.
 */
export async function fetchListingPhoto(url: string): Promise<Blob> {
  const response = await fetch(`/api/listing/photo?url=${encodeURIComponent(url)}`, {
    signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Could not download a photo (${response.status})`);
  return response.blob();
}

/**
 * Download a listing's gallery, in order, skipping whatever will not come.
 *
 * Order is preserved even though the requests overlap, because the filenames
 * carry it and a gallery that arrives shuffled reads as a different house. One
 * unreachable photograph costs that photograph and nothing else.
 */
export async function fetchListingPhotos(
  urls: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Array<{ index: number; blob: Blob }>> {
  const out: Array<{ index: number; blob: Blob }> = [];
  let done = 0;

  for (let i = 0; i < urls.length; i += PHOTO_CONCURRENCY) {
    const batch = urls.slice(i, i + PHOTO_CONCURRENCY);
    const settled = await Promise.all(
      batch.map(async (url, offset) => {
        try {
          return { index: i + offset, blob: await fetchListingPhoto(url) };
        } catch {
          return null;
        }
      }),
    );
    for (const item of settled) if (item) out.push(item);
    done = Math.min(i + PHOTO_CONCURRENCY, urls.length);
    onProgress?.(done, urls.length);
  }

  return out.sort((a, b) => a.index - b.index);
}

/** Small JPEG data URL, sized for recognising a room rather than rendering it. */
async function toThumbnail(blob: Blob): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = CLASSIFY_EDGE / Math.max(bitmap.width, bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * Math.min(scale, 1)));
    const height = Math.max(1, Math.round(bitmap.height * Math.min(scale, 1)));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return canvas.toDataURL("image/jpeg", 0.7);
  } catch {
    return null;
  }
}

export type Assignment = {
  id: string;
  room: string;
  /**
   * Other rooms visible through an opening from this one.
   *
   * Free adjacency data: a kitchen photo showing the dining room beyond an
   * archway says those two rooms touch. It is the strongest signal available
   * for making the generated plan resemble the actual house, and it costs the
   * user nothing.
   */
  connectsTo: string[];
  confidence: "high" | "low";
  sameRoomAs: string | null;
};

/**
 * Label a set of photos by room.
 *
 * Sent in small batches for two reasons: a serverless request body caps out
 * around 4.5MB, and a partial result is worth having - one failed batch costs
 * six photos rather than the whole set.
 */
export async function classifyPhotos(
  photos: Array<{ id: string; blob: Blob }>,
  rooms: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Assignment[]> {
  const results: Assignment[] = [];

  for (let i = 0; i < photos.length; i += CLASSIFY_BATCH) {
    const batch = photos.slice(i, i + CLASSIFY_BATCH);

    const images = (
      await Promise.all(
        batch.map(async (photo) => {
          const dataUrl = await toThumbnail(photo.blob);
          return dataUrl ? { id: photo.id, dataUrl } : null;
        }),
      )
    ).filter(Boolean) as Array<{ id: string; dataUrl: string }>;

    if (images.length > 0) {
      try {
        const response = await fetch("/api/classify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rooms, images }),
        });
        if (response.ok) {
          const data = await response.json();
          if (Array.isArray(data.assignments)) results.push(...data.assignments);
        }
      } catch {
        // A failed batch leaves those photos unlabelled, which the user can
        // still fix by hand - far better than losing the whole run.
      }
    }

    onProgress?.(Math.min(i + CLASSIFY_BATCH, photos.length), photos.length);
  }

  return results;
}
