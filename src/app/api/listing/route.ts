import { OSM_ATTRIBUTION, fetchFootprint, geocode } from "@/lib/listing/footprint";
import type { FootprintMiss, ListingFootprint, ListingResult } from "@/lib/listing/types";
import { addressFromZillowUrl, looksLikeUrl } from "@/lib/listing/url";
import { ListingError, fetchZillowListing } from "@/lib/listing/zillow";
import { inferStoreys, prepareFootprint } from "@/lib/plan/footprint";
import type { Exterior } from "@/lib/schema";
import { exteriorFromOsm } from "@/lib/site/osm";

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
 * The building's outline and where it stands, or null.
 *
 * Isolated from the listing lookup and failing quietly on purpose. The outline
 * makes the model better; the listing makes it possible. Letting a slow
 * Overpass mirror or a suburb OSM has never mapped turn a successful
 * three-minute scrape into an error would be the wrong trade by a wide margin.
 *
 * The point is returned alongside, and that is not incidental. Without a
 * scraper the listing carries no coordinates, so geocoding here and then
 * dropping the answer left an address-built house with `site: null` - no
 * bearing for the plan's axes, and a studio key light instead of the daylight
 * this house actually gets. The lookup already knows where the building is; it
 * only had to say so.
 */
async function outlineFor(
  listing: ListingResult,
  why?: { reason: FootprintMiss },
): Promise<{
  footprint: ListingFootprint | null;
  point: { lat: number; lon: number } | null;
  exterior: Exterior | null;
}> {
  let located: { lat: number; lon: number } | null = null;
  try {
    const point = listing.location ?? (await geocode(listing.address));
    if (!point) {
      // Worth separating from "no building here". Rural street addresses are
      // frequently absent from OpenStreetMap's address data - Nominatim knows
      // the town of Gold Bar, Washington and not Pine Road within it - and the
      // fix for the user is different in each case.
      if (why) why.reason = "not-located";
      return { footprint: null, point: null, exterior: null };
    }
    located = point;

    const found = await fetchFootprint(point.lat, point.lon);
    if (!found) {
      if (why) why.reason = "no-building";
      return { footprint: null, point: located, exterior: null };
    }

    // The outline is the ground floor, so the listing's total area has to be
    // divided by the number of floors standing on it. Zillow's own storey field
    // is usually absent, so it is only a hint - the areas decide.
    const raw = prepareFootprint(found.ring);
    // What the map recorded about the outside, which is survey data and beats
    // anything read off a photograph later.
    const exterior = exteriorFromOsm({ tags: found.tags, outbuildings: found.outbuildings });

    // A surveyed storey count settles it. The area ratio is a good estimate of
    // exactly the thing `building:levels` states outright, so where a mapper
    // has written it down there is nothing left to infer.
    const stories =
      exterior?.storeys ??
      (listing.facts.sqft
        ? Math.max(
            Math.round(listing.facts.stories ?? 1),
            inferStoreys(listing.facts.sqft, raw.areaSqft),
          )
        : Math.max(1, Math.round(listing.facts.stories ?? 1)));
    const groundSqft = listing.facts.sqft ? listing.facts.sqft / stories : undefined;

    const prepared = prepareFootprint(found.ring, groundSqft);

    return {
      footprint: {
        ring: found.ring,
        outline: prepared.outline.map(([x, y]) => [x, y] as [number, number]),
        rects: prepared.rects,
        areaSqft: prepared.areaSqft,
        rotationDeg: prepared.rotationDeg,
        storeys: stories,
        wayId: found.wayId,
        attribution: OSM_ATTRIBUTION,
        frame: prepared.frame,
        streets: found.streets,
        buildings: found.buildings,
      },
      point: located,
      exterior: exterior
        ? { ...exterior, attribution: [OSM_ATTRIBUTION] }
        : null,
    };
  } catch {
    if (why) why.reason = "lookup-failed";
    // A point already resolved survives a later failure: knowing where the
    // house is does not depend on Overpass having answered about its shape.
    return { footprint: null, point: located, exterior: null };
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
  const why: { reason: FootprintMiss } = { reason: "no-building" };
  const { footprint, point, exterior } = await outlineFor(listing, why);
  return Response.json({
    ...listing,
    location: point,
    footprint,
    exterior,
    footprintMiss: footprint ? null : why.reason,
    scraperConfigured: Boolean(process.env.APIFY_TOKEN),
  });
}

export async function POST(request: Request) {
  const token = process.env.APIFY_TOKEN;

  let query: string;
  /**
   * How much to do.
   *
   * The two halves of an address lookup have wildly different costs. The map
   * half - geocode, building outline, the tags a surveyor left - takes a couple
   * of seconds and needs no key. The listing half is a scrape that takes
   * minutes and then downloads forty photographs. Doing both on every address
   * meant that typing where the house is, when you already had the pictures in
   * hand, cost you the whole scrape anyway.
   */
  let mode: "outline" | "full" = "full";
  try {
    const body = await request.json();
    const raw = body?.url ?? body?.address;
    query = typeof raw === "string" ? raw.trim() : "";
    if (body?.mode === "outline") mode = "outline";
  } catch {
    return Response.json({ error: "bad-request" }, { status: 400 });
  }

  if (query.length < 6) {
    return Response.json({ error: "bad-address" }, { status: 400 });
  }

  // Asked for the map half only, or there is no scraper to ask anyway.
  if (mode === "outline" || !token) return footprintOnly(query);

  try {
    const listing = await fetchZillowListing(query, token);
    const why: { reason: FootprintMiss } = { reason: "no-building" };
    const { footprint, point, exterior } = await outlineFor(listing, why);
    return Response.json({
      ...listing,
      location: listing.location ?? point,
      footprint,
      exterior,
      footprintMiss: footprint ? null : why.reason,
      scraperConfigured: true,
    });
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
