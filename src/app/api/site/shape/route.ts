import { OSM_ATTRIBUTION, fetchFootprint } from "@/lib/listing/footprint";

/**
 * The building's outline at a point, from the map.
 *
 * The build already asks this question, but it asks it as one part of looking
 * up an address - geocode, outline, listing facts, photographs. Reshaping an
 * existing tour has none of that to do: the tour already knows where it is. All
 * it wants is the outline, so this is the address lookup's map half on its own.
 *
 * Only OpenStreetMap. When the map has nothing the caller falls through to the
 * satellite trace in `/api/site/read`, which is the same order the build uses
 * and the right one: a surveyed outline beats a reading of a photograph.
 */

export const maxDuration = 60;

export async function POST(request: Request) {
  let body: { lat?: number; lon?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad-json" }, { status: 400 });
  }

  const lat = Number(body.lat);
  const lon = Number(body.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return Response.json({ error: "bad-point" }, { status: 400 });
  }

  try {
    const found = await fetchFootprint(lat, lon);
    if (!found) {
      // Not an error. Most newer addresses simply are not drawn, which is the
      // case the trace exists for - so this answers "no" rather than failing,
      // and the caller knows to go and look at the photograph instead.
      return Response.json({ ring: null, miss: "no-building" });
    }

    // The ring only. Area and rotation come from `prepareFootprint`, which the
    // caller has to run anyway and which needs the room count to decide how
    // much of the outline's detail to keep.
    return Response.json({
      ring: found.ring,
      wayId: found.wayId,
      attribution: OSM_ATTRIBUTION,
    });
  } catch {
    // Overpass returns 504 often enough under load that treating it as fatal
    // would make reshaping unreliable for a reason the operator cannot act on.
    // Saying the lookup failed lets the caller trace instead.
    return Response.json({ ring: null, miss: "lookup-failed" });
  }
}
