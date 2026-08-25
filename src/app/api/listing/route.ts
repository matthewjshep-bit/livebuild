import { OSM_ATTRIBUTION, fetchFootprint, geocode } from "@/lib/listing/footprint";
import type { ListingFootprint, ListingResult } from "@/lib/listing/types";
import { addressFromZillowUrl, looksLikeUrl } from "@/lib/listing/url";
import { ListingError, fetchZillowListing } from "@/lib/listing/zillow";
import { prepareFootprint } from "@/lib/plan/footprint";

/**
 * Address in, listing photos and facts out.
 *
 * Scraping takes up to three minutes, so this is a server route with a long
 * budget rather than something the browser attempts. Availability is reported
 * by GET so the wizard can hide the feature rather than offer a button that
 * fails.
 */

export const maxDuration = 300;

export async function GET() {
  // Two separate capabilities, reported separately because they fail
  // separately. Scraping needs a paid token; putting the house in the right
  // shape needs nothing at all, and an address on its own is worth quite a lot
  // even when no photos can be fetched.
  return Response.json({
    available: Boolean(process.env.APIFY_TOKEN),
    photos: Boolean(process.env.APIFY_TOKEN),
    footprint: true,
  });
}

/**
 * The building's outline, or null.
 *
 * Isolated from the listing lookup and failing quietly on purpose. The outline
 * makes the model better; the listing makes it possible. Letting a slow
 * Overpass mirror or a suburb OSM has never mapped turn a successful
 * three-minute scrape into an error would be the wrong trade by a wide margin.
 */
async function outlineFor(listing: ListingResult): Promise<ListingFootprint | null> {
  try {
    const point = listing.location ?? (await geocode(listing.address));
    if (!point) return null;

    const found = await fetchFootprint(point.lat, point.lon);
    if (!found) return null;

    // The outline is the ground floor. Dividing the listing's living area by the
    // storey count is what keeps the two consistent - scaling a bungalow's
    // footprint to a two-storey house's total area would double its length and
    // width and produce a building twice the size of the real one.
    const stories = Math.max(1, Math.round(listing.facts.stories ?? 1));
    const groundSqft = listing.facts.sqft ? listing.facts.sqft / stories : undefined;

    const prepared = prepareFootprint(found.ring, groundSqft);

    return {
      ring: found.ring,
      outline: prepared.outline.map(([x, y]) => [x, y] as [number, number]),
      rects: prepared.rects,
      areaSqft: prepared.areaSqft,
      rotationDeg: prepared.rotationDeg,
      wayId: found.wayId,
      attribution: OSM_ATTRIBUTION,
    };
  } catch {
    return null;
  }
}

/**
 * What can be known from an address alone, with no scraper.
 *
 * The building's real outline needs no API key, so an unconfigured deployment
 * is not a dead end: the house still comes out the right shape and facing the
 * right way, and the user fills in the bedroom count themselves. Returning a
 * 501 here would throw that away because a *different* capability is missing.
 */
async function footprintOnly(query: string): Promise<Response> {
  const address = looksLikeUrl(query) ? (addressFromZillowUrl(query) ?? "") : query;
  if (address.length < 6) {
    return Response.json({ error: "no-address-in-link" }, { status: 422 });
  }

  const listing: ListingResult = {
    address,
    photos: [],
    photoCount: 0,
    facts: { beds: null, baths: null, sqft: null, yearBuilt: null, stories: null },
    remarks: null,
    status: null,
    listPrice: null,
    location: null,
    footprint: null,
  };

  // A missing outline is not a failed lookup. OpenStreetMap's building
  // coverage is genuinely absent in places, and its mirrors are genuinely
  // flaky, so a hard error here would turn a bad minute on a free service into
  // a dead end for the user. The address still names the property and the
  // house still gets built - just as a rectangle, the way it always was.
  return Response.json({ ...listing, footprint: await outlineFor(listing) });
}

export async function POST(request: Request) {
  const token = process.env.APIFY_TOKEN;

  let query: string;
  try {
    const body = await request.json();
    const raw = body?.url ?? body?.address;
    query = typeof raw === "string" ? raw.trim() : "";
  } catch {
    return Response.json({ error: "bad-request" }, { status: 400 });
  }

  if (query.length < 6) {
    return Response.json({ error: "bad-address" }, { status: 400 });
  }

  if (!token) return footprintOnly(query);

  try {
    const listing = await fetchZillowListing(query, token);
    return Response.json({ ...listing, footprint: await outlineFor(listing) });
  } catch (error) {
    // A failed scrape still leaves the map. Falling back to the outline turns
    // "we could not find that listing" into a house of the right shape, which
    // is a far better answer and costs one more request.
    if (error instanceof ListingError && error.status === 404) {
      const fallback = await footprintOnly(query);
      if (fallback.ok) return fallback;
    }
    if (error instanceof ListingError) {
      return Response.json(
        { error: "lookup-failed", message: error.message, detail: error.detail },
        { status: error.status },
      );
    }
    // A timeout here is the common case, and worth naming: three minutes of
    // waiting followed by "unknown error" tells the user nothing.
    const timedOut = error instanceof Error && /timeout|abort/i.test(error.message);
    return Response.json(
      { error: timedOut ? "timeout" : "unknown", message: timedOut ? "Zillow took too long" : undefined },
      { status: timedOut ? 504 : 500 },
    );
  }
}
