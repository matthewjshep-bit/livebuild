import type { Exterior, RoofShape } from "@/lib/schema";

/**
 * What OpenStreetMap already told us about the building.
 *
 * `fetchFootprint` has always returned the way's tags and `/api/listing` has
 * always thrown them away, which is a shame: mappers record roof shape, storey
 * count, wall material and colour, and those are survey data under a licence we
 * already comply with and already attribute. Reading a satellite photograph to
 * work out something a surveyor wrote down is the wrong way round.
 *
 * Coverage is patchy in exactly the way building outlines are - dense US cities
 * inherited county GIS imports, newer subdivisions have nothing - so every
 * field here is optional and a miss is the normal case, not a failure.
 */

/** OSM's `roof:shape` vocabulary, mapped onto ours. */
const ROOF_SHAPES: Record<string, RoofShape> = {
  gabled: "gable",
  gable: "gable",
  hipped: "hip",
  hip: "hip",
  "half-hipped": "hip",
  flat: "flat",
  skillion: "shed",
  shed: "shed",
  gambrel: "gambrel",
  mansard: "mansard",
  pyramidal: "pyramidal",
  dome: "round",
  round: "round",
  onion: "round",
};

/**
 * Tags that name a colour we can use directly.
 *
 * OSM colours are either a CSS name or a hex triple, and both are already what
 * a renderer wants. Anything else - "brownish", a mapper's freehand - is
 * dropped rather than guessed at.
 */
function colour(raw: string | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$|^#[0-9a-f]{6}$/.test(value)) return value;
  return /^[a-z]+$/.test(value) && value.length <= 20 ? value : null;
}

function positiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value >= 1 ? Math.round(value) : null;
}

/**
 * The ridge direction, from whichever tag the mapper used.
 *
 * `roof:direction` is the way the roof faces and `roof:orientation` says only
 * whether the ridge runs along the building's long axis or across it. The first
 * is a bearing and usable; the second needs the outline to mean anything, so it
 * is left to the caller who has one.
 */
function ridgeBearing(tags: Record<string, string>): number | null {
  const raw = tags["roof:direction"];
  if (!raw) return null;
  const value = Number.parseFloat(raw);
  if (Number.isFinite(value)) return ((value % 360) + 360) % 360;

  // Mappers also write compass points.
  const points: Record<string, number> = {
    N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
    S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
  };
  return points[raw.trim().toUpperCase()] ?? null;
}

/**
 * Storeys, preferring what was surveyed over what was inferred.
 *
 * `building:levels` counts habitable floors and excludes the roof space, which
 * is the same thing the area-ratio guess in `inferStoreys` is trying to
 * estimate - so where a mapper has recorded it, it simply wins.
 */
function storeys(tags: Record<string, string>): number | null {
  return positiveInt(tags["building:levels"]);
}

export type OsmBuilding = {
  tags: Record<string, string>;
  /** Detached garages and the like, as bearings from the house's centre. */
  outbuildings?: Array<{ bearing: number; kind: string }>;
  /** Compass bearing to a mapped main entrance, if the way carried one. */
  entranceBearing?: number | null;
};

/**
 * Everything the map knows about the outside of this building.
 *
 * Returns null rather than an empty object when nothing useful was tagged, so
 * the caller can tell "the map has nothing" from "the map says flat roof".
 */
export function exteriorFromOsm(building: OsmBuilding): Exterior | null {
  const { tags } = building;

  const shape = ROOF_SHAPES[(tags["roof:shape"] ?? "").trim().toLowerCase()] ?? null;
  const roofMaterial = tags["roof:material"] ?? null;
  const roofColour = colour(tags["roof:colour"] ?? tags["roof:color"]);
  const wallMaterial = tags["building:material"] ?? tags["material"] ?? null;
  const wallColour = colour(tags["building:colour"] ?? tags["building:color"]);
  const levels = storeys(tags);
  const ridge = ridgeBearing(tags);

  const garage = (building.outbuildings ?? []).find((b) =>
    ["garage", "garages", "carport"].includes(b.kind),
  );

  const roof =
    shape || roofMaterial || roofColour || ridge !== null
      ? { shape, ridgeBearing: ridge, pitchDeg: null, material: roofMaterial, colour: roofColour }
      : null;
  const walls = wallMaterial || wallColour ? { material: wallMaterial, colour: wallColour } : null;

  if (!roof && !walls && levels === null && !garage && building.entranceBearing == null) {
    return null;
  }

  return {
    storeys: levels,
    roof,
    walls,
    frontDoorBearing: building.entranceBearing ?? null,
    garage: garage ? { bearing: garage.bearing, bays: null } : null,
    source: "map",
    imageryDate: null,
    // Surveyed rather than read off a picture, and worth saying so.
    confidence: "high",
    attribution: [],
  };
}

/**
 * Fold a reading of imagery into what the map already said.
 *
 * The map wins every contest. It is survey data and the reading is a model
 * looking at a photograph; where both have an opinion about the storey count,
 * preferring the guess would be choosing the weaker evidence because it arrived
 * later. The reading fills gaps, which on most buildings is nearly everything.
 */
export function mergeExterior(
  map: Exterior | null,
  read: Exterior | null,
): Exterior | null {
  if (!map) return read;
  if (!read) return map;

  const pick = <T>(surveyed: T | null | undefined, seen: T | null | undefined) =>
    surveyed ?? seen ?? null;

  return {
    storeys: pick(map.storeys, read.storeys),
    roof:
      map.roof || read.roof
        ? {
            shape: pick(map.roof?.shape, read.roof?.shape),
            ridgeBearing: pick(map.roof?.ridgeBearing, read.roof?.ridgeBearing),
            pitchDeg: pick(map.roof?.pitchDeg, read.roof?.pitchDeg),
            material: pick(map.roof?.material, read.roof?.material),
            colour: pick(map.roof?.colour, read.roof?.colour),
          }
        : null,
    walls:
      map.walls || read.walls
        ? {
            material: pick(map.walls?.material, read.walls?.material),
            colour: pick(map.walls?.colour, read.walls?.colour),
          }
        : null,
    frontDoorBearing: pick(map.frontDoorBearing, read.frontDoorBearing),
    garage: map.garage ?? read.garage ?? null,
    source: "both",
    imageryDate: read.imageryDate ?? null,
    // The merged object is only as trustworthy as its weaker half.
    confidence: read.confidence === "low" ? "low" : (map.confidence ?? read.confidence ?? null),
    attribution: [...new Set([...(map.attribution ?? []), ...(read.attribution ?? [])])],
  };
}
