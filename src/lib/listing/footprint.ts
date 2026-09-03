import "server-only";

import { type Street, streetsFrom, type NearbyBuilding } from "@/lib/listing/streets";

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
 * How far out the neighbours are fetched.
 *
 * Wide enough for the houses either side and across the road, which is what
 * a photograph from the street shows behind and beside the house. Bounded,
 * because a dense terrace at twice this returns a hundred buildings for a
 * lookup that is supposed to feel instant.
 */
const NEIGHBOUR_RADIUS_M = 80;

/**
 * How far to look for streets. Far enough to see the corner, near enough to
 * stay a picture of this house rather than of the neighbourhood.
 */
const STREET_RADIUS_M = 130;

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
  /** The named roads round it, which came back in the same request. */
  streets: Street[];
  /** The outline as [lat, lon] pairs, unclosed. */
  ring: Array<[number, number]>;
  /**
   * OSM tags. Mappers record more than the address here - storey count, roof
   * shape and direction, wall material and colour - and all of it is survey
   * data rather than something a model had to read off a photograph.
   */
  tags: Record<string, string>;
  /** OSM way id, for attribution and for checking a match by hand. */
  wayId: number;
  /**
   * The other buildings on the parcel, as bearings from this one's centre.
   *
   * They are filtered out of the house search as outbuildings, which is right -
   * a detached garage is not the dwelling. But *where the garage is* says which
   * side of the house the driveway comes in on, and that is worth keeping
   * rather than discarding with it.
   */
  outbuildings: Array<{ bearing: number; kind: string }>;
  /**
   * Every other building the query returned, outline and all.
   *
   * The neighbours used to be fetched and thrown away. They are what puts the
   * house on its street rather than on a lawn in a void, so they are kept -
   * as geography, to be projected with the same frame as everything else.
   */
  buildings: NearbyBuilding[];
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
  /**
   * The building and the streets round it, in one request.
   *
   * They were two, and the second one cost an address a hundred and eighty
   * seconds: Overpass is free, oversubscribed and answers 504 often enough that
   * this file already calls it "a normal Tuesday", and asking twice doubles
   * every one of those odds for a lookup that is supposed to feel instant. A
   * union of two `around` clauses at different radii is one round trip and the
   * same work at the far end.
   *
   * The streets are a nicety and the building is the point, so nothing here
   * fails for want of a road.
   */
  const query = `[out:json][timeout:25];
(
  way(around:${NEIGHBOUR_RADIUS_M},${lat},${lon})["building"];
  way(around:${STREET_RADIUS_M},${lat},${lon})["highway"]["name"];
);
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

  const measured = (data.elements ?? [])
    .filter(
      (e) =>
        e.type === "way" &&
        // Roads come back in the same answer now, and a road is not a building.
        e.tags?.building !== undefined &&
        (e.geometry?.length ?? 0) >= 4,
    )
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

      // How near the building comes to the query point at all - what the
      // old thirty-metre query answered by returning it or not.
      const nearest = points.reduce((m, [x, y]) => Math.min(m, Math.hypot(x, y)), Infinity);

      return {
        element,
        areaSqm,
        inside,
        centroid,
        distance: Math.hypot(centroid[0], centroid[1]),
        nearest,
      };
    });

  // The query reaches eighty metres now, for the neighbours. The house is
  // still chosen among the buildings the thirty-metre query would have
  // returned: any that comes within that of the point, or contains it.
  const candidates = measured
    .filter((c) => c.inside || c.nearest <= SEARCH_RADIUS_M)
    .filter((c) => !OUTBUILDINGS.has(c.element.tags?.building ?? ""))
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

  // Bearings are measured in the query point's local frame, where +x is east
  // and +y is north, so this is a plain compass bearing and needs no site.
  const chosenCentroid = candidates[0].centroid;
  const outbuildings = measured
    .filter((c) => c.element.id !== chosen.id)
    .filter((c) => OUTBUILDINGS.has(c.element.tags?.building ?? ""))
    // On this parcel, not the neighbour's: the wider query would otherwise
    // hand the driveway to next door's garage.
    .filter(
      (c) =>
        Math.hypot(c.centroid[0] - chosenCentroid[0], c.centroid[1] - chosenCentroid[1]) <=
        SEARCH_RADIUS_M,
    )
    .map((c) => ({
      kind: c.element.tags?.building ?? "",
      bearing:
        ((Math.atan2(c.centroid[0] - chosenCentroid[0], c.centroid[1] - chosenCentroid[1]) * 180) /
          Math.PI +
          360) %
        360,
    }));

  const buildings: NearbyBuilding[] = measured
    .filter((c) => c.element.id !== chosen.id)
    .map((c) => {
      const tags = c.element.tags ?? {};
      const ring = c.element.geometry!.map(
        (p) => [Math.round(p.lat * 1e6) / 1e6, Math.round(p.lon * 1e6) / 1e6] as [number, number],
      );
      if (
        ring.length > 1 &&
        ring[0][0] === ring[ring.length - 1][0] &&
        ring[0][1] === ring[ring.length - 1][1]
      ) {
        ring.pop();
      }
      const levels = Number.parseInt(tags["building:levels"] ?? "", 10);
      const heightM = Number.parseFloat((tags.height ?? "").replace(/[^0-9.]/g, ""));
      return {
        ring,
        kind: tags.building && tags.building !== "yes" ? tags.building : null,
        levels: Number.isFinite(levels) && levels > 0 ? levels : null,
        heightM: Number.isFinite(heightM) && heightM > 0 ? heightM : null,
        wayId: c.element.id,
      };
    })
    .filter((b) => b.ring.length >= 3);

  return {
    ring,
    tags: chosen.tags ?? {},
    wayId: chosen.id,
    outbuildings,
    streets: streetsFrom(data.elements ?? []),
    buildings,
  };
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
