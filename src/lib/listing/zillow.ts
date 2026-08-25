import "server-only";

import type { ListingResult } from "@/lib/listing/types";
import { addressFromZillowUrl, looksLikeUrl } from "@/lib/listing/url";

/**
 * Look up a listing by address and return its photos and facts.
 *
 * Ported from the prvt-reviews wholesaling repo (`ghl-broker/rehab-scan.js`),
 * narrowed to the part that matters here. The original also graded condition
 * and priced a rehab against a Seattle flip catalog; none of that bears on
 * rendering geometry, so it was left behind rather than forked.
 *
 * Scraping runs through Apify because Zillow has no public API. It is slow -
 * up to three minutes - and is the reason this is a server route with a long
 * timeout rather than something the browser does.
 */

const APIFY_ACTOR = "maxcopell~zillow-detail-scraper";
const MAX_PHOTOS = 40;

/**
 * Pick a rendition near 1536px from Zillow's `mixedSources` shape.
 *
 * Their largest renditions are far bigger than a depth model can use, and the
 * import downloads every one of them. Taking the widest under 1536 keeps a set
 * of forty photos to a sane download without visibly costing detail.
 */
function bestPhotoUrl(photo: {
  mixedSources?: { jpeg?: Array<{ url: string; width: number }> };
  url?: string;
}): string | null {
  const jpegs = photo?.mixedSources?.jpeg ?? [];
  if (jpegs.length > 0) {
    const under = jpegs.filter((j) => j.width <= 1536).sort((a, b) => b.width - a.width);
    return (under[0] ?? [...jpegs].sort((a, b) => a.width - b.width)[0])?.url ?? null;
  }
  return photo?.url ?? null;
}

export class ListingError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message);
  }
}

export async function fetchZillowListing(
  /** A street address, or a Zillow listing URL. */
  query: string,
  apifyToken: string,
): Promise<ListingResult> {
  const isUrl = looksLikeUrl(query);
  // A link identifies one listing exactly, which is why people paste them - so
  // it is passed through as a link rather than reduced to its address and
  // searched for again.
  const input = isUrl ? { startUrls: [{ url: query.trim() }] } : { addresses: [query] };

  const response = await fetch(
    `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items` +
      `?token=${encodeURIComponent(apifyToken)}&timeout=180`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(200_000),
    },
  );

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    // A rejected token is the caller's problem to fix, not a transient upstream
    // failure - so it must not be reported as a bad gateway.
    throw new ListingError(
      `Zillow lookup failed (Apify ${response.status})`,
      response.status === 401 || response.status === 403 ? 400 : 502,
      detail,
    );
  }

  const items = await response.json();
  const item = Array.isArray(items) ? items[0] : null;
  if (!item) {
    throw new ListingError("Zillow could not match that address", 404);
  }

  const raw = (item.photos?.length ? item.photos : item.responsivePhotos) ?? [];
  const photos = raw.map(bestPhotoUrl).filter(Boolean).slice(0, MAX_PHOTOS) as string[];

  return {
    // Prefer the address Zillow itself reports, so a pasted link comes back
    // labelled with a real address rather than with the URL.
    address: [item.address?.streetAddress, item.address?.city, item.address?.state]
      .filter(Boolean)
      .join(", ") || (isUrl ? (addressFromZillowUrl(query) ?? query) : query),
    photos,
    photoCount: raw.length,
    facts: {
      beds: Number(item.bedrooms) || null,
      baths: Number(item.bathrooms) || null,
      sqft: Number(item.livingArea) || null,
      yearBuilt: Number(item.yearBuilt) || Number(item.resoFacts?.yearBuilt) || null,
      stories: Number(item.resoFacts?.stories) || null,
    },
    remarks: (item.description ?? "").slice(0, 1500) || null,
    status: item.homeStatus ?? null,
    listPrice: Number(item.price) || null,
    // Zillow returns the parcel's own coordinates, which are far better than
    // geocoding the address string - a geocoder can land on the road, and
    // thirty metres of error picks the neighbour's house out of OSM.
    location:
      Number.isFinite(Number(item.latitude)) && Number.isFinite(Number(item.longitude))
        ? { lat: Number(item.latitude), lon: Number(item.longitude) }
        : null,
    footprint: null,
  };
}
