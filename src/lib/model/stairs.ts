import type { Box, Piece } from "@/lib/model/furniture";
import { FURNITURE_COLOURS } from "@/lib/model/materials";
import { boundsOf } from "@/lib/plan/autolayout";
import { levelBase, levelsOf } from "@/lib/plan/geometry";
import { isStairs } from "@/lib/plan/room-kind";
import type { Plan, Room, Vec2 } from "@/lib/schema";

/**
 * Staircases, as geometry rather than as a coloured rectangle.
 *
 * A Stairs room used to be a flat slab with a linear ramp underneath it for the
 * walker, which is to say the model showed a floor where a staircase was and
 * quietly let you slide up it. This builds the real thing.
 *
 * **There is exactly one array of walking surfaces**, and the 3D boxes, the
 * height the walker's feet land on, and the 2D plan symbol are all views of it.
 * Nothing re-derives a tread position. That is the same rule the bill of
 * materials follows by sharing `wallSegmentsForRoom` with the renderer, and for
 * the same reason: a second description drifts from the first, and the drift
 * here is invisible - the stair looks right and you sink through it.
 */

/* ------------------------------------------------------------ ergonomics */

/** Tighter of the IRC's 7¾" and Part K's 220mm. */
export const RISER_MAX = 0.19;
/** The IRC's 10" tread, rounded down. */
export const GOING_MIN = 0.25;
/** The comfort rule every stair is judged by: twice the riser plus the going. */
export const SUM_MIN = 0.6;
export const SUM_MAX = 0.64;
export const PITCH_MAX_DEG = 42;
export const FLIGHT_WIDTH_MIN = 0.8;
export const FLIGHT_WIDTH_MAX = 1.0;
export const LANDING_MIN = 0.8;
/** Half an interior wall, so a flight does not grow out of the plaster. */
export const WALL_INSET = 0.05;
/** The conventional height a plan is cut at, and where a stair is broken. */
export const PLAN_CUT = 1.2;
/** The largest height change a walker may take in one step. */
export const MAX_STEP = 0.22;

export type StairKind = "straight" | "switchback" | "ramp";

export type Rect = { x0: number; y0: number; x1: number; y1: number };

export type StairSpec = {
  kind: StairKind;
  rise: number;
  risers: number;
  riser: number;
  going: number;
  pitchDeg: number;
  flightWidth: number;
  landingDepth: number;
  /** Exposed so a test can assert the comfort rule directly. */
  twoRPlusG: number;
  /** False when the footprint forced a dimension out of band. */
  compliant: boolean;
  warnings: string[];
};

/** One horizontal walking surface. The atom of this module. */
export type Step = {
  rect: Rect;
  /** Absolute world height of the surface you stand on. */
  top: number;
  role: "apron" | "tread" | "landing" | "ramp";
  /** Which flight, for the 2D symbol. -1 for an apron or a landing. */
  flight: 0 | 1 | -1;
};

export type StairRun = {
  id: string;
  lowerRoomId: string;
  upperRoomId: string;
  lowerLevel: number;
  baseY: number;
  topY: number;
  spec: StairSpec;
  /** Everything the staircase occupies, inside both rooms. */
  footprint: Rect;
  /** The hole through the floor above and the ceiling below. */
  well: Rect;
  /** Every walking surface, lowest first. Their union is the footprint. */
  steps: Step[];
  entry: { at: Vec2; into: Vec2 };
  arrival: { at: Vec2; into: Vec2 };
};

/* ------------------------------------------------------------- rectangles */

function intersect(a: Rect, b: Rect): Rect | null {
  const r = {
    x0: Math.max(a.x0, b.x0),
    y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
  };
  return r.x1 > r.x0 && r.y1 > r.y0 ? r : null;
}

const rectOf = (room: Room): Rect => boundsOf(room.polygon);

/**
 * `outer` minus `holes`, as axis-aligned rectangles.
 *
 * With no holes it returns exactly `[outer]`, so every room in the house that
 * has no stairwell in it produces byte-identical geometry to before.
 */
export function subtractRects(outer: Rect, holes: Rect[]): Rect[] {
  let pieces = [outer];
  for (const hole of holes) {
    const next: Rect[] = [];
    for (const piece of pieces) {
      const cut = intersect(piece, hole);
      if (!cut) {
        next.push(piece);
        continue;
      }
      // Up to four bands around the hole: below, above, left, right.
      if (cut.y0 > piece.y0) next.push({ ...piece, y1: cut.y0 });
      if (cut.y1 < piece.y1) next.push({ ...piece, y0: cut.y1 });
      if (cut.x0 > piece.x0) next.push({ x0: piece.x0, x1: cut.x0, y0: cut.y0, y1: cut.y1 });
      if (cut.x1 < piece.x1) next.push({ x0: cut.x1, x1: piece.x1, y0: cut.y0, y1: cut.y1 });
    }
    pieces = next;
  }
  // Anything narrower than a wall is not worth drawing.
  return pieces.filter((r) => r.x1 - r.x0 > 0.02 && r.y1 - r.y0 > 0.02);
}

/* ------------------------------------------------------------------- fit */

function derive(rise: number) {
  const risers = Math.max(1, Math.ceil(rise / RISER_MAX));
  const riser = rise / risers;
  return {
    risers,
    riser,
    goingLo: Math.max(GOING_MIN, SUM_MIN - 2 * riser),
    goingHi: SUM_MAX - 2 * riser,
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Work out what staircase fits the footprint it has been given.
 *
 * Straight whenever it fits, because it has fewer parts and its well takes less
 * of the floor above. It rarely fits: 3.05m of rise needs seventeen risers, and
 * sixteen goings at the 250mm minimum is four metres of run. A generated
 * stairwell is about three, so the answer is nearly always a half-turn.
 */
export function fitStair(rise: number, area: Rect): {
  spec: StairSpec;
  steps: Step[];
  footprint: Rect;
  well: Rect;
  entry: StairRun["entry"];
  arrival: StairRun["arrival"];
} {
  const w = area.x1 - area.x0;
  const h = area.y1 - area.y0;
  const alongX = w >= h;
  const long = alongX ? w : h;
  const short = alongX ? h : w;

  const d = derive(rise);
  const warnings: string[] = [];

  const straightRun = (d.risers - 1) * d.goingLo;
  const canStraight = long >= straightRun && short >= FLIGHT_WIDTH_MIN + 2 * WALL_INSET;
  const canSwitch =
    short >= 2 * FLIGHT_WIDTH_MIN + 2 * WALL_INSET &&
    long >= LANDING_MIN + (Math.ceil(d.risers / 2) - 1) * d.goingLo;

  const kind: StairKind = canStraight ? "straight" : canSwitch ? "switchback" : "ramp";

  // Run-local coordinates: u along the long axis, v across it. Converted back
  // to plan at the end, so the layout maths never has to think about which way
  // the room is turned.
  const toPlan = (u: number, v: number): Vec2 =>
    alongX ? [area.x0 + u, area.y0 + v] : [area.x0 + v, area.y0 + u];
  const rect = (u0: number, u1: number, v0: number, v1: number): Rect => {
    const a = toPlan(u0, v0);
    const b = toPlan(u1, v1);
    return {
      x0: Math.min(a[0], b[0]),
      y0: Math.min(a[1], b[1]),
      x1: Math.max(a[0], b[0]),
      y1: Math.max(a[1], b[1]),
    };
  };

  const steps: Step[] = [];
  let going = d.goingLo;
  let flightWidth = short - 2 * WALL_INSET;
  let landingDepth = 0;

  if (kind === "ramp") {
    warnings.push(
      `A stairwell of ${long.toFixed(1)} x ${short.toFixed(1)}m is too small for a staircase. ` +
        `It needs about ${(LANDING_MIN + (Math.ceil(d.risers / 2) - 1) * d.goingLo).toFixed(1)} x ` +
        `${(2 * FLIGHT_WIDTH_MIN + 2 * WALL_INSET).toFixed(1)}m for a half-turn.`,
    );
    steps.push({ rect: rect(0, long, 0, short), top: NaN, role: "ramp", flight: -1 });
  } else if (kind === "straight") {
    flightWidth = clamp(short - 2 * WALL_INSET, FLIGHT_WIDTH_MIN, FLIGHT_WIDTH_MAX);
    going = clamp(long / (d.risers - 1), d.goingLo, d.goingHi);
    const v0 = (short - flightWidth) / 2;
    // Walking up in +u: the apron is the floor you start from, then a tread per
    // riser, and the last riser steps you off the top onto the storey above.
    steps.push({ rect: rect(0, going, v0, v0 + flightWidth), top: 0, role: "apron", flight: 0 });
    for (let k = 1; k < d.risers; k++) {
      steps.push({
        rect: rect(k * going, (k + 1) * going, v0, v0 + flightWidth),
        top: k * d.riser,
        role: "tread",
        flight: 0,
      });
    }
  } else {
    flightWidth = clamp((short - 2 * WALL_INSET) / 2, FLIGHT_WIDTH_MIN, FLIGHT_WIDTH_MAX);
    landingDepth = Math.max(flightWidth, LANDING_MIN);
    const upper = Math.ceil(d.risers / 2);
    const lower = d.risers - upper;
    going = clamp((long - landingDepth) / Math.max(1, upper - 1), d.goingLo, d.goingHi);

    const laneA = WALL_INSET;
    const laneB = short - WALL_INSET - flightWidth;

    // Flight 0 climbs in +u along lane A, starting from an apron at floor level.
    steps.push({ rect: rect(0, going, laneA, laneA + flightWidth), top: 0, role: "apron", flight: 0 });
    for (let k = 1; k <= lower - 1; k++) {
      steps.push({
        rect: rect(k * going, (k + 1) * going, laneA, laneA + flightWidth),
        top: k * d.riser,
        role: "tread",
        flight: 0,
      });
    }

    // The half-landing spans both lanes at the far end.
    steps.push({
      rect: rect(long - landingDepth, long, WALL_INSET, short - WALL_INSET),
      top: lower * d.riser,
      role: "landing",
      flight: -1,
    });

    // Flight 1 comes back in -u along lane B, and its last riser steps off the
    // near edge onto the floor above.
    for (let k = 1; k <= upper - 1; k++) {
      const u1 = long - landingDepth - (k - 1) * going;
      steps.push({
        rect: rect(Math.max(0, u1 - going), u1, laneB, laneB + flightWidth),
        top: (lower + k) * d.riser,
        role: "tread",
        flight: 1,
      });
    }
  }

  const pitchDeg = (Math.atan2(d.riser, going) * 180) / Math.PI;
  const twoRPlusG = 2 * d.riser + going;
  const compliant =
    kind !== "ramp" &&
    d.riser <= RISER_MAX + 1e-9 &&
    going >= GOING_MIN - 1e-9 &&
    twoRPlusG >= SUM_MIN - 1e-6 &&
    twoRPlusG <= SUM_MAX + 1e-6 &&
    pitchDeg <= PITCH_MAX_DEG + 1e-6 &&
    flightWidth >= FLIGHT_WIDTH_MIN - 1e-9;

  if (kind !== "ramp" && !compliant) {
    warnings.push(
      `The staircase is outside comfortable limits: ${(d.riser * 1000).toFixed(0)}mm riser, ` +
        `${(going * 1000).toFixed(0)}mm going, ${pitchDeg.toFixed(0)} degrees.`,
    );
  }

  const entryAt = toPlan(going / 2, kind === "switchback" ? WALL_INSET + flightWidth / 2 : short / 2);
  const arrivalAt = toPlan(
    0,
    kind === "switchback" ? short - WALL_INSET - flightWidth / 2 : short / 2,
  );
  const along: Vec2 = alongX ? [1, 0] : [0, 1];

  return {
    spec: {
      kind,
      rise,
      risers: d.risers,
      riser: d.riser,
      going,
      pitchDeg,
      flightWidth,
      landingDepth,
      twoRPlusG,
      compliant,
      warnings,
    },
    steps,
    footprint: { ...area },
    // The whole overlap is the well: a closed-well half-turn occupies all of it,
    // and a straight flight still needs headroom over its full length.
    well: { ...area },
    entry: { at: entryAt, into: along },
    arrival: { at: arrivalAt, into: [-along[0], -along[1]] },
  };
}

/* ------------------------------------------------------------------- runs */

/**
 * Every staircase in the plan.
 *
 * Derived from the `kind: "stairs"` openings `autoStairs` already emits, so a
 * staircase exists exactly where the plan says two stairwells stack.
 */
export function stairRuns(plan: Plan): StairRun[] {
  const byId = new Map(plan.rooms.map((r) => [r.id, r]));
  const runs: StairRun[] = [];

  for (const opening of plan.openings) {
    if (opening.kind !== "stairs") continue;
    const a = byId.get(opening.between[0]);
    const b = byId.get(opening.between[1]);
    if (!a || !b || !isStairs(a.label) || !isStairs(b.label)) continue;

    const lower = a.level < b.level ? a : b;
    const upper = a.level < b.level ? b : a;
    if (upper.level - lower.level !== 1) continue;

    // Built inside the overlap, never inside one room alone - so the upper room
    // keeps its floor everywhere the stair does not reach.
    const area = intersect(rectOf(lower), rectOf(upper));
    if (!area) continue;

    const baseY = levelBase(plan, lower.level);
    const topY = levelBase(plan, upper.level);
    const fitted = fitStair(topY - baseY, area);

    runs.push({
      id: opening.id,
      lowerRoomId: lower.id,
      upperRoomId: upper.id,
      lowerLevel: lower.level,
      baseY,
      topY,
      spec: fitted.spec,
      footprint: fitted.footprint,
      well: fitted.well,
      // Step heights are absolute once the storey's base is added.
      steps: fitted.steps.map((s) => ({ ...s, top: baseY + s.top })),
      entry: fitted.entry,
      arrival: fitted.arrival,
    });
  }
  return runs;
}

/** The runs touching a storey: one going up from it, one arriving at it. */
export function runsAtLevel(
  plan: Plan,
  level: number,
): { up: StairRun | null; down: StairRun | null } {
  const runs = stairRuns(plan);
  return {
    up: runs.find((r) => r.lowerLevel === level) ?? null,
    down: runs.find((r) => r.lowerLevel === level - 1) ?? null,
  };
}

/* --------------------------------------------------------------- the views */

const inside = (r: Rect, x: number, y: number) =>
  x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

/**
 * The height of the walking surface at a point, or null outside the run.
 *
 * This is the lookup the walker's feet use, read off the very same steps the
 * treads are drawn from.
 */
export function heightAt(run: StairRun, x: number, y: number): number | null {
  if (!inside(run.footprint, x, y)) return null;

  if (run.spec.kind === "ramp") {
    // No staircase fits, so it stays the ramp it always was - which at least
    // still climbs, and is honest about not being a stair.
    const alongX = run.footprint.x1 - run.footprint.x0 >= run.footprint.y1 - run.footprint.y0;
    const t = alongX
      ? (x - run.footprint.x0) / (run.footprint.x1 - run.footprint.x0)
      : (y - run.footprint.y0) / (run.footprint.y1 - run.footprint.y0);
    return run.baseY + (run.topY - run.baseY) * clamp(t, 0, 1);
  }

  // Highest surface underfoot: at a half-turn the two flights are side by side
  // and never overlap, so this only ever finds one - but a point in the gap
  // between them must not read as the floor.
  let best: number | null = null;
  for (const step of run.steps) {
    if (!inside(step.rect, x, y)) continue;
    if (best === null || step.top > best) best = step.top;
  }
  return best;
}

/** The storey a height belongs to - whichever floor it is nearest. */
export function levelForHeight(plan: Plan, height: number): number {
  const levels = levelsOf(plan);
  if (levels.length === 0) return 0;
  return levels.reduce(
    (best, l) =>
      Math.abs(levelBase(plan, l) - height) < Math.abs(levelBase(plan, best) - height) ? l : best,
    levels[0],
  );
}

/** Tread thickness. Thin enough to read as a tread rather than as a block. */
const TREAD = 0.06;

/**
 * Tread boxes for one room on one storey.
 *
 * Split at the conventional plan cut so that a storey draws the half of the
 * staircase that belongs to it. Both storeys therefore show stairs, nothing is
 * drawn twice, and isolating the upper floor shows the flight rising into it
 * rather than an empty hole.
 */
export function stairPieces(plan: Plan, room: Room, level: number): Piece[] {
  const runs = stairRuns(plan);
  const b = rectOf(room);
  const baseY = levelBase(plan, level);
  const pieces: Piece[] = [];

  for (const run of runs) {
    if (run.spec.kind === "ramp") continue;
    const isLower = run.lowerRoomId === room.id && run.lowerLevel === level;
    const isUpper = run.upperRoomId === room.id && run.lowerLevel + 1 === level;
    if (!isLower && !isUpper) continue;

    const cut = run.topY - PLAN_CUT;
    const boxes: Box[] = [];

    for (const step of run.steps) {
      if (step.role === "apron") continue;
      const mine = isLower ? step.top < cut : step.top >= cut;
      if (!mine) continue;

      const w = step.rect.x1 - step.rect.x0;
      const d = step.rect.y1 - step.rect.y0;
      boxes.push({
        center: [
          step.rect.x0 + w / 2 - b.x0,
          step.top - TREAD / 2 - baseY,
          step.rect.y0 + d / 2 - b.y0,
        ],
        size: [w, TREAD, d],
        colour: step.role === "landing" ? FURNITURE_COLOURS.timberDark : FURNITURE_COLOURS.timber,
      });
    }

    if (boxes.length > 0) pieces.push({ kind: "stair", boxes });
  }
  return pieces;
}

/* ------------------------------------------------------------ slab surgery */

/** Wells to cut out of this room's floor - the room a staircase arrives in. */
export function floorHolesFor(plan: Plan, room: Room): Rect[] {
  return stairRuns(plan)
    .filter((run) => run.upperRoomId === room.id && run.spec.kind !== "ramp")
    .map((run) => run.well);
}

/** Wells to cut out of this room's ceiling - the room a staircase leaves. */
export function ceilingHolesFor(plan: Plan, room: Room): Rect[] {
  return stairRuns(plan)
    .filter((run) => run.lowerRoomId === room.id && run.spec.kind !== "ramp")
    .map((run) => run.well);
}

/* ----------------------------------------------------------------- 2D plan */

export type StairSymbol = {
  /** One line across the flight per tread, at its leading edge. */
  treadLines: Array<[Vec2, Vec2]>;
  /** The outline of each flight and of the landing. */
  outlines: Rect[];
  /** The conventional diagonal break, where the flight passes the cut plane. */
  breakLine: [Vec2, Vec2] | null;
  /** Which way you are going, and how many risers. */
  arrow: { from: Vec2; to: Vec2; label: string };
};

/**
 * The staircase as an architect would draw it.
 *
 * Read off the same `steps` the treads are built from, so a plan that disagrees
 * with the model is not possible. Only the half of the flight below the cut
 * plane is drawn on a storey, which is the convention and is also what stops
 * the two storeys' drawings duplicating each other.
 */
export function stairSymbol(run: StairRun, level: number): StairSymbol | null {
  if (run.spec.kind === "ramp") return null;

  const isLower = run.lowerLevel === level;
  const cut = run.topY - PLAN_CUT;
  const shown = run.steps.filter((s) => (isLower ? s.top < cut : s.top >= cut));
  if (shown.length === 0) return null;

  const alongX = run.footprint.x1 - run.footprint.x0 >= run.footprint.y1 - run.footprint.y0;

  const treadLines = shown
    .filter((s) => s.role === "tread")
    .map((s): [Vec2, Vec2] =>
      alongX
        ? [
            [s.rect.x0, s.rect.y0],
            [s.rect.x0, s.rect.y1],
          ]
        : [
            [s.rect.x0, s.rect.y0],
            [s.rect.x1, s.rect.y0],
          ],
    );

  const outlines = shown.filter((s) => s.role === "landing").map((s) => s.rect);

  // The break sits where the flight is cut, drawn across the run.
  const edge = shown.reduce((best, s) => (s.top > best.top ? s : best), shown[0]);
  const breakLine: [Vec2, Vec2] = alongX
    ? [
        [edge.rect.x0 - 0.15, edge.rect.y0 - 0.1],
        [edge.rect.x1 + 0.15, edge.rect.y1 + 0.1],
      ]
    : [
        [edge.rect.x0 - 0.1, edge.rect.y0 - 0.15],
        [edge.rect.x1 + 0.1, edge.rect.y1 + 0.15],
      ];

  return {
    treadLines,
    outlines,
    breakLine,
    arrow: {
      from: isLower ? run.entry.at : run.arrival.at,
      to: isLower ? run.arrival.at : run.entry.at,
      label: `${isLower ? "UP" : "DN"} ${run.spec.risers}R`,
    },
  };
}
