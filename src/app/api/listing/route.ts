import { ListingError, fetchZillowListing } from "@/lib/listing/zillow";

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
    return Response.json(await fetchZillowListing(address, token));
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
