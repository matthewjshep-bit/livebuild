import { OSM_ATTRIBUTION, fetchFootprint, geocode } from "@/lib/listing/footprint";
import type { ListingFootprint, ListingResult } from "@/lib/listing/types";
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
  return Response.json({ available: Boolean(process.env.APIFY_TOKEN) });
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

export async function POST(request: Request) {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    return Response.json({ error: "not-configured" }, { status: 501 });
  }

  let address: string;
  try {
    const body = await request.json();
    address = typeof body?.address === "string" ? body.address.trim() : "";
  } catch {
    return Response.json({ error: "bad-request" }, { status: 400 });
  }

  if (address.length < 6) {
    return Response.json({ error: "bad-address" }, { status: 400 });
  }

  try {
    const listing = await fetchZillowListing(address, token);
    return Response.json({ ...listing, footprint: await outlineFor(listing) });
  } catch (error) {
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
