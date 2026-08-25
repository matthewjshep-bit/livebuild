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
/**
 * Zillow's stand-in for a property with no photographs of its own.
 *
 * An off-market home often has a single "photo" that is a Google Street View
 * image, fetched through Google's Static Street View API with **Zillow's** key
 * and signature. Three separate reasons not to take it:
 *
 * - It is not a photograph of the property in any useful sense. It is the kerb,
 *   from the road, and it shows nothing of the inside.
 * - The URL is signed with Zillow's own Google API key and quota. Theirs to
 *   spend on their page, not ours to spend from a server.
 * - It is Google Maps imagery, and their terms restrict derivative works. That
 *   is the same reason satellite tiles were rejected as a source for building
 *   outlines.
 *
 * The photo proxy already refuses it - its allowlist is Zillow's own image
 * hosts - so leaving it in the list only produced a photo that always failed to
 * download and a count of "1" for a property with no pictures. Dropping it here
 * reports zero, which is the honest answer and one the rest of the flow already
 * handles: the house still gets built from its outline and its room counts.
 */
function isPlaceholderPhoto(url: string): boolean {
  return /(^|\/\/)maps\.googleapis\.com\//i.test(url) || /\/streetview\?/i.test(url);
}

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
  const photos = (raw.map(bestPhotoUrl).filter(Boolean) as string[])
    .filter((url) => !isPlaceholderPhoto(url))
    .slice(0, MAX_PHOTOS);

  return {
    // Prefer the address Zillow itself reports, so a pasted link comes back
    // labelled with a real address rather than with the URL.
    address: [item.address?.streetAddress, item.address?.city, item.address?.state]
      .filter(Boolean)
      .join(", ") || (isUrl ? (addressFromZillowUrl(query) ?? query) : query),
    photos,
    // What the listing actually holds, after the Street View stand-in is
    // discarded - so "0 of 0" is reported rather than "0 of 1".
    photoCount: photos.length,
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
