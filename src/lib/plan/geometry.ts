import type { Opening, Plan, Room, Vec2 } from "@/lib/schema";

/**
 * Plan-space is 2D metres on the floor plane. three.js is Y-up, so the plan's
 * `y` becomes world `z` and the height goes into world `y`. Every conversion
 * between the two frames goes through here so the mapping is stated once.
 */
export function planToWorld(p: Vec2, height = 0): [number, number, number] {
  return [p[0], height, p[1]];
}

/** Heading is compass-style: 0 points along +y in plan-space, growing clockwise. */
export function headingToPlanDir(headingDeg: number): Vec2 {
  const r = (headingDeg * Math.PI) / 180;
  return [Math.sin(r), Math.cos(r)];
}

export function planDirToHeading(d: Vec2): number {
  return ((Math.atan2(d[0], d[1]) * 180) / Math.PI + 360) % 360;
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return [a[0] - b[0], a[1] - b[1]];
}

export function len(a: Vec2): number {
  return Math.hypot(a[0], a[1]);
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function lerp2(a: Vec2, b: Vec2, t: number): Vec2 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Signed area; positive means counter-clockwise winding in plan-space. */
export function signedArea(poly: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

export function area(poly: Vec2[]): number {
  return Math.abs(signedArea(poly));
}

export function centroid(poly: Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const cross = p[0] * q[1] - q[0] * p[1];
    a += cross;
    x += (p[0] + q[0]) * cross;
    y += (p[1] + q[1]) * cross;
  }
  a /= 2;
  // A degenerate (zero-area) polygon has no meaningful centroid; fall back to
  // the vertex average so the editor still has somewhere to hang a label.
  if (Math.abs(a) < 1e-9) {
    const n = poly.length;
    return [
      poly.reduce((s, p) => s + p[0], 0) / n,
      poly.reduce((s, p) => s + p[1], 0) / n,
    ];
  }
  return [x / (6 * a), y / (6 * a)];
}

export function pointInPolygon(pt: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersects =
      yi > pt[1] !== yj > pt[1] &&
      pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi || 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export type Segment = { a: Vec2; b: Vec2 };

/** Where `p` falls along segment a→b, as a 0..1 parameter, plus its distance. */
export function projectOnSegment(
  p: Vec2,
  a: Vec2,
  b: Vec2,
): { t: number; distance: number } {
  const ab = sub(b, a);
  const l2 = ab[0] * ab[0] + ab[1] * ab[1];
  if (l2 < 1e-12) return { t: 0, distance: dist(p, a) };
  const ap = sub(p, a);
  const t = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1]) / l2));
  return { t, distance: dist(p, lerp2(a, b, t)) };
}

const OPENING_SNAP_M = 0.25;

/**
 * Wall segments for one room with doorways removed.
 *
 * Openings are stored as a point plus a width rather than as an edge reference,
 * because in the editor the user drops a door roughly on a wall rather than
 * picking one. So each edge asks which openings land on it (within a snap
 * tolerance) and subtracts their spans, which also handles the shared-wall case
 * where one doorway punches through two rooms' polygons at once.
 */
export function wallSegmentsForRoom(room: Room, openings: Opening[]): Segment[] {
  const relevant = openings.filter((o) => o.between.includes(room.id));
  const out: Segment[] = [];

  for (let i = 0; i < room.polygon.length; i++) {
    const a = room.polygon[i];
    const b = room.polygon[(i + 1) % room.polygon.length];
    const edgeLen = dist(a, b);
    if (edgeLen < 1e-6) continue;

    // Collect the [start, end] spans this edge loses to doorways, in 0..1.
    const holes: Array<[number, number]> = [];
    for (const o of relevant) {
      const { t, distance } = projectOnSegment(o.at, a, b);
      if (distance > OPENING_SNAP_M) continue;
      const half = o.width / 2 / edgeLen;
      const start = Math.max(0, t - half);
      const end = Math.min(1, t + half);
      if (end > start) holes.push([start, end]);
    }

    if (holes.length === 0) {
      out.push({ a, b });
      continue;
    }

    // Merge overlapping doorways, then emit whatever wall is left between them.
    holes.sort((p, q) => p[0] - q[0]);
    const merged: Array<[number, number]> = [holes[0]];
    for (const h of holes.slice(1)) {
      const last = merged[merged.length - 1];
      if (h[0] <= last[1]) last[1] = Math.max(last[1], h[1]);
      else merged.push(h);
    }

    let cursor = 0;
    for (const [start, end] of merged) {
      if (start - cursor > 1e-4) {
        out.push({ a: lerp2(a, b, cursor), b: lerp2(a, b, start) });
      }
      cursor = end;
    }
    if (1 - cursor > 1e-4) {
      out.push({ a: lerp2(a, b, cursor), b });
    }
  }

  return out;
}

/**
 * Which rooms connect to which, via doorways. This is the backbone of the walk
 * graph: a viewer may only step between nodes whose rooms are adjacent (or the
 * same), which stops the tour from teleporting through a wall.
 */
export function roomAdjacency(plan: Plan): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const r of plan.rooms) adj.set(r.id, new Set());
  for (const o of plan.openings) {
    const [x, y] = o.between;
    adj.get(x)?.add(y);
    adj.get(y)?.add(x);
  }
  return adj;
}

export function roomById(plan: Plan, id: string): Room | undefined {
  return plan.rooms.find((r) => r.id === id);
}

/** Plan bounds in metres, for framing the camera and fitting the editor canvas. */
export function planBounds(plan: Plan): { min: Vec2; max: Vec2 } {
  const pts = plan.rooms.flatMap((r) => r.polygon);
  if (pts.length === 0) return { min: [0, 0], max: [1, 1] };
  return {
    min: [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))],
    max: [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))],
  };
}

/** Slab thickness between storeys. Cosmetic, but a stack with no gap reads as
 *  one very tall room rather than as two floors. */
export const SLAB_M = 0.35;

/**
 * Height of a storey's floor above the ground floor.
 *
 * Every storey uses the tallest ceiling on the storeys below it, so a room with
 * a high ceiling pushes the floor above it up rather than poking through it.
 */
export function levelBase(plan: Plan, level: number): number {
  if (level === 0) return 0;

  const heightOf = (l: number) => {
    const rooms = plan.rooms.filter((r) => r.level === l);
    const tallest = rooms.reduce((max, r) => Math.max(max, r.ceilingHeight), 0);
    return (tallest || 2.7) + SLAB_M;
  };

  let base = 0;
  if (level > 0) {
    for (let l = 0; l < level; l++) base += heightOf(l);
  } else {
    for (let l = -1; l >= level; l--) base -= heightOf(l);
  }
  return base;
}

/** The storeys this plan actually uses, lowest first. */
export function levelsOf(plan: Plan): number[] {
  return [...new Set(plan.rooms.map((r) => r.level))].sort((a, b) => a - b);
}

export function levelName(level: number): string {
  if (level === 0) return "Ground floor";
  if (level === 1) return "Upstairs";
  if (level === -1) return "Basement";
  return level > 0 ? `Floor ${level + 1}` : `Basement ${Math.abs(level)}`;
}

/**
 * Floor height under a node, from the storey of the room it stands in.
 *
 * Nodes store a 2D position and an eye height, deliberately: a viewpoint's
 * storey is a property of its room, not of the photo, so moving a room upstairs
 * takes its photos with it and cannot leave them floating on the old floor.
 */
export function nodeBaseY(plan: Plan, node: { roomId: string }): number {
  const room = plan.rooms.find((r) => r.id === node.roomId);
  return room ? levelBase(plan, room.level) : 0;
}
