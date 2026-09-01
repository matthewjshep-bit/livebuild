import { M_PER_FT } from "@/lib/units";
import type { Opening, Plan, Room, TourNode, Vec2 } from "@/lib/schema";
import { area, centroid, planDirToHeading, signedArea } from "@/lib/plan/geometry";
import { type RoomKind, isLivingArea, isStairs, roomKind } from "@/lib/plan/room-kind";

/**
 * Building a plausible floor plan without asking anyone to draw one.
 *
 * Drawing rooms to scale on an abstract grid is the single hardest thing about
 * authoring a tour, and it is hard for a reason that has nothing to do with the
 * product: it demands you already think in floor plans. Almost nobody does.
 *
 * So the wizard never asks. It knows which rooms exist (the user tagged their
 * photos), gives each a typical size, packs them into a house-shaped rectangle,
 * and lets the user drag them until it matches their memory. Correcting a wrong
 * layout is a far easier task than producing a right one from nothing.
 */

/** Typical room dimensions in feet, by kind. Wrong in detail, right in spirit. */
const TYPICAL_SIZE_FT: Record<RoomKind, [number, number]> = {
  living: [16, 14],
  kitchen: [12, 12],
  dining: [12, 11],
  bedroom: [12, 12],
  "primary-bedroom": [14, 14],
  bathroom: [8, 7],
  powder: [5, 5],
  hallway: [16, 4],
  stairs: [7, 10],
  entry: [8, 7],
  office: [10, 10],
  laundry: [8, 6],
  garage: [20, 20],
  closet: [6, 4],
  basement: [20, 18],
  outside: [20, 16],
  other: [12, 12],
};

const DEFAULT_SIZE_FT: [number, number] = [12, 12];

/** Room names offered in the tagging step, in the order people walk a house. */
export const ROOM_PRESETS = [
  "Living Room",
  "Kitchen",
  "Dining Room",
  "Primary Bedroom",
  "Bedroom",
  "Bathroom",
  "Hallway",
  "Entry",
  "Office",
  "Laundry",
  "Stairs",
  "Closet",
  "Garage",
  "Outside",
];

/**
 * Typical dimensions for a room.
 *
 * Keyed by kind rather than by name, so every vocabulary the app deals with -
 * presets, sketch shorthand, listing wording - resolves through one place. This
 * used to do its own prefix matching, and a near-miss silently returned a
 * generic 12x12: the reason a corridor once rendered twelve feet deep.
 */
export function typicalSize(label: string): Vec2 {
  const [w, h] = TYPICAL_SIZE_FT[roomKind(label)] ?? DEFAULT_SIZE_FT;
  return [w * M_PER_FT, h * M_PER_FT];
}

export function rectangle(x: number, y: number, w: number, h: number): Vec2[] {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

export function boundsOf(polygon: Vec2[]): { x0: number; y0: number; x1: number; y1: number } {
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
}

/** Heights are stretched to fill a row, but only so far - a stretched bathroom
 *  stops looking like a bathroom. */
const MAX_STRETCH = 1.5;

/**
 * Shelf-pack rooms into a roughly square house.
 *
 * Rows are what make this work: rooms in a row touch horizontally and rows touch
 * vertically, so the result is gap-free and every room ends up adjacent to
 * something. That matters because doorways are derived from adjacency - a plan
 * with gaps would produce a tour you cannot walk.
 */
export function autoLayout(labels: string[], level = 0): Room[] {
  if (labels.length === 0) return [];

  const sizes = labels.map(typicalSize);
  const totalArea = sizes.reduce((sum, [w, h]) => sum + w * h, 0);
  const targetWidth = Math.max(Math.sqrt(totalArea) * 1.25, Math.max(...sizes.map((s) => s[0])));

  const rows: Array<{ items: Array<{ index: number; size: Vec2 }>; width: number; height: number }> = [];
  let current = { items: [] as Array<{ index: number; size: Vec2 }>, width: 0, height: 0 };

  labels.forEach((_, index) => {
    const size = sizes[index];
    if (current.items.length > 0 && current.width + size[0] > targetWidth) {
      rows.push(current);
      current = { items: [], width: 0, height: 0 };
    }
    current.items.push({ index, size });
    current.width += size[0];
    current.height = Math.max(current.height, size[1]);
  });
  if (current.items.length > 0) rows.push(current);

  const rooms: Room[] = new Array(labels.length);
  let y = 0;

  for (const row of rows) {
    let x = 0;
    for (const { index, size } of row.items) {
      const height = Math.min(row.height, size[1] * MAX_STRETCH);
      rooms[index] = {
        id: `r${index + 1}`,
        label: labels[index],
        polygon: rectangle(x, y, size[0], height),
        ceilingHeight: 2.7,
        level,
      };
      x += size[0];
    }
    y += row.height;
  }

  return repairConnectivity(rooms);
}

function overlaps(a: Room, b: Room): boolean {
  const p = boundsOf(a.polygon);
  const q = boundsOf(b.polygon);
  const slack = WALL_TOUCH_TOLERANCE_M;
  return p.x0 < q.x1 - slack && q.x0 < p.x1 - slack && p.y0 < q.y1 - slack && q.y0 < p.y1 - slack;
}

function translated(room: Room, dx: number, dy: number): Room {
  return { ...room, polygon: room.polygon.map(([x, y]) => [x + dx, y + dy] as Vec2) };
}

/** Rooms reachable from the first one, following doorways. */
function reachableFromFirst(rooms: Room[]): Set<string> {
  const adjacency = new Map<string, string[]>(rooms.map((r) => [r.id, []]));
  for (const opening of autoOpenings(rooms)) {
    adjacency.get(opening.between[0])?.push(opening.between[1]);
    adjacency.get(opening.between[1])?.push(opening.between[0]);
  }
  const seen = new Set<string>([rooms[0].id]);
  const queue = [rooms[0].id];
  while (queue.length > 0) {
    for (const next of adjacency.get(queue.shift()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * Guarantee every room is reachable from every other.
 *
 * Shelf packing does not promise this: a short room in a tall row leaves a gap
 * beneath it, and a room on the next row can end up flush against nothing. The
 * result is a plan with a room nobody can walk into - the one failure the
 * auto-layout exists to prevent, and one the user would not discover until they
 * were already inside the tour.
 *
 * Note this tests *reachability*, not merely "has a doorway". Two rooms can sit
 * against each other while the pair floats free of the rest of the house, which
 * a per-room check reports as fine and a walker experiences as a dead end.
 */
function repairConnectivity(rooms: Room[]): Room[] {
  if (rooms.length < 2) return rooms;
  const result = [...rooms];
  // Repair happens within a storey. Rooms on another floor are not reachable by
  // sliding one sideways, so pulling them into the calculation would just move
  // rooms around pointlessly.
  const level = result[0].level;
  if (result.some((r) => r.level !== level)) {
    const byLevel = new Map<number, Room[]>();
    for (const room of result) {
      const list = byLevel.get(room.level);
      if (list) list.push(room);
      else byLevel.set(room.level, [room]);
    }
    const repaired = [...byLevel.values()].flatMap((group) => repairConnectivity(group));
    return result.map((room) => repaired.find((r) => r.id === room.id) ?? room);
  }

  for (let pass = 0; pass < 8; pass++) {
    const reachable = reachableFromFirst(result);
    const stranded = result.filter((r) => !reachable.has(r.id));
    if (stranded.length === 0) break;

    for (const orphan of stranded) {
      const index = result.findIndex((r) => r.id === orphan.id);
      const b = boundsOf(orphan.polygon);
      const width = b.x1 - b.x0;
      const height = b.y1 - b.y0;

      const others = result.filter((r) => r.id !== orphan.id);
      // Attach to the main component, never to another stranded room - that
      // would just grow the detached island.
      const anchors = others.filter((r) => reachable.has(r.id));
      const pool = anchors.length > 0 ? anchors : others;
      const target = pool.reduce((best, candidate) => {
        const c = boundsOf(candidate.polygon);
        const o = boundsOf(best.polygon);
        const dc = Math.hypot((c.x0 + c.x1) / 2 - (b.x0 + b.x1) / 2, (c.y0 + c.y1) / 2 - (b.y0 + b.y1) / 2);
        const db = Math.hypot((o.x0 + o.x1) / 2 - (b.x0 + b.x1) / 2, (o.y0 + o.y1) / 2 - (b.y0 + b.y1) / 2);
        return dc < db ? candidate : best;
      });

      const t = boundsOf(target.polygon);
      // Flush against each side of the target, centred on that side so the
      // shared wall is always wide enough for a door.
      const candidates: Array<[number, number]> = [
        [t.x1 - b.x0, (t.y0 + t.y1) / 2 - height / 2 - b.y0],
        [t.x0 - width - b.x0, (t.y0 + t.y1) / 2 - height / 2 - b.y0],
        [(t.x0 + t.x1) / 2 - width / 2 - b.x0, t.y1 - b.y0],
        [(t.x0 + t.x1) / 2 - width / 2 - b.x0, t.y0 - height - b.y0],
      ];

      let best: Room | null = null;
      let bestScore = Infinity;
      for (const [dx, dy] of candidates) {
        const moved = translated(orphan, dx, dy);
        const collides = others.some((other) => overlaps(moved, other));
        // Prefer a clear side, then the smallest move.
        const score = (collides ? 1e6 : 0) + Math.hypot(dx, dy);
        if (score < bestScore) {
          bestScore = score;
          best = moved;
        }
      }
      if (best) result[index] = best;
    }
  }

  return result;
}

/**
 * Arrange rooms so the ones that actually connect end up next to each other.
 *
 * Shelf packing produces a plausible house and an arbitrary one: rooms land in
 * whatever order they were listed. That is the weakest part of the whole
 * pipeline for the thing that matters most - whether the plan reads as *this*
 * house rather than a house.
 *
 * Adjacency is the strongest available signal, and it comes free: a kitchen
 * photo showing the dining room through an opening says those two rooms touch.
 * Packing order is what determines the arrangement, so this searches over
 * orderings, scoring how many of the observed connections the resulting plan
 * actually realises.
 *
 * Hill-climbing on a permutation rather than anything cleverer: with a dozen
 * rooms the space is small, every candidate is a valid house by construction,
 * and it can stop early the moment it satisfies everything.
 */
export function arrangeForAdjacency(
  labels: string[],
  required: Array<[string, string]>,
  level = 0,
): Room[] {
  const wanted = required.filter(([a, b]) => labels.includes(a) && labels.includes(b));
  if (wanted.length === 0 || labels.length < 3) return autoLayout(labels, level);

  const score = (order: string[]): number => {
    const rooms = autoLayout(order, level);
    const byLabel = new Map(rooms.map((r) => [r.label, r.id]));
    const touching = new Set(
      autoOpenings(rooms).map((o) => [...o.between].sort().join("|")),
    );
    let met = 0;
    for (const [a, b] of wanted) {
      const ids = [byLabel.get(a), byLabel.get(b)];
      if (ids[0] && ids[1] && touching.has([ids[0], ids[1]].sort().join("|"))) met += 1;
    }
    return met;
  };

  let best = [...labels];
  let bestScore = score(best);

  // Deterministic shuffling: a layout that changes between runs on the same
  // photos would read as the tool being unsure of itself.
  let seed = labels.join("").length * 2654435761;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let attempt = 0; attempt < 240 && bestScore < wanted.length; attempt++) {
    const candidate = [...best];
    const i = Math.floor(random() * candidate.length);
    const j = Math.floor(random() * candidate.length);
    if (i === j) continue;
    [candidate[i], candidate[j]] = [candidate[j], candidate[i]];

    const candidateScore = score(candidate);
    if (candidateScore > bestScore) {
      best = candidate;
      bestScore = candidateScore;
    }
  }

  return autoLayout(best, level);
}

/** Two walls must share at least this much to fit a door. */
const MIN_SHARED_WALL_M = 0.8;
const WALL_TOUCH_TOLERANCE_M = 0.15;

/**
 * Derive doorways from which rooms touch.
 *
 * The manual alternative - click precisely on a shared wall - fails silently
 * when you miss, and a missing doorway is invisible until someone walks the
 * tour and hits a dead end. Deriving them means the plan is always walkable by
 * construction.
 *
 * Assumes axis-aligned rectangular rooms, which is what the wizard produces.
 */
/**
 * Where two rooms actually touch, edge against edge.
 *
 * This compared bounding boxes, which is exact for axis-aligned rectangles and
 * useless for anything else. Turned seven degrees, a house produced **no
 * doorways at all** - every room sealed - and turned sixty-three it produced
 * *wrong* ones, joining the bathroom to the kitchen because their boxes
 * overlapped while their walls were nowhere near each other. A false doorway is
 * worse than a missing one: it punches a hole through a wall that is standing
 * somewhere else.
 *
 * So the test is now the one it always meant: find a pair of edges that face
 * each other, lie on the same line, and overlap along it. Three conditions,
 * each of which is what a person would check by eye.
 */
export function autoOpenings(rooms: Room[]): Opening[] {
  const openings: Opening[] = [];
  let counter = 1;

  /** Every edge of a room, with the direction and outward normal it carries. */
  const edgesOf = (room: Room) => {
    const poly = room.polygon;
    const out: Array<{ a: Vec2; b: Vec2; n: Vec2; t: Vec2; length: number }> = [];
    const wound = signedArea(poly) >= 0 ? poly : [...poly].reverse();
    for (let i = 0; i < wound.length; i++) {
      const a = wound[i];
      const b = wound[(i + 1) % wound.length];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const length = Math.hypot(dx, dy);
      if (length < 1e-9) continue;
      // Outward normal of a→b on a positively wound polygon.
      out.push({ a, b, n: [dy / length, -dx / length], t: [dx / length, dy / length], length });
    }
    return out;
  };

  const dot = (u: Vec2, v: Vec2) => u[0] * v[0] + u[1] * v[1];

  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      // Rooms on different storeys can sit on top of each other without being
      // connected - that is a floor, not a doorway. Stairs handle the vertical
      // case below.
      if (rooms[i].level !== rooms[j].level) continue;

      let best: { at: Vec2; width: number; overlap: number } | null = null;

      for (const ea of edgesOf(rooms[i])) {
        for (const eb of edgesOf(rooms[j])) {
          // 1. They must face each other. Two rooms sharing a wall meet it from
          //    opposite sides, so their outward normals are opposed.
          if (dot(ea.n, eb.n) > -0.999) continue;

          // 2. They must lie on the same line, not merely be parallel. Measured
          //    as the perpendicular distance between them, which is what the
          //    old coordinate comparison was doing for the two special cases it
          //    could express.
          const gap = Math.abs(dot(ea.n, [eb.a[0] - ea.a[0], eb.a[1] - ea.a[1]]));
          if (gap > WALL_TOUCH_TOLERANCE_M) continue;

          // 3. They must overlap along that line, by enough to be a wall two
          //    rooms share rather than two rooms grazing at a corner.
          const pa0 = dot(ea.t, ea.a);
          const pa1 = dot(ea.t, ea.b);
          const pb0 = dot(ea.t, eb.a);
          const pb1 = dot(ea.t, eb.b);
          const lo = Math.max(Math.min(pa0, pa1), Math.min(pb0, pb1));
          const hi = Math.min(Math.max(pa0, pa1), Math.max(pb0, pb1));
          const overlap = hi - lo;
          if (overlap < MIN_SHARED_WALL_M) continue;

          // Placed at the middle of what they share, on the midline between the
          // two faces so the doorway sits in the wall rather than on one side.
          const mid = (lo + hi) / 2;
          const onA: Vec2 = [ea.t[0] * mid + ea.n[0] * dot(ea.n, ea.a), ea.t[1] * mid + ea.n[1] * dot(ea.n, ea.a)];
          const at: Vec2 = [onA[0] + (ea.n[0] * gap) / 2, onA[1] + (ea.n[1] * gap) / 2];

          if (!best || overlap > best.overlap) {
            best = { at, width: Math.min(0.9, overlap), overlap };
          }
        }
      }

      // One doorway per pair, through whichever wall they share most of - the
      // same rule as before, now that a pair can share more than one.
      if (best) {
        openings.push({
          id: `d${counter++}`,
          between: [rooms[i].id, rooms[j].id],
          at: best.at,
          width: best.width,
          kind: "door",
        });
      }
    }
  }

  return [...openings, ...autoStairs(rooms, counter)];
}

const STAIR_MIN_OVERLAP_M2 = 1.0;

/**
 * Join storeys wherever stairwells sit on top of each other.
 *
 * The rule is deliberately physical rather than a UI concept: put a Stairs room
 * in roughly the same spot on two floors and they connect, because that is
 * where a real staircase would be. Nobody has to discover a "link floors"
 * command, and the plan stays the only source of truth.
 */
function autoStairs(rooms: Room[], startCounter: number): Opening[] {
  const stairs = rooms.filter((r) => isStairs(r.label));
  const openings: Opening[] = [];
  let counter = startCounter;

  for (let i = 0; i < stairs.length; i++) {
    for (let j = i + 1; j < stairs.length; j++) {
      if (Math.abs(stairs[i].level - stairs[j].level) !== 1) continue;

      const a = boundsOf(stairs[i].polygon);
      const b = boundsOf(stairs[j].polygon);
      const overlapX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const overlapY = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (overlapX <= 0 || overlapY <= 0) continue;
      if (overlapX * overlapY < STAIR_MIN_OVERLAP_M2) continue;

      openings.push({
        id: `s${counter++}`,
        between: [stairs[i].id, stairs[j].id],
        at: [
          (Math.max(a.x0, b.x0) + Math.min(a.x1, b.x1)) / 2,
          (Math.max(a.y0, b.y0) + Math.min(a.y1, b.y1)) / 2,
        ],
        width: 1.0,
        kind: "stairs",
      });
    }
  }

  return openings;
}

/**
 * Stand each photo in a corner, facing across the room.
 *
 * This is not a guess so much as a description of how listing photos are taken:
 * back into a corner and shoot the long diagonal, because that is the only way
 * to get a whole room into one frame. Defaulting to it means nobody has to
 * think about camera headings at all, and when it is wrong it is wrong by a
 * nudge rather than by a hundred and eighty degrees.
 */
export function placeNodesInRoom(
  room: Room,
  photos: Array<{ id: string; photo: string; depth?: string | null }>,
  /**
   * Spots already occupied in this room, so a later addition does not stand a
   * new camera exactly on top of an existing one. Empty on a first build, which
   * is every call this had until photographs could be added to a finished
   * house.
   */
  taken: Vec2[] = [],
): TourNode[] {
  const { x0, y0, x1, y1 } = boundsOf(room.polygon);
  const inset = Math.min((x1 - x0) / 4, (y1 - y0) / 4, 1.1);
  const center = centroid(room.polygon);

  // Corners first, then edge midpoints - a room rarely has more than four or
  // five photos, and corners are where the real ones were shot from.
  const spots: Vec2[] = [
    [x0 + inset, y0 + inset],
    [x1 - inset, y1 - inset],
    [x1 - inset, y0 + inset],
    [x0 + inset, y1 - inset],
    [(x0 + x1) / 2, y0 + inset],
    [(x0 + x1) / 2, y1 - inset],
    [x0 + inset, (y0 + y1) / 2],
    [x1 - inset, (y0 + y1) / 2],
  ];

  // Free spots first, in order, and only then back round the list. Eight is
  // more than a room realistically has photographs of, so in practice this is
  // "carry on where the last batch stopped".
  const isTaken = (spot: Vec2) =>
    taken.some((t) => Math.hypot(t[0] - spot[0], t[1] - spot[1]) < 0.05);
  const free = spots.filter((spot) => !isTaken(spot));
  const order = free.length > 0 ? free : spots;

  return photos.map((photo, i) => {
    const position = order[i % order.length];
    return {
      id: photo.id,
      roomId: room.id,
      position,
      eyeHeight: 1.5,
      heading: planDirToHeading([center[0] - position[0], center[1] - position[1]]),
      pitch: 0,
      fovDeg: 78,
      photo: photo.photo,
      depth: photo.depth ?? null,
      parallaxBudget: 0.35,
      neighbors: [],
    };
  });
}

/**
 * Lay out a whole multi-storey house from a described room list.
 *
 * Each storey is packed independently, then the upper and lower storeys are
 * translated so their stairwells sit on the same footprint - which is exactly
 * the condition `autoStairs` looks for. Without that alignment a two-storey
 * plan would arrive with its floors unconnected, and the user would have to
 * discover the "put the stairs in the same place" rule to fix it.
 */
export function layoutFromSpec(
  spec: { rooms: Array<{ label: string; level: number }> },
  /** Finished floor area in square metres, when a listing supplies it. */
  livingAreaM2?: number,
  /** Room pairs observed to connect, from the photos. */
  adjacency?: Array<[string, string]>,
): {
  rooms: Room[];
  openings: Opening[];
} {
  const levels = [...new Set(spec.rooms.map((r) => r.level))].sort((a, b) => a - b);
  const all: Room[] = [];
  let counter = 1;

  for (const level of levels) {
    const labels = spec.rooms.filter((r) => r.level === level).map((r) => r.label);
    // Ids must be unique across the whole plan, not just within a storey.
    const laid = arrangeForAdjacency(labels, adjacency ?? [], level).map((room) => ({
      ...room,
      id: `r${counter++}`,
    }));
    all.push(...laid);
  }

  const stairsOn = (level: number) =>
    all.find((r) => r.level === level && isStairs(r.label));

  const ground = stairsOn(0) ?? all.find((r) => r.level === 0);
  if (ground) {
    const anchor = boundsOf(ground.polygon);
    for (const level of levels) {
      if (level === 0) continue;
      const stairs = stairsOn(level);
      if (!stairs) continue;
      const here = boundsOf(stairs.polygon);
      const dx = anchor.x0 - here.x0;
      const dy = anchor.y0 - here.y0;
      if (dx === 0 && dy === 0) continue;
      for (let i = 0; i < all.length; i++) {
        if (all[i].level !== level) continue;
        all[i] = translated(all[i], dx, dy);
      }
    }
  }

  const sized = livingAreaM2 ? scaleToLivingArea(all, livingAreaM2) : all;
  return { rooms: sized, openings: autoOpenings(sized) };
}

/** Scale factors outside this range mean the inputs disagree, not that the
 *  house is unusual - so the sqft is ignored rather than trusted. */
const MIN_SCALE = 0.45;
const MAX_SCALE = 2.4;

/**
 * Resize a generated plan so its finished area matches the listing.
 *
 * This is the difference between a plan that is plausible and one that is
 * true. Room sizes otherwise come from a table of typical dimensions, so a
 * 900 sqft cottage and a 3,000 sqft house generate nearly the same dollhouse -
 * and every distance inside the tour, every walk between viewpoints, is wrong
 * by the same factor.
 *
 * Uniform scaling about the origin is safe: rooms that touched still touch, so
 * every derived doorway survives untouched.
 */
export function scaleToLivingArea(rooms: Room[], targetSquareMetres: number): Room[] {
  if (!(targetSquareMetres > 1) || rooms.length === 0) return rooms;

  const living = rooms.filter((r) => isLivingArea(r.label));
  const current = living.reduce((sum, r) => sum + area(r.polygon), 0);
  if (current < 1) return rooms;

  const factor = Math.sqrt(targetSquareMetres / current);
  if (factor < MIN_SCALE || factor > MAX_SCALE) return rooms;

  return rooms.map((room) => ({
    ...room,
    polygon: room.polygon.map(([x, y]) => [x * factor, y * factor] as Vec2),
  }));
}

/** Rebuild doorways after the user drags rooms around. */
export function withDerivedOpenings(plan: Plan): Plan {
  return { ...plan, openings: autoOpenings(plan.rooms) };
}
