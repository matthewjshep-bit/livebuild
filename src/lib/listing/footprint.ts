import "server-only";

/**
 * The building's real outline, from OpenStreetMap.
 *
 * This is the one part of "build the house from an address" that comes back as
 * actual geometry rather than pixels. Satellite imagery was the obvious idea and
 * is the wrong one twice over: Google's and Bing's terms restrict derivative
 * works, and tracing an outline out of a JPEG means recovering vectors that
 * somebody already has. OSM building footprints are vectors to begin with,
 * free, keyless, and ODbL - which needs attribution, and nothing else.
 *
 * Coverage is the real limitation and it is uneven. Dense US cities are close
 * to complete because county GIS imports were donated wholesale; newer
 * subdivisions and much of the rural map have nothing. A miss is normal and the
 * caller must treat it as one - the house still gets built, just packed into a
 * rectangle the way it always was.
 */

/**
 * Overpass mirrors, tried in order.
 *
 * The main instance is free and correspondingly oversubscribed; it returned a
 * 504 during development, which is a normal Tuesday rather than an outage.
 *
 * **Every mirror here must carry the whole planet.** Several public Overpass
 * instances serve regional extracts, and they do not announce it: `osm.ch`
 * answers a query in Washington DC with HTTP 200 and an empty element list,
 * which is indistinguishable from "there is no building at this address". It
 * was briefly in this list and made three famous buildings vanish. A mirror
 * that lies quietly is worse than one that is simply down.
 */
const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

/** How far from the point to look for a building, in metres. */
const SEARCH_RADIUS_M = 30;

/**
 * Identify ourselves, in the format Overpass will actually accept.
 *
 * Both services ask callers to identify themselves, and Overpass enforces it in
 * a way worth writing down: a descriptive string with spaces in it - "livebuild
 * property model builder" - is rejected with **HTTP 406**, while the same name
 * in `token/version` form is served normally. The failure looks nothing like a
 * user-agent problem from the outside; it arrives as an HTML error page where
 * JSON was expected, and through a retry loop it reads as the service being
 * down.
 */
const USER_AGENT = "livebuild.ai/1.0";

/**
 * Overpass is free and busy. These are the answers that mean "try again".
 *
 * 500 belongs here despite looking like a bug on their side: the mirrors return
 * it when overloaded, and treating it as fatal made one mirror's bad minute
 * abandon the whole lookup. Measured back-to-back, the main instance answered
 * 200, 200 and 504 in fifteen seconds - flakiness is the normal condition here,
 * not an incident.
 */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export type FetchedFootprint = {
  /** The outline as [lat, lon] pairs, unclosed. */
  ring: Array<[number, number]>;
  /** OSM tags, which sometimes carry the address and the storey count. */
  tags: Record<string, string>;
  /** OSM way id, for attribution and for checking a match by hand. */
  wayId: number;
};

async function overpass(query: string): Promise<unknown> {
  let lastError: unknown = null;

  // Two passes over the mirrors, impatient then patient.
  //
  // A healthy Overpass answers this query in one to four seconds, so the first
  // pass gives each mirror a short leash and moves on - one hung mirror was
  // making an address take 58 seconds behind a single spinner, most of it spent
  // waiting on an instance that was never going to answer. The second pass
  // waits properly, because a busy instance that fails once often succeeds a
  // few seconds later and giving up would report "no building" for a house that
  // is mapped.
  for (let attempt = 0; attempt < 2; attempt++) {
    const budget = attempt === 0 ? 12_000 : 45_000;
    for (const mirror of MIRRORS) {
      try {
        const response = await fetch(mirror, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": USER_AGENT,
          },
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(budget),
        });
        if (!response.ok) {
          lastError = new Error(`Overpass ${response.status}`);
          if (!RETRYABLE.has(response.status)) break;
          continue;
        }
        return await response.json();
      } catch (error) {
        lastError = error;
      }
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw lastError ?? new Error("Overpass unreachable");
}

/**
 * Buildings that are not the house.
 *
 * A residential parcel commonly has two or three mapped buildings, and the
 * detached garage is a building in exactly the same sense the house is.
 */
const OUTBUILDINGS = new Set([
  "shed", "garage", "garages", "carport", "roof", "hut", "greenhouse", "cabin",
]);

/** Smaller than this is an outbuilding whatever it is tagged, in square metres. */
const MIN_HOUSE_SQM = 45;

/**
 * The building at a point, if OSM knows about one.
 *
 * Selection is by **containment first, then distance** - not by size. Picking
 * the smallest candidate was the obvious guard against grabbing a whole
 * apartment block, and in practice it reliably chose the garden shed: the first
 * live run on a real Seattle address returned a 384-square-foot outbuilding and
 * packed a six-room house into it. The geocoded point lands on the dwelling, so
 * asking which polygon actually contains it answers the question directly.
 */
export async function fetchFootprint(
  lat: number,
  lon: number,
): Promise<FetchedFootprint | null> {
  const query = `[out:json][timeout:25];
way(around:${SEARCH_RADIUS_M},${lat},${lon})["building"];
out geom;`;

  const data = (await overpass(query)) as {
    elements?: Array<{
      id: number;
      type: string;
      tags?: Record<string, string>;
      geometry?: Array<{ lat: number; lon: number }>;
    }>;
  };

  const metresPerLon = Math.cos((lat * Math.PI) / 180) * 111_320;
  const toLocal = (p: { lat: number; lon: number }): [number, number] => [
    (p.lon - lon) * metresPerLon,
    (p.lat - lat) * 111_320,
  ];

  const candidates = (data.elements ?? [])
    .filter((e) => e.type === "way" && (e.geometry?.length ?? 0) >= 4)
    .filter((e) => !OUTBUILDINGS.has(e.tags?.building ?? ""))
    .map((element) => {
      const points = element.geometry!.map(toLocal);

      let twice = 0;
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < points.length; i++) {
        const [x0, y0] = points[i];
        const [x1, y1] = points[(i + 1) % points.length];
        const cross = x0 * y1 - x1 * y0;
        twice += cross;
        cx += (x0 + x1) * cross;
        cy += (y0 + y1) * cross;
      }
      const areaSqm = Math.abs(twice) / 2;
      const centroid: [number, number] =
        Math.abs(twice) < 1e-6 ? [0, 0] : [cx / (3 * twice), cy / (3 * twice)];

      // The query point is the local origin, so containment is a ray cast at
      // (0, 0) and distance is the centroid's own magnitude.
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        if (yi > 0 !== yj > 0 && 0 < ((xj - xi) * (0 - yi)) / (yj - yi || 1e-12) + xi) {
          inside = !inside;
        }
      }

      return { element, areaSqm, inside, distance: Math.hypot(centroid[0], centroid[1]) };
    })
    .filter((c) => c.areaSqm >= MIN_HOUSE_SQM);

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.inside !== b.inside) return a.inside ? -1 : 1;
    return a.distance - b.distance;
  });
  const chosen = candidates[0].element;

  const ring = chosen.geometry!.map((p) => [p.lat, p.lon] as [number, number]);
  // Overpass closes the ring; the geometry code treats it as implicitly closed.
  if (
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
  ) {
    ring.pop();
  }

  return { ring, tags: chosen.tags ?? {}, wayId: chosen.id };
}

/**
 * An address to a point, when the listing did not carry one.
 *
 * Nominatim is the fallback rather than the primary path: it is rate-limited to
 * one request a second and asks for a real User-Agent, whereas Zillow returns
 * the coordinates of the actual parcel alongside the listing. Geocoding a
 * street address can land on the road or the centre of the block, and thirty
 * metres of error is the difference between this house and next door's.
 */
export async function geocode(
  address: string,
): Promise<{ lat: number; lon: number } | null> {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
    encodeURIComponent(address);

  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;

  const results = (await response.json()) as Array<{ lat: string; lon: string }>;
  const first = results[0];
  if (!first) return null;

  const lat = Number(first.lat);
  const lon = Number(first.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

/** Attribution, which the ODbL requires wherever the outline is shown. */
export const OSM_ATTRIBUTION = "Building outline © OpenStreetMap contributors (ODbL)";
