import { z } from "zod";

import { HouseSpec } from "@/lib/spec/schema";

/**
 * The property document is the contract between every phase: the wizard writes
 * it, the editor edits it, the tour viewer reads it, and the bill of materials
 * is derived from it. Keeping those decoupled depends on nothing outside this
 * file knowing the on-disk shape.
 *
 * Coordinates. The hand-drawn floor plan is the canonical metric world frame.
 * Plan-space is 2D [x, y] in metres on the floor plane; the viewer lifts it to
 * three.js Y-up via `planToWorld`. Camera nodes register into that frame.
 *
 * Fields are removed from here the same way they are added: a document that
 * still carries an old one parses fine and simply drops it, because these are
 * not strict objects. That is what made taking the depth pass out a deletion
 * rather than a migration.
 */

export const Vec2 = z.tuple([z.number(), z.number()]);
export type Vec2 = z.infer<typeof Vec2>;

/**
 * The single measurement that gives the whole plan metric scale. The editor
 * draws in abstract canvas pixels; the user then types one real dimension they
 * know ("kitchen is 12ft wide") and every other length follows from the ratio.
 */
export const ScaleRef = z.object({
  px: z.number().positive(),
  meters: z.number().positive(),
});
export type ScaleRef = z.infer<typeof ScaleRef>;

export const Room = z.object({
  id: z.string().min(1),
  label: z.string(),
  /** Closed polygon in plan-space metres, wound counter-clockwise. */
  polygon: z.array(Vec2).min(3),
  ceilingHeight: z.number().positive().default(2.7),
  /**
   * Storey. 0 is the ground floor, 1 upstairs, -1 a basement.
   *
   * Kept as a plain integer rather than a separate floors collection because
   * every floor shares one plan-space coordinate system - which is what lets
   * stairs line up between storeys, and lets the dollhouse stack them.
   */
  level: z.number().int().default(0),
});
export type Room = z.infer<typeof Room>;

/**
 * A doorway. Openings are load-bearing in two different ways: they cut holes in
 * the extruded walls, and they define the edges of the walk graph — you can
 * only step between two nodes if their rooms are connected.
 */
export const Opening = z.object({
  id: z.string().min(1),
  between: z.tuple([z.string(), z.string()]),
  at: Vec2,
  width: z.number().positive().default(0.9),
  /**
   * A door joins rooms on one storey; stairs join two storeys. They are the
   * same thing to the walk graph - a way through - and differ only in whether
   * the rooms they connect share a level.
   */
  kind: z.enum(["door", "stairs"]).default("door"),
});
export type Opening = z.infer<typeof Opening>;

export const Plan = z.object({
  scaleRef: ScaleRef,
  rooms: z.array(Room),
  openings: z.array(Opening).default([]),
});
export type Plan = z.infer<typeof Plan>;

/**
 * One photo, posed inside the plan.
 *
 * It carried `depth` and `parallaxBudget` for the 2.5D shell renderer, which
 * has been gone since the photographs came off the model. Nothing read either
 * one; they were written on every build, resolved to object URLs on every load,
 * and stored on every document, for a renderer that no longer exists.
 */
export const TourNode = z.object({
  id: z.string().min(1),
  roomId: z.string().min(1),
  /** [x, y] in plan-space metres, plus eye height above the floor. */
  position: Vec2,
  eyeHeight: z.number().positive().default(1.5),
  /** Compass-style yaw in degrees, 0 = +y in plan-space, increasing clockwise. */
  heading: z.number(),
  pitch: z.number().default(0),
  fovDeg: z.number().positive().default(78),
  photo: z.string().min(1),
  neighbors: z.array(z.string()).default([]),
});
export type TourNode = z.infer<typeof TourNode>;

/**
 * Condition and rates, the only parts of the bill of materials that are stored.
 *
 * Everything else the BOM needs is derived: quantities come from the model, and
 * scope follows from condition. But condition is an observation the user
 * corrects, and rates are their pricing - neither can be recomputed from the
 * plan, so both live on the document.
 *
 * Kept loose on purpose. The element vocabulary belongs to `src/lib/bom/`, and
 * pinning it here would mean a schema migration every time a room kind learns
 * about a new fitting.
 */
export const Grade = z.enum(["good", "fair", "dated", "poor", "not_visible"]);

/**
 * Where the house is, and which way it points.
 *
 * Everything else in the model is local geometry; daylight is the one thing
 * that depends on the actual site. Both fields come free from the address
 * lookup - the parcel's coordinates from the listing, and the bearing from the
 * angle the building had to be rotated to square it up - so a house built from
 * an address gets a sun that is genuinely correct for it rather than plausible.
 *
 * Nullish because a house drawn by hand or built from photographs has no site,
 * and the lighting falls back to a fixed studio key light for those.
 */
const LatLon = z.tuple([z.number(), z.number()]);

/**
 * How a point on the map becomes a point on this plan.
 *
 * The same four numbers `prepareFootprint` works out while squaring the
 * building up - the centroid it projected about, the turn, the corner it
 * moved to zero, the area nudge. The wizard has carried them since the
 * satellite backdrop; the built house threw them away, which is why nothing
 * outside the walls could ever be put where it really is.
 */
export const SitePlanFrame = z.object({
  centre: z.object({ lat: z.number(), lon: z.number() }),
  rotationDeg: z.number(),
  offset: z.tuple([z.number(), z.number()]),
  scale: z.number().positive(),
});
export type SitePlanFrame = z.infer<typeof SitePlanFrame>;

/** A named road near the house, as OpenStreetMap holds it, one run per way. */
export const SiteStreet = z.object({
  name: z.string(),
  /** The `highway` tag: residential, tertiary... Decides how wide it is drawn. */
  kind: z.string().nullish(),
  ways: z.array(z.array(LatLon)),
});
export type SiteStreet = z.infer<typeof SiteStreet>;

/** A building near the house: its outline, and what the map says of its height. */
export const SiteBuilding = z.object({
  ring: z.array(LatLon).min(3),
  kind: z.string().nullish(),
  levels: z.number().int().positive().nullish(),
  heightM: z.number().positive().nullish(),
  wayId: z.number().nullish(),
});
export type SiteBuilding = z.infer<typeof SiteBuilding>;

export const Site = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  /**
   * Compass bearing of the plan's +x axis, in degrees.
   *
   * The footprint is projected with +x east and +y south, then rotated by the
   * building's dominant wall angle to square it up - so +x ends up that many
   * degrees round from east.
   */
  planXBearing: z.number().default(90),
  /**
   * The surroundings, kept as geography plus the frame to project it with.
   *
   * Lat/lon rather than plan metres, because that is what the map lookup
   * returns and what a later re-fit of the building would have to re-project
   * anyway; the one projection lives in `siteInPlan`, on top of the
   * round-tripped `latLonToPlan`. All absent on a house built before this
   * existed, or drawn by hand - and absence draws nothing, as it always did.
   */
  frame: SitePlanFrame.nullish(),
  // Optional rather than defaulted, so a site written by hand - every suite
  // and every older document does - is still a site without them.
  streets: z.array(SiteStreet).nullish(),
  buildings: z.array(SiteBuilding).nullish(),
  /** ODbL requires it wherever the map's data is shown. */
  attribution: z.array(z.string()).nullish(),
});
export type Site = z.infer<typeof Site>;

/**
 * What the outside of the building is like.
 *
 * Everything else in the model is either drawn by the user or inferred from
 * their photographs, both of which describe the inside. This describes the
 * outside, and it comes from two places that are worth keeping apart:
 * OpenStreetMap's own tags, which are survey data, and a reading of satellite
 * and street-level imagery, which is a model looking at a picture. `source`
 * says which, because a measurement and a good guess should not be presented as
 * the same thing.
 *
 * Every field is optional and the whole object is nullish. A house drawn by
 * hand has no site and no exterior; a mapped one may have storeys and nothing
 * else. Consumers must treat every absence as normal, the way the footprint
 * miss already is.
 */
export const RoofShape = z.enum([
  "gable", "hip", "flat", "shed", "gambrel", "mansard", "pyramidal", "round", "complex",
]);
export type RoofShape = z.infer<typeof RoofShape>;

export const Exterior = z.object({
  storeys: z.number().int().positive().nullish(),
  roof: z
    .object({
      shape: RoofShape.nullish(),
      /**
       * Compass bearing of the ridge line, degrees. Only meaningful for a shape
       * that has a ridge - a hip or a pyramid does not.
       */
      ridgeBearing: z.number().nullish(),
      pitchDeg: z.number().nullish(),
      material: z.string().nullish(),
      colour: z.string().nullish(),
    })
    .nullish(),
  walls: z
    .object({
      material: z.string().nullish(),
      colour: z.string().nullish(),
    })
    .nullish(),
  /**
   * Compass bearing from the middle of the building to its front door.
   *
   * The single most useful thing about a facade: it says which side of the
   * house people arrive at, which is what an entry hall and a porch are for and
   * what decides whether a plan reads the right way round.
   */
  frontDoorBearing: z.number().nullish(),
  garage: z
    .object({
      bearing: z.number(),
      bays: z.number().int().positive().nullish(),
    })
    .nullish(),
  /** Which of the two sources this came from. */
  source: z.enum(["map", "imagery", "both"]).default("map"),
  /** How old the street-level photograph was, when one was read. */
  imageryDate: z.string().nullish(),
  confidence: z.enum(["high", "low"]).nullish(),
  /** Required wherever any of this is shown. */
  attribution: z.array(z.string()).default([]),
});
export type Exterior = z.infer<typeof Exterior>;

export const Property = z.object({
  id: z.string().min(1),
  label: z.string().default(""),
  /** Canonical unit is always metres; this only controls display formatting. */
  displayUnits: z.enum(["ft", "m"]).default("ft"),
  plan: Plan,
  nodes: z.array(TourNode).default([]),
  /** Per-room condition, keyed by room id then by element. */
  condition: z.record(z.string(), z.record(z.string(), Grade)).default({}),
  /** Roof, systems and exterior - things belonging to no single room. */
  houseCondition: z.record(z.string(), Grade).default({}),
  /** Rate-card overrides, keyed by rate id. Absent means the default. */
  rates: z.record(z.string(), z.number()).default({}),
  /**
   * Whether this is a whole house or a room on its own.
   *
   * Optional, and absent means a house - which is what every document written
   * before this existed is, so nothing has to be migrated. It exists because a
   * handful of judgements are only sensible about a house: a two-hundred-square-
   * foot kitchen should not be told it is "below the usual range for a house
   * under 1,000 sqft", and it has no roof, no furnace and no foundation to
   * report as ungraded.
   *
   * Deliberately stored rather than inferred. "No site and not many rooms"
   * describes a single room and also describes a house drawn by hand, and
   * guessing between them would put the wrong advice on somebody's scope of
   * work with nothing to point at.
   */
  kind: z.enum(["room", "house"]).nullish(),
  /** Where on earth the house is, and which way it faces. */
  site: Site.nullish(),
  /** What the outside looks like, from the map and from imagery. */
  exterior: Exterior.nullish(),
  /**
   * What each room is made of - finishes, ceilings, trim, how rooms open onto
   * one another.
   *
   * Keyed by room id and kept here rather than on `Room` for the same reason
   * `condition` is: a re-layout regenerates every room wholesale, and anything
   * hanging off one would be destroyed by a rebuild without a word. Nullish, so
   * every document written before it existed still parses and still renders -
   * absent means the model falls back to deriving everything, which is what it
   * did for the whole of its life until now.
   */
  spec: HouseSpec.nullish(),
  /**
   * Where this tour lives in the cloud, once it has been sent there.
   *
   * The slug is kept on the document so a later sync updates the same row
   * rather than minting a second copy of the same house, and so the link can be
   * offered without asking anyone to remember it.
   *
   * It is a long random string, and that is the access control: there is no
   * account model, the table has no read policy, and `/t/<slug>` is the only
   * way in. Guessing one is the whole difficulty, so it must never be derived
   * from the address.
   */
  cloud: z
    .object({
      slug: z.string().min(1),
      syncedAt: z.number(),
    })
    .nullish(),
});
export type Property = z.infer<typeof Property>;

export function parseProperty(raw: unknown): Property {
  return Property.parse(raw);
}
