import { fetchOverhead } from "@/lib/site/imagery";

/**
 * The satellite frame, for a person to look at.
 *
 * Everywhere else in this app the overhead shot is fetched, read by the model
 * and dropped - never written down, which is deliberate. This is the one place
 * a person needs to see it, because reshaping a house from a photograph nobody
 * is shown is a button that rearranges your floor plan and asks you to trust
 * it. The outline is drawn over this, so the question "is that the right
 * building?" can actually be answered.
 *
 * It is a proxy rather than a URL because `GOOGLE_MAPS_API_KEY` is server-side
 * and has to stay there: handed to the browser it would be a billable key on a
 * public page. Still not persisted - the bytes are passed through.
 */

export const maxDuration = 30;

/** Matches the trace's own framing, so pixels line up with the traced ring. */
const EXTENT_M = 30;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return Response.json({ error: "bad-point" }, { status: 400 });
  }

  const extent = Number(url.searchParams.get("extent"));
  const tile = await fetchOverhead(
    lat,
    lon,
    Number.isFinite(extent) && extent > 0 ? extent : EXTENT_M,
  );

  if (!tile) {
    // No key configured, or Google refused. The caller shows the plan without
    // a backdrop rather than failing - the reshape still works, it is just
    // harder to check.
    return Response.json({ error: "no-imagery" }, { status: 503 });
  }

  return new Response(Buffer.from(tile.base64, "base64"), {
    headers: {
      "content-type": tile.mediaType,
      // The frame for a point does not change day to day, and this is fetched
      // again on every open of the panel. Private because it is the operator's
      // key paying for it.
      "cache-control": "private, max-age=86400",
      // What the caller needs to draw a ring on top: without these the image is
      // a picture rather than a measurement.
      "x-tile-size": String(tile.size),
      "x-tile-zoom": String(tile.zoom),
      "x-tile-mpp": String(tile.metresPerPixel),
    },
  });
}
