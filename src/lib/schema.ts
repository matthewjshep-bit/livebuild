import { z } from "zod";

/**
 * The property document is the contract between every phase of the pipeline:
 * the editor writes it, the tour viewer reads it, and the Python depth/splat
 * steps only ever add optional fields. Keeping the phases decoupled depends on
 * nothing outside this file knowing the on-disk shape.
 *
 * Coordinates. The hand-drawn floor plan is the canonical metric world frame.
 * Plan-space is 2D [x, y] in metres on the floor plane; the viewer lifts it to
 * three.js Y-up via `planToWorld`. Everything else — camera nodes, splats —
 * registers into that frame, which is what lets a Phase 3 splat drop straight
 * into a scene built in Phase 1.
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
 * One photo, posed inside the plan. `depth` and `parallaxBudget` are written by
 * the Phase 0/2 depth pass; when `depth` is null the renderer falls back to a
 * flat billboard, which is why a tour still works before any GPU has run.
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
  depth: z.string().nullable().default(null),
  /**
   * How far the camera may drift from the node before the 2.5D shell's tearing
   * at depth discontinuities becomes visible. Derived from depth-map quality by
   * the Phase 2 pass; the small value is the entire trick that sells the effect.
   */
  parallaxBudget: z.number().nonnegative().default(0.35),
  neighbors: z.array(z.string()).default([]),
});
export type TourNode = z.infer<typeof TourNode>;

/** Phase 3 only. A trained splat, plus the transform that lands it in plan-space. */
export const SplatRef = z.object({
  url: z.string().min(1),
  transform: z.array(z.number()).length(16),
});
export type SplatRef = z.infer<typeof SplatRef>;

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

export const Property = z.object({
  id: z.string().min(1),
  label: z.string().default(""),
  /** Canonical unit is always metres; this only controls display formatting. */
  displayUnits: z.enum(["ft", "m"]).default("ft"),
  plan: Plan,
  nodes: z.array(TourNode).default([]),
  splats: z.array(SplatRef).default([]),
  /** Per-room condition, keyed by room id then by element. */
  condition: z.record(z.string(), z.record(z.string(), Grade)).default({}),
  /** Roof, systems and exterior - things belonging to no single room. */
  houseCondition: z.record(z.string(), Grade).default({}),
  /** Rate-card overrides, keyed by rate id. Absent means the default. */
  rates: z.record(z.string(), z.number()).default({}),
});
export type Property = z.infer<typeof Property>;

export function parseProperty(raw: unknown): Property {
  return Property.parse(raw);
}
