import "server-only";

import {
  TILE_PX,
  TILE_SCALE,
  bearingBetween,
  fovForBuilding,
  metresBetween,
  metresPerPixel,
  zoomForExtent,
} from "@/lib/site/geo";


/**
 * Satellite and street-level pictures of the actual house.
 *
 * A deliberate reversal, and worth stating plainly because the code twice says
 * the opposite. `listing/footprint.ts` rejected satellite imagery as a source
 * of building outlines, and commit `8035c23` stripped Zillow's Street View
 * placeholder, both citing Google's terms on derivative works. Those objections
 * were right about what they addressed and remain so: **the outline still comes
 * from OpenStreetMap**, as vectors somebody already surveyed, and nothing here
 * traces geometry out of a JPEG.
 *
 * What imagery is for instead is everything the outline cannot say - how many
 * storeys, what the roof does, what the walls are made of, which side the front
 * door is on. That is read from the picture, against the outline we already
 * have, rather than invented.
 *
 * Three rules the terms impose, all load-bearing:
 *
 * - The key is the operator's own, read on the server, never shipped to a
 *   browser. Zillow's key was one of the three reasons the old path was cut.
 * - **Imagery is never persisted.** It is fetched, read, and dropped. Only the
 *   derived facts and the panorama's id and date are kept. Metadata may be
 *   cached; pictures may not.
 * - Whatever is displayed keeps Google's attribution, and their watermark is
 *   never cropped off.
 */

/** Read at call time, not module scope - see `cloud/server.ts` for the bug. */
const key = () => (process.env.GOOGLE_MAPS_API_KEY ?? "").trim();

export function isImageryConfigured(): boolean {
  return key().length > 0;
}

const STREET_VIEW = "https://maps.googleapis.com/maps/api/streetview";
const STATIC_MAP = "https://maps.googleapis.com/maps/api/staticmap";

export type PanoramaLookup =
  | { status: "ok"; panoId: string; lat: number; lon: number; date: string | null }
  | { status: "none" }
  | { status: "error"; detail: string };

/**
 * Is there a street-level panorama near here, and where exactly is it.
 *
 * The metadata endpoint is **not billed**, which is why it goes first: a
 * property on a private road has no coverage at all, and finding that out
 * should not cost an image request. It also returns the panorama's true
 * position, which the heading calculation needs - the camera is out in the
 * road, not at the address.
 *
 * `source=outdoor` keeps out the indoor business photospheres that otherwise
 * come back for a house near a shopfront.
 */
export async function findPanorama(lat: number, lon: number): Promise<PanoramaLookup> {
  if (!isImageryConfigured()) return { status: "error", detail: "not-configured" };

  const url =
    `${STREET_VIEW}/metadata?location=${lat},${lon}` +
    `&radius=50&source=outdoor&key=${encodeURIComponent(key())}`;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return { status: "error", detail: `http-${response.status}` };

    const data = (await response.json()) as {
      status?: string;
      pano_id?: string;
      date?: string;
      location?: { lat: number; lng: number };
    };

    // ZERO_RESULTS is the ordinary miss - a private road, a long driveway - and
    // must degrade as quietly as an unmapped building already does.
    if (data.status === "ZERO_RESULTS" || data.status === "NOT_FOUND") return { status: "none" };
    if (data.status !== "OK" || !data.pano_id || !data.location) {
      return { status: "error", detail: data.status ?? "unknown" };
    }

    return {
      status: "ok",
      panoId: data.pano_id,
      lat: data.location.lat,
      lon: data.location.lng,
      // Worth carrying through and showing. A 2011 panorama of a house
      // remodelled in 2019 is not merely stale, it is misleading, and only the
      // date makes that visible.
      date: data.date ?? null,
    };
  } catch (error) {
    return { status: "error", detail: error instanceof Error ? error.message : "failed" };
  }
}

export type Tile = {
  /** JPEG bytes, base64, ready to hand to the model. Never written to disk. */
  base64: string;
  mediaType: "image/jpeg";
  /** Pixel dimensions of the file, after `scale`. */
  size: number;
  zoom: number;
  metresPerPixel: number;
};

/**
 * The overhead shot, and the numbers that make it measurable.
 *
 * `maptype=satellite` rather than `hybrid` on purpose: hybrid burns road names
 * and place labels into the pixels, and a label lying across a roof is
 * contamination in an image whose whole job is to be read.
 *
 * The tile is always north-up - Maps Static has no rotation parameter - which
 * is what lets the plan's own local frame overlay it directly. That frame
 * projects x east and **y south**, and the tile's y also runs south down the
 * image, so the two agree with no flip. The *other* local projection in this
 * codebase, in `listing/footprint.ts`, has y running north; using that one here
 * would mirror the outline vertically and still look plausible on a symmetric
 * house.
 */
export async function fetchOverhead(
  lat: number,
  lon: number,
  extentM: number,
): Promise<Tile | null> {
  if (!isImageryConfigured()) return null;

  const zoom = zoomForExtent(lat, extentM);
  const url =
    `${STATIC_MAP}?center=${lat},${lon}&zoom=${zoom}` +
    `&size=${TILE_PX}x${TILE_PX}&scale=${TILE_SCALE}` +
    `&maptype=satellite&format=jpg&key=${encodeURIComponent(key())}`;

  const base64 = await fetchAsBase64(url);
  if (!base64) return null;

  return {
    base64,
    mediaType: "image/jpeg",
    size: TILE_PX * TILE_SCALE,
    zoom,
    metresPerPixel: metresPerPixel(lat, zoom),
  };
}

export type Facade = {
  base64: string;
  mediaType: "image/jpeg";
  /** Compass bearing the camera was pointed along. */
  heading: number;
  fov: number;
};

/**
 * The house from the road, aimed at the house.
 *
 * The heading is computed from the *panorama's* position toward the building,
 * not from the address - which is the specific thing that made the old Street
 * View path worthless. Commit `8035c23` cut it partly because "it shows the
 * kerb rather than the house", and it did, because nothing ever told it which
 * way to look.
 *
 * `return_error_code=true` is not optional. Without it a location with no
 * imagery returns **HTTP 200 and a grey "Sorry, we have no imagery here"
 * JPEG** - which would be handed to the model and come back as a confident,
 * entirely invented reading of a house nobody photographed.
 */
export async function fetchFacades(
  pano: { panoId: string; lat: number; lon: number },
  building: { lat: number; lon: number },
  widthM: number,
  obliques = [-28, 28],
): Promise<Facade[]> {
  if (!isImageryConfigured()) return [];

  const heading = bearingBetween(pano, building);
  const fov = fovForBuilding(widthM, metresBetween(pano, building));

  const wanted = [0, ...obliques].map((offset) => (heading + offset + 360) % 360);
  const shots = await Promise.all(
    wanted.map(async (aim) => {
      const url =
        `${STREET_VIEW}?size=${TILE_PX}x${TILE_PX}&pano=${encodeURIComponent(pano.panoId)}` +
        `&heading=${aim.toFixed(1)}&pitch=0&fov=${fov}&source=outdoor` +
        `&return_error_code=true&key=${encodeURIComponent(key())}`;
      const base64 = await fetchAsBase64(url);
      return base64 ? { base64, mediaType: "image/jpeg" as const, heading: aim, fov } : null;
    }),
  );

  return shots.filter(Boolean) as Facade[];
}

/** Attribution, which the terms require wherever the imagery is shown. */
export const GOOGLE_ATTRIBUTION = "Satellite and Street View imagery © Google";

async function fetchAsBase64(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return null;
    const type = response.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    // An empty or near-empty body is a placeholder, not a photograph.
    return bytes.byteLength > 2_000 ? bytes.toString("base64") : null;
  } catch {
    return null;
  }
}
