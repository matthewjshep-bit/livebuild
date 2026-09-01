import { autoOpenings, rectangle, typicalSize } from "@/lib/plan/autolayout";
import { isStairs, roomKind } from "@/lib/plan/room-kind";
import type { Opening, Room, Vec2 } from "@/lib/schema";
import { M_PER_FT } from "@/lib/units";

/** The garden, the deck, the yard - a place, but not a room in the building. */
const isOutside = (label: string) => roomKind(label) === "outside";

/**
 * Turn a real building outline into something rooms can be packed into.
 *
 * Every generated house so far has been a rectangle, because shelf packing had
 * nothing better to aim at. A footprint from OpenStreetMap is the actual shape
 * of the building - and shape is the thing that decides whether a plan reads as
 * *this* house rather than a house.
 *
 * The data is real, which means it is messy. A house traced from county GIS
 * comes back with twenty-five vertices describing what a person would call an
 * L: bay windows, porch steps, a chimney breast, and a degree or two of
 * rotation because the street is not aligned to north. Almost all of the work
 * here is getting from that to a handful of rectangles.
 */

/** Metres per degree of latitude. Close enough anywhere outside the poles. */
const M_PER_DEG_LAT = 111_320;

/**
 * Project lat/lon onto a local metric plane.
 *
 * A house spans tens of metres, so a plate-carrée projection about its own
 * centre is exact to well under a millimetre - anything more elaborate would be
 * precision theatre.
 */
export function toLocalMetres(ring: Array<[number, number]>): Vec2[] {
  const lat0 = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const lon0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const scaleLon = Math.cos((lat0 * Math.PI) / 180) * M_PER_DEG_LAT;

  return ring.map(
    ([lat, lon]) => [(lon - lon0) * scaleLon, -(lat - lat0) * M_PER_DEG_LAT] as Vec2,
  );
}

/**
 * The angle the building is built on.
 *
 * Found by total edge length per direction rather than by longest single edge:
 * a bay window can easily be the longest edge on a wall it sits at an angle to,
 * and one misleading edge would rotate the whole house.
 */
export function dominantAngle(points: Vec2[]): number {
  const buckets = new Map<number, number>();

  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 0.4) continue;

    // Walls come in perpendicular pairs, so directions fold into 0-90 degrees.
    let angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    angle = ((angle % 90) + 90) % 90;
    const bucket = Math.round(angle);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + length);
  }

  let best = 0;
  let bestLength = -1;
  for (const [bucket, length] of buckets) {
    if (length > bestLength) {
      bestLength = length;
      best = bucket;
    }
  }
  return best;
}

export function rotate(points: Vec2[], degrees: number): Vec2[] {
  const r = (-degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return points.map(([x, y]) => [x * cos - y * sin, x * sin + y * cos] as Vec2);
}

/**
 * Drop vertices that do not change the shape, within a tolerance.
 *
 * Douglas-Peucker, run before snapping. Snapping alone barely helped: a bay
 * window traced with eight vertices snaps to eight slightly different vertices,
 * and the outline stays as complicated as it started. Simplifying first removes
 * the bay entirely, which is the right call at the scale a floor plan works -
 * a room cannot be a bay window.
 */
export function simplify(points: Vec2[], tolerance = 1.0): Vec2[] {
  if (points.length < 4) return points;

  const perpendicular = (p: Vec2, a: Vec2, b: Vec2): number => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  };

  const keep = (from: number, to: number, marked: boolean[]) => {
    if (to <= from + 1) return;
    let worst = -1;
    let worstDistance = tolerance;
    for (let i = from + 1; i < to; i++) {
      const d = perpendicular(points[i], points[from], points[to]);
      if (d > worstDistance) {
        worstDistance = d;
        worst = i;
      }
    }
    if (worst < 0) return;
    marked[worst] = true;
    keep(from, worst, marked);
    keep(worst, to, marked);
  };

  const marked = points.map((_, i) => i === 0 || i === points.length - 1);
  keep(0, points.length - 1, marked);
  return points.filter((_, i) => marked[i]);
}

/**
 * Snap an outline to a grid, collapsing detail no room can express.
 *
 * A porch step and a chimney breast are real, and at the scale a floor plan
 * works they are noise: a room cannot be six inches wide. Snapping to two feet
 * turns twenty-five vertices into the six that describe the L everyone would
 * actually draw.
 */
export function snapToGrid(points: Vec2[], grid = 2 * M_PER_FT): Vec2[] {
  const snapped = points.map(
    ([x, y]) => [Math.round(x / grid) * grid, Math.round(y / grid) * grid] as Vec2,
  );

  const out: Vec2[] = [];
  for (const point of snapped) {
    const last = out[out.length - 1];
    if (last && last[0] === point[0] && last[1] === point[1]) continue;
    out.push(point);
  }
  // Drop a duplicated closing vertex.
  if (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) out.pop();
  }
  return out;
}

export type Rect = { x0: number; y0: number; x1: number; y1: number };

export function rectArea(r: Rect): number {
  return (r.x1 - r.x0) * (r.y1 - r.y0);
}

function pointInside(poly: Vec2[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Cut a rectilinear outline into axis-aligned rectangles.
 *
 * A sweep rather than anything cleverer: every vertex contributes a grid line,
 * each resulting cell is kept if its centre lies inside the outline, and
 * neighbouring kept cells are merged back into runs. For the shapes houses
 * actually are - a rectangle, an L, a T, a U - this yields the two or three
 * rectangles a person would have drawn, and it cannot produce a rectangle that
 * sticks out of the building.
 */
export function decompose(poly: Vec2[]): Rect[] {
  if (poly.length < 3) return [];

  const xs = [...new Set(poly.map((p) => p[0]))].sort((a, b) => a - b);
  const ys = [...new Set(poly.map((p) => p[1]))].sort((a, b) => a - b);
  if (xs.length < 2 || ys.length < 2) return [];

  // Which cells of the grid are inside the building.
  const inside: boolean[][] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    inside[i] = [];
    for (let j = 0; j < ys.length - 1; j++) {
      inside[i][j] = pointInside(poly, (xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2);
    }
  }

  // Merge horizontally, then merge identical runs vertically, so a plain
  // rectangle comes back as one rectangle rather than a grid of cells.
  const used: boolean[][] = inside.map((col) => col.map(() => false));
  const rects: Rect[] = [];

  for (let j = 0; j < ys.length - 1; j++) {
    for (let i = 0; i < xs.length - 1; i++) {
      if (!inside[i][j] || used[i][j]) continue;

      let iEnd = i;
      while (iEnd + 1 < xs.length - 1 && inside[iEnd + 1][j] && !used[iEnd + 1][j]) iEnd++;

      let jEnd = j;
      outer: while (jEnd + 1 < ys.length - 1) {
        for (let k = i; k <= iEnd; k++) {
          if (!inside[k][jEnd + 1] || used[k][jEnd + 1]) break outer;
        }
        jEnd++;
      }

      for (let k = i; k <= iEnd; k++) {
        for (let m = j; m <= jEnd; m++) used[k][m] = true;
      }

      rects.push({ x0: xs[i], y0: ys[j], x1: xs[iEnd + 1], y1: ys[jEnd + 1] });
    }
  }

  return rects;
}

export type Footprint = {
  /** Simplified, axis-aligned outline in metres, origin at its own corner. */
  outline: Vec2[];
  /** The outline cut into packable rectangles. */
  rects: Rect[];
  areaSqft: number;
  /** How far the building was rotated to square it up, in degrees. */
  rotationDeg: number;
  /**
   * How a point on the map becomes a point on this plan.
   *
   * Every number here is already computed while squaring the building up and
   * was, until now, thrown away - which is why nothing could put the satellite
   * image behind the drawing. The plan is the outline projected about its own
   * centroid, rotated straight, moved to its own corner and sometimes scaled to
   * the listing's area, and three of those four steps went unrecorded.
   *
   * Optional, because a footprint restored from a document written before this
   * existed has none. A missing frame means no backdrop - a plainer drawing
   * surface, not a broken one.
   */
  frame?: {
    /** The centroid the projection was taken about. */
    centre: { lat: number; lon: number };
    rotationDeg: number;
    /** The corner the outline was moved to zero from, in rotated metres. */
    offset: Vec2;
    /** The listing-area nudge, or 1 when none was applied. */
    scale: number;
  };
  /** Vertices before and after simplification, so the reduction is visible. */
  vertices: { raw: number; simplified: number };
};

/**
 * Rectangles too small to hold anything.
 *
 * A sweep over a real outline produces slivers - an eight-square-foot offcut
 * where a porch met a wall. They are not rooms and never will be, and leaving
 * them in means the packer tries to put a bedroom in a cupboard.
 */
const MIN_RECT_SQFT = 25;

/** Rectangles the outline would decompose into, for the adaptive pass. */
function countRects(outline: Vec2[]): number {
  return decompose(outline).filter((r) => rectArea(r) / (M_PER_FT * M_PER_FT) >= MIN_RECT_SQFT)
    .length;
}

/** Shoelace area of a closed ring. */
function polygonArea(poly: Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum) / 2;
}

/**
 * How many storeys the building has, from the two areas we already know.
 *
 * Zillow does not reliably report this - on a real lookup `resoFacts` carried
 * no storey field at all - and it matters more than it sounds. The outline is
 * the *ground floor*, so scaling it to a two-storey house's total living area
 * stretches the building by about 40% in each direction and produces a house
 * far bigger than the one on the street.
 *
 * The listing's floor area and the map's footprint area are independent
 * measurements of the same building, and their ratio is roughly the number of
 * floors. That is a better answer than a field that is usually absent, and it
 * degrades honestly: a ratio near one means a bungalow, and anything ambiguous
 * lands on the smaller count, which errs towards leaving the outline alone.
 */
export function inferStoreys(livingSqft: number, footprintSqft: number): number {
  if (!(livingSqft > 100) || !(footprintSqft > 100)) return 1;
  const ratio = livingSqft / footprintSqft;
  if (ratio >= 2.4) return 3;
  if (ratio >= 1.45) return 2;
  return 1;
}

/**
 * A raw OSM ring in, a packable footprint out.
 *
 * Scaling to a known living area is the last step and deliberately optional:
 * the outline is the ground floor of the building, so a two-storey house has
 * roughly twice the living area of its footprint. Passing the *ground floor*
 * area is what keeps the two consistent.
 */
export function prepareFootprint(
  ring: Array<[number, number]>,
  targetGroundSqft?: number,
  roomCount?: number,
  /**
   * Where the ring came from, which decides whether it may be resized at all.
   *
   * A traced ring is **not scaled**, and that is the whole point of the
   * distinction. It was measured in an aerial photograph's own pixels, so it is
   * registered to that photograph - and it is now drawn on top of it while
   * somebody lays rooms out against the roof they can see. Shrinking it to
   * agree with a number breaks the one property it has: a house whose outline
   * floats inside its own roof is obviously wrong to look at, and being
   * obviously wrong is worse than being slightly large.
   *
   * It would also be shrinking towards the wrong figure. A listing's square
   * footage is *living area*: measured to the inside of the walls, excluding
   * the garage, excluding the eaves. A roof legitimately covers appreciably
   * more ground than that, so making the two equal does not correct an error,
   * it introduces one.
   */
  trust: "measured" | "traced" = "measured",
): Footprint {
  const centre = {
    lat: ring.reduce((sum, p) => sum + p[0], 0) / ring.length,
    lon: ring.reduce((sum, p) => sum + p[1], 0) / ring.length,
  };
  const local = toLocalMetres(ring);
  const angle = dominantAngle(local);
  const squared = rotate(local, angle);

  // How much outline detail to keep depends on how many rooms have to fill it.
  //
  // Each wing of the building ends up holding at least one room, so an outline
  // cut into more pieces than the house has rooms to spare forces a room to
  // fill a whole wing on its own - which is how a six-room house ended up with
  // a 529-square-foot kitchen next to a 66-square-foot dining room. Coarsening
  // the outline until it has fewer wings than the house has rooms costs a bay
  // or a bump-out and keeps the rooms believable, which is the trade this app
  // has taken everywhere else.
  //
  // The finest outline that meets the limit wins, so detail is given up only
  // as far as it has to be - a coarser house than necessary throws away the
  // shape that made the footprint worth fetching.
  const tolerances = [0.9, 1.2, 1.5, 2.0, 2.5, 3.0];
  const maxRects = roomCount && roomCount > 0 ? Math.max(1, Math.floor(roomCount / 1.5)) : Infinity;

  let outline = snapToGrid(simplify(squared, tolerances[0]));
  for (const tolerance of tolerances) {
    const candidate = snapToGrid(simplify(squared, tolerance));
    outline = candidate;
    if (countRects(candidate) <= maxRects) break;
  }

  // Move the origin to the outline's own corner, so a plan built from it starts
  // at zero like every other plan in the app.
  const xs = outline.map((p) => p[0]);
  const ys = outline.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  outline = outline.map(([x, y]) => [x - minX, y - minY] as Vec2);

  let scale = 1;
  // A traced outline keeps the size it was traced at, so it stays registered to
  // the photograph it came from and to the one it will be drawn on.
  if (trust !== "traced" && targetGroundSqft && targetGroundSqft > 100) {
    const current = polygonArea(outline) / (M_PER_FT * M_PER_FT);
    if (current > 50) {
      const factor = Math.sqrt(targetGroundSqft / current);
      // Only nudge. A factor far from one means the footprint and the listing
      // disagree about which building this is, and trusting either blindly
      // would produce a house that matches neither.
      if (factor > 0.6 && factor < 1.7) {
        outline = outline.map(([x, y]) => [x * factor, y * factor] as Vec2);
        scale = factor;
      }
    }
  }

  // Largest first, and published that way.
  //
  // The packer wants them in this order and used to sort a copy for itself,
  // which quietly made `footprint.rects[i]` and the packer's own `i` two
  // different rectangles. Nothing depended on that yet; anything handed an
  // assignment indexed against the published array would have put the living
  // room in the sliver, with no error and a plausible-looking house.
  const rects = decompose(outline)
    .filter((r) => rectArea(r) / (M_PER_FT * M_PER_FT) >= MIN_RECT_SQFT)
    .sort((a, b) => rectArea(b) - rectArea(a));

  return {
    outline,
    rects,
    areaSqft: polygonArea(outline) / (M_PER_FT * M_PER_FT),
    rotationDeg: angle,
    frame: { centre, rotationDeg: angle, offset: [minX, minY], scale },
    vertices: { raw: ring.length, simplified: outline.length },
  };
}

/**
 * The narrowest a room is allowed to be, about seven feet.
 *
 * Filling the outline exactly can otherwise produce a bedroom two metres deep,
 * which is worse than a slightly wrong shape: a room nobody could sleep in
 * reads as a broken model, whereas a room a foot off reads as a floor plan.
 */
const MIN_ROOM_DIM = 2.1;

/**
 * Split a span proportionally, but never below a workable minimum.
 *
 * Sizing rooms by area is what keeps their proportions honest, and on its own
 * it will happily make a bathroom a 3'9" strip when it shares a deep row with a
 * living room. Rooms below the minimum are pinned to it and the shortfall is
 * taken from the rooms that have space to give, so the span still adds up
 * exactly - which it must, or a gap opens inside the house.
 */
function distribute(total: number, weights: number[], minimum: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const sizes = weights.map((w) => (sum > 0 ? (w / sum) * total : total / weights.length));

  // Not enough space to give everyone the minimum: share equally and let the
  // caller's capacity check be the thing that stopped this happening.
  if (minimum * weights.length > total) return weights.map(() => total / weights.length);

  for (let pass = 0; pass < 4; pass++) {
    const short = sizes.map((size) => Math.max(0, minimum - size));
    const deficit = short.reduce((a, b) => a + b, 0);
    if (deficit < 1e-9) break;

    const spare = sizes.map((size) => Math.max(0, size - minimum));
    const spareTotal = spare.reduce((a, b) => a + b, 0);
    if (spareTotal < 1e-9) break;

    for (let i = 0; i < sizes.length; i++) {
      sizes[i] = short[i] > 0 ? minimum : sizes[i] - (spare[i] / spareTotal) * deficit;
    }
  }
  return sizes;
}

/** How many rooms a rectangle can hold before they stop being rooms. */
function capacityOf(rect: Rect): number {
  const cols = Math.max(1, Math.floor((rect.x1 - rect.x0) / MIN_ROOM_DIM));
  const rows = Math.max(1, Math.floor((rect.y1 - rect.y0) / MIN_ROOM_DIM));
  return cols * rows;
}

/**
 * Pack rooms into the building's actual shape.
 *
 * `autoLayout` packs into a square it invents, which is why every generated
 * house so far has been a rectangle. Here the shape is given, and the job
 * inverts: rooms must *fill* the outline exactly.
 *
 * Filling exactly is not a tidiness preference. Doorways are derived from which
 * rooms touch, so a gap left inside the building is a room nobody can reach -
 * and unlike a gap at the edge, it is invisible until someone walks the tour and
 * hits a dead end. Rows therefore span the full width of their rectangle and are
 * stretched to its full height, which leaves no room for a gap to appear in.
 *
 * Room proportions bend to fit, within limits. That is the right trade for this
 * app: the stated goal is that the general layout and shape are right, and the
 * shape is the part that is actually known here.
 */
/**
 * Which rooms go where, when something knows better than the packer does.
 *
 * Given as **rows**, because rows are the unit the packer actually lays out:
 * each spans the full width of its rectangle, and the rows stack to its full
 * height. That is what makes this safe to hand to anything - a description, a
 * model, a person - since *any* partition that uses every room exactly once
 * still fills the outline exactly, and filling exactly is the invariant the
 * whole file turns on.
 *
 * It is also the only lever with real reach. A room-to-rectangle assignment
 * sounds like the powerful knob and mostly is not: a plain rectangular house
 * decomposes to a single rectangle, so every room lands in the same one and the
 * entire layout is decided by how that rectangle is cut into rows.
 *
 * Indices are into `labels`. Rectangle order is `footprint.rects` as published,
 * which `prepareFootprint` now sorts so the two cannot disagree.
 */
export type PackPlan = {
  /** rows[rect][row] = room indices, left to right; rows run y0 to y1. */
  rows: number[][][];
};

/**
 * Is this partition one the packer can honour without breaking anything.
 *
 * Rejected rather than repaired, and the caller falls back to deriving its own.
 * A partition that is nearly right is not better than the heuristic: the two
 * dimension checks in particular guard `distribute`'s equal-split branch, which
 * still fills the outline but does it with rooms too narrow to stand in - and
 * `MIN_ROOM_DIM` exists because a room nobody could sleep in reads as a broken
 * model, where a room a foot out reads as a floor plan.
 */
export function validatePackPlan(
  plan: PackPlan,
  labels: string[],
  rects: Rect[],
): boolean {
  if (plan.rows.length !== rects.length) return false;

  const seen = new Set<number>();
  for (let r = 0; r < rects.length; r++) {
    const rows = plan.rows[r];
    if (!Array.isArray(rows) || rows.length === 0) return false;

    const width = rects[r].x1 - rects[r].x0;
    const height = rects[r].y1 - rects[r].y0;
    if (rows.length > Math.max(1, Math.floor(height / MIN_ROOM_DIM))) return false;

    for (const row of rows) {
      if (!Array.isArray(row) || row.length === 0) return false;
      if (row.length > Math.max(1, Math.floor(width / MIN_ROOM_DIM))) return false;
      for (const index of row) {
        if (!Number.isInteger(index) || index < 0 || index >= labels.length) return false;
        if (seen.has(index)) return false;
        seen.add(index);
      }
    }
  }

  // Every room placed, and no rectangle left empty - an empty one is a hole in
  // the middle of the house.
  return seen.size === labels.length;
}

export function packIntoFootprint(
  labels: string[],
  footprint: Footprint,
  level = 0,
  /** An externally chosen partition. Ignored unless it validates. */
  given?: PackPlan,
): Room[] {
  // Already largest first, from `prepareFootprint`, so an index here and an
  // index into `footprint.rects` mean the same rectangle.
  const rects = footprint.rects;
  if (labels.length === 0 || rects.length === 0) return [];

  const sizes = labels.map((label) => typicalSize(label));
  const wanted = sizes.map(([w, h]) => w * h);
  const available = rects.reduce((s, r) => s + rectArea(r), 0);
  const totalWanted = wanted.reduce((s, a) => s + a, 0);

  // Fill each rectangle to its share of the house, largest room first.
  //
  // The objective is that a rectangle holding a quarter of the building gets a
  // quarter of the rooms *by area*. Rooms then stretch uniformly to fill it, so
  // a house whose rooms want less space than the footprint has comes out with
  // every room slightly generous - which reads as a big house, and is true.
  //
  // Two narrower rules failed on real outlines first. Sharing by area with no
  // size check put a kitchen in a six-foot sliver. Matching each room to the
  // rectangle that best fit it put a 635-square-foot bedroom beside a
  // 127-square-foot living room, because fitting rooms one at a time says
  // nothing about what the last room in a rectangle inherits.
  const remaining = labels.map((_, i) => i).sort((a, b) => wanted[b] - wanted[a]);
  const byShare = rects
    .map((r, index) => ({ index, share: (rectArea(r) / available) * totalWanted }))
    .sort((a, b) => b.share - a.share);

  const assignment: number[][] = rects.map(() => []);

  byShare.forEach(({ index: r, share }, position) => {
    const capacity = capacityOf(rects[r]);
    // Leave one room for each rectangle still to be filled; an empty rectangle
    // is a hole in the middle of the house.
    const mustLeave = byShare.length - position - 1;
    let taken = 0;

    while (remaining.length > mustLeave && assignment[r].length < capacity) {
      const next = remaining[0];
      // Take the room if it fits the share, or if this rectangle is still
      // empty - something has to go in it either way.
      const overshoots = taken + wanted[next] > share * 1.15;
      if (overshoots && assignment[r].length > 0) break;
      assignment[r].push(next);
      taken += wanted[next];
      remaining.shift();
    }
  });

  // Anything still unplaced - every rectangle hit its capacity - goes to the
  // largest. A tight room is better than a missing one.
  while (remaining.length > 0) {
    assignment[byShare[0].index].push(remaining.shift()!);
  }

  // Every rectangle must end up with something in it. An empty one is a hole in
  // the middle of the house.
  for (let r = 0; r < rects.length; r++) {
    if (assignment[r].length > 0) continue;
    const donor = assignment.findIndex((a) => a.length > 1);
    if (donor >= 0) assignment[r].push(assignment[donor].pop()!);
  }

  const rooms: Room[] = new Array(labels.length);

  // A supplied partition replaces the derivation above and nothing else. Every
  // dimension below still comes from `distribute` and `MIN_ROOM_DIM`, so an
  // outside answer can choose the arrangement and cannot produce a gap or a
  // room too small to be one.
  const supplied = given && validatePackPlan(given, labels, rects) ? given : null;

  rects.forEach((rect, r) => {
    const indices = assignment[r].sort((a, b) => a - b);
    if (!supplied && indices.length === 0) return;

    const width = rect.x1 - rect.x0;
    const height = rect.y1 - rect.y0;

    // Choose a grid that keeps every room above the minimum dimension, then
    // shape it so rooms come out roughly square rather than as ribbons.
    const maxRows = Math.max(1, Math.floor(height / MIN_ROOM_DIM));
    const maxCols = Math.max(1, Math.floor(width / MIN_ROOM_DIM));
    const square = Math.max(1, Math.round(Math.sqrt((indices.length * height) / width)));
    // At least enough rows that no row exceeds the columns that fit, at most
    // as many as the rectangle is deep enough for.
    const finalRows = Math.max(
      1,
      Math.min(maxRows, Math.max(square, Math.ceil(indices.length / maxCols))),
    );

    // Spread rooms across the rows as evenly as the count allows.
    const rows: number[][] = Array.from({ length: finalRows }, () => []);
    indices.forEach((index, i) => {
      rows[Math.floor((i * finalRows) / indices.length)].push(index);
    });

    const filled = supplied ? supplied.rows[r] : rows.filter((rowItems) => rowItems.length > 0);

    // Share space by **area**, not by wanted width or depth.
    //
    // Rows span the full width of the rectangle, so every room in a row
    // inherits that row's depth - and sizing rooms by their wanted width then
    // handed a bathroom a bedroom's depth and made it four times too big. Since
    // depth is common within a row, a width proportional to wanted area gives
    // each room exactly its share, and a row height proportional to the area
    // its rooms wanted does the same between rows. Every room in the rectangle
    // then comes out scaled by the same factor, which is what makes a large
    // house read as a large house rather than as one enormous bathroom.
    const rowWants = filled.map((items) => items.reduce((sum, i) => sum + wanted[i], 0));
    const rowHeights = distribute(height, rowWants, MIN_ROOM_DIM);

    let y = rect.y0;
    filled.forEach((items, rowIndex) => {
      const isLastRow = rowIndex === filled.length - 1;
      const rowHeight = isLastRow ? rect.y1 - y : rowHeights[rowIndex];

      const widths = distribute(width, items.map((i) => wanted[i]), MIN_ROOM_DIM);

      let x = rect.x0;
      items.forEach((index, itemIndex) => {
        const isLastItem = itemIndex === items.length - 1;
        const roomWidth = isLastItem ? rect.x1 - x : widths[itemIndex];
        rooms[index] = {
          id: `r${index + 1}`,
          label: labels[index],
          polygon: rectangle(x, y, roomWidth, rowHeight),
          ceilingHeight: 2.7,
          level,
        };
        x += roomWidth;
      });
      y += rowHeight;
    });
  });

  // A label can be left unplaced only if a rectangle was dropped as a sliver.
  return rooms.filter(Boolean);
}

/**
 * Lay out a whole house inside its real outline.
 *
 * The counterpart to `layoutFromSpec`, which packs each storey into a square it
 * invents. Here every storey is packed into the same building outline, because
 * that is what a storey is: a two-storey house has one footprint, and stacking
 * a different shape upstairs would produce a building that could not stand.
 *
 * A shared outline is not enough to line the stairwells up, which is worth
 * stating because it looks as though it should be. Each storey has a different
 * room list, so the packing puts the stairs wherever that storey's ordering
 * lands them - the first two-storey test came back with them three metres
 * apart, which is two buildings rather than one house. Upper storeys therefore
 * swap the stairwell into the slot above the one below it. Swapping two rooms
 * on the same storey rather than moving anything keeps the outline exactly
 * filled, which sliding a whole storey would not.
 */
export function layoutFromFootprint(
  spec: { rooms: Array<{ label: string; level: number }> },
  footprint: Footprint,
  adjacency?: Array<[string, string]>,
  /**
   * An arrangement chosen elsewhere, per storey.
   *
   * Indices are into the labels of that storey **in the order this function
   * receives them**, which is why supplying one also turns off the reordering
   * below. Reordering first and then applying indices from before the reorder
   * puts rooms in the wrong rectangles with nothing to show for it - no error,
   * no warning, just a house that is subtly not the one that was designed.
   */
  plans?: Map<number, PackPlan>,
): { rooms: Room[]; openings: Opening[] } {
  const levels = [...new Set(spec.rooms.map((r) => r.level))].sort((a, b) => a - b);
  const all: Room[] = [];
  let counter = 1;

  for (const level of levels) {
    const onLevel = spec.rooms.filter((r) => r.level === level);
    // The garden is not a room in the building.
    //
    // Exterior photographs get classified as "Outside" and became a room like
    // any other, so a house with nine of them handed 700 square feet of its own
    // floor to the yard. Every other consumer already knows better - it is
    // excluded from living area, from windows, from lamps, from where a walker
    // starts and from the scripted tour. Only the packer treated it as inside.
    const labels = onLevel.filter((r) => !isOutside(r.label)).map((r) => r.label);
    const outsides = onLevel.filter((r) => isOutside(r.label)).map((r) => r.label);

    if (labels.length > 0) {
      const given = plans?.get(level);
      // Photographed connections order the rooms; the footprint decides where
      // they go. Both signals are weak on their own and neither overrides the
      // other - the arrangement pass only chooses which room comes first.
      //
      // Skipped entirely when an arrangement was supplied, because that
      // arrangement was chosen against this exact list and reordering it would
      // silently invalidate every index in it.
      const ordered = given ? labels : orderForAdjacency(labels, adjacency ?? []);
      const laid = packIntoFootprint(ordered, footprint, level, given).map((room) => ({
        ...room,
        id: `r${counter++}`,
      }));
      all.push(...laid);
    }

    for (const label of outsides) {
      all.push({ ...outsideRoom(footprint, label, level), id: `r${counter++}` });
    }
  }

  alignStairwells(all, levels);
  return { rooms: all, openings: autoOpenings(all) };
}

/**
 * Somewhere to stand outside the house.
 *
 * A record still has to exist even though it is not a room: a viewpoint must
 * belong to one, floor heights are looked up through it, and the exterior
 * grading finds its photographs precisely by asking which room is the outside.
 * Deleting it would strand every exterior shot and quietly switch that grading
 * off.
 *
 * So it is placed against the building rather than inside it. Touching, not
 * detached - `autoOpenings` derives a doorway from rooms that share a wall, and
 * a garden nobody can walk into is an orphan the walk graph will complain
 * about.
 */
function outsideRoom(footprint: Footprint, label: string, level: number): Room {
  const xs = footprint.outline.map((p) => p[0]);
  const ys = footprint.outline.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y1 = Math.max(...ys);
  const depth = Math.max((y1 - Math.min(...ys)) * 0.4, 4);

  return {
    id: "outside",
    label,
    polygon: rectangle(x0, y1, x1 - x0, depth),
    ceilingHeight: 2.7,
    level,
  };
}

/**
 * Put every storey's stairwell above the one below it.
 *
 * Stairs are how storeys connect at all - `autoStairs` derives the link from
 * two stairwells *overlapping* on adjacent levels - so a misplaced one leaves a
 * floor nobody can reach. The swap is by label between two rooms of the same
 * storey, so no geometry moves and the outline stays exactly filled.
 *
 * Overlap is maximised directly rather than approximated by putting the
 * stairwells near each other. Choosing the nearest slot was the first attempt
 * and it left one two-storey house in five with no way upstairs: two rooms can
 * have close centres and barely touch when the storeys were divided into rows
 * differently. Both storeys are searched, since the best pair of slots is often
 * not the one the ground floor happened to pick.
 */
function alignStairwells(rooms: Room[], levels: number[]): void {
  const boundsFor = (room: Room) => {
    const xs = room.polygon.map((p) => p[0]);
    const ys = room.polygon.map((p) => p[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  };

  const overlapOf = (a: Room, b: Room): number => {
    const p = boundsFor(a);
    const q = boundsFor(b);
    return (
      Math.max(0, Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0)) *
      Math.max(0, Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0))
    );
  };

  const swapLabels = (a: Room, b: Room) => {
    if (a === b) return;
    const label = a.label;
    a.label = b.label;
    b.label = label;
  };

  const ground = rooms.filter((r) => r.level === 0);
  let anchor = ground.find((r) => isStairs(r.label));
  if (!anchor) return;

  for (const level of levels) {
    if (level === 0) continue;
    const onLevel = rooms.filter((r) => r.level === level);
    const stairs = onLevel.find((r) => isStairs(r.label));
    if (!stairs) continue;

    // The pair of slots - one per storey - that share the most floor. The
    // ground floor is only re-searched for the first upper storey, so a third
    // storey aligns to where the stairwell already is rather than moving it.
    const groundOptions = level === 1 ? ground : [anchor];

    let bestGround = anchor;
    let bestUpper = stairs;
    let bestOverlap = -1;
    for (const g of groundOptions) {
      for (const u of onLevel) {
        const overlap = overlapOf(g, u);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestGround = g;
          bestUpper = u;
        }
      }
    }

    swapLabels(anchor, bestGround);
    // Swapping on the ground floor may have moved the anchor's room, so the
    // stairwell is wherever the label now is.
    anchor = ground.find((r) => isStairs(r.label)) ?? anchor;
    swapLabels(stairs, bestUpper);
  }
}

/**
 * Put rooms observed to connect next to each other in the packing order.
 *
 * Rooms are placed in order, so neighbours in the list tend to become
 * neighbours in the house. This is a nudge rather than a solver: the footprint
 * has already fixed the shape, and reordering can only decide which room lands
 * in which part of it.
 */
function orderForAdjacency(labels: string[], adjacency: Array<[string, string]>): string[] {
  if (adjacency.length === 0) return labels;

  const linked = new Map<string, string[]>(labels.map((l) => [l, []]));
  for (const [a, b] of adjacency) {
    if (linked.has(a) && linked.has(b)) {
      linked.get(a)!.push(b);
      linked.get(b)!.push(a);
    }
  }

  // Breadth-first from the most-connected room, so the open-plan core of the
  // house is laid down first and the rooms hanging off it follow.
  const start = [...labels].sort(
    (a, b) => (linked.get(b)?.length ?? 0) - (linked.get(a)?.length ?? 0),
  )[0];

  const seen = new Set<string>([start]);
  const out = [start];
  const queue = [start];
  while (queue.length > 0) {
    for (const next of linked.get(queue.shift()!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      out.push(next);
      queue.push(next);
    }
  }
  for (const label of labels) if (!seen.has(label)) out.push(label);
  return out;
}
