import { autoOpenings, typicalSize } from "@/lib/plan/autolayout";
import type { Opening, Room, Vec2 } from "@/lib/schema";
import { M_PER_FT, sqftToM2 } from "@/lib/units";

/**
 * Turn a hand-drawn floor plan into a real one.
 *
 * Dragging rectangles into the right arrangement is the most tedious part of
 * the builder, and it is tedious for a reason no amount of UI polish fixes:
 * the arrangement already exists in the user's head, and the mouse is a poor
 * way to get it out. A sketch carries it directly.
 *
 * The model returns rooms as rectangles on an arbitrary grid. Everything here
 * is about turning that rough reading into something the rest of the app can
 * use - which mostly means making walls that were meant to be shared actually
 * be shared.
 */

export type SketchRoom = {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  level: number;
  /** A dimension written on the drawing, if there was one. */
  writtenFeet?: { width?: number | null; height?: number | null } | null;
};

export type SketchReading = {
  rooms: SketchRoom[];
  gridWidth: number;
  gridHeight: number;
  notes: string[];
};

/**
 * Edges within this fraction of the drawing's size were meant to be the same
 * wall. Generous, because a line drawn freehand on a notepad wanders by more
 * than people expect - and two rooms an inch apart on paper is a shared wall,
 * not a gap.
 */
const SNAP_FRACTION = 0.035;

/**
 * Pull nearly-equal coordinates onto a single value.
 *
 * One-dimensional clustering, run separately on the vertical and horizontal
 * edges. Without it, a sketch produces rooms that *almost* touch - and since
 * doorways are derived from adjacency, almost-touching means a plan full of
 * rooms nobody can walk between.
 */
function snapAxis(values: number[], tolerance: number): Map<number, number> {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const snapped = new Map<number, number>();

  let cluster: number[] = [];
  const flush = () => {
    if (cluster.length === 0) return;
    const mean = cluster.reduce((s, v) => s + v, 0) / cluster.length;
    for (const value of cluster) snapped.set(value, mean);
    cluster = [];
  };

  for (const value of sorted) {
    if (cluster.length > 0 && value - cluster[cluster.length - 1] > tolerance) flush();
    cluster.push(value);
  }
  flush();

  return snapped;
}

function alignEdges(rooms: SketchRoom[], gridWidth: number, gridHeight: number): SketchRoom[] {
  // Levels are aligned independently: an upstairs wall has no reason to line up
  // with a ground-floor one, and forcing it would distort both.
  const levels = [...new Set(rooms.map((r) => r.level))];
  const out: SketchRoom[] = [];

  for (const level of levels) {
    const onLevel = rooms.filter((r) => r.level === level);
    const xTolerance = gridWidth * SNAP_FRACTION;
    const yTolerance = gridHeight * SNAP_FRACTION;

    const xs = snapAxis(onLevel.flatMap((r) => [r.x, r.x + r.width]), xTolerance);
    const ys = snapAxis(onLevel.flatMap((r) => [r.y, r.y + r.height]), yTolerance);

    for (const room of onLevel) {
      const x0 = xs.get(room.x) ?? room.x;
      const x1 = xs.get(room.x + room.width) ?? room.x + room.width;
      const y0 = ys.get(room.y) ?? room.y;
      const y1 = ys.get(room.y + room.height) ?? room.y + room.height;
      out.push({
        ...room,
        x: Math.min(x0, x1),
        y: Math.min(y0, y1),
        // A room snapped to nothing is better than a room snapped to zero size.
        width: Math.max(Math.abs(x1 - x0), gridWidth * 0.02),
        height: Math.max(Math.abs(y1 - y0), gridHeight * 0.02),
      });
    }
  }

  return out;
}

/**
 * Work out how many metres one grid unit is worth.
 *
 * Three sources, in order of how much they should be trusted: a dimension the
 * user actually wrote on the drawing, a listing's square footage, and failing
 * both, an assumption that the whole drawing is a typical house. The last is a
 * guess, but a plan at roughly the right size is far easier to correct than one
 * at an arbitrary one.
 */
function metresPerUnit(
  rooms: SketchRoom[],
  gridWidth: number,
  gridHeight: number,
  livingAreaSqft?: number,
): number {
  /**
   * Prefer areas over single edges, and combine every room that carries a
   * dimension.
   *
   * A sketch is not to scale. A room written "16x14" is routinely drawn with a
   * quite different aspect, so scaling from its width alone leaves the room the
   * right width and the wrong size - the fixture came out 182 sqft against a
   * written 224. Matching total written area against total drawn area puts the
   * error where it belongs, in the shape rather than the size, and averaging
   * across rooms stops one sloppy rectangle setting the scale for the house.
   */
  const withBoth = rooms.filter(
    (r) => (r.writtenFeet?.width ?? 0) > 2 && (r.writtenFeet?.height ?? 0) > 2,
  );
  if (withBoth.length > 0) {
    const writtenM2 = withBoth.reduce(
      (sum, r) => sum + r.writtenFeet!.width! * r.writtenFeet!.height! * M_PER_FT * M_PER_FT,
      0,
    );
    const drawn = withBoth.reduce((sum, r) => sum + r.width * r.height, 0);
    if (drawn > 0 && writtenM2 > 0) return Math.sqrt(writtenM2 / drawn);
  }

  // Only one edge written: all that can be done is match that edge.
  const single = rooms.find(
    (r) => (r.writtenFeet?.width ?? 0) > 2 || (r.writtenFeet?.height ?? 0) > 2,
  );
  if (single) {
    const feet = single.writtenFeet!.width ?? single.writtenFeet!.height ?? 0;
    const units = single.writtenFeet!.width ? single.width : single.height;
    if (feet > 2 && units > 0) return (feet * M_PER_FT) / units;
  }

  if (livingAreaSqft && livingAreaSqft > 100) {
    const drawnArea = rooms.reduce((sum, r) => sum + r.width * r.height, 0);
    if (drawnArea > 0) return Math.sqrt(sqftToM2(livingAreaSqft) / drawnArea);
  }

  // Nothing to go on: treat the drawing's longer side as a typical frontage.
  const longest = Math.max(gridWidth, gridHeight, 1);
  return (14 * M_PER_FT) / (longest / 3);
}

/**
 * Which column and row band each room spans.
 *
 * Once edges are clustered, the drawing is a grid: every distinct edge is a
 * boundary, and each room covers a rectangular block of cells. That structure -
 * what sits beside what, and what lines up with what - is the real content of a
 * sketch. The dimensions are not; they are whatever the hand happened to do.
 */
type Span = { room: SketchRoom; c0: number; c1: number; r0: number; r1: number };

function toGrid(rooms: SketchRoom[]): { xs: number[]; ys: number[]; spans: Span[] } {
  const near = (values: number[], v: number) =>
    values.reduce((best, c, i) => (Math.abs(c - v) < Math.abs(values[best] - v) ? i : best), 0);

  const xs = [...new Set(rooms.flatMap((r) => [r.x, r.x + r.width]))].sort((a, b) => a - b);
  const ys = [...new Set(rooms.flatMap((r) => [r.y, r.y + r.height]))].sort((a, b) => a - b);

  const spans = rooms.map((room) => ({
    room,
    c0: near(xs, room.x),
    c1: near(xs, room.x + room.width),
    r0: near(ys, room.y),
    r1: near(ys, room.y + room.height),
  }));

  return { xs, ys, spans };
}

/** Final dimensions land on multiples of this, so walls read as deliberate. */
const ROUND_TO_M = M_PER_FT / 2;

/** A written dimension outranks a typical one by this much when they disagree. */
const WRITTEN_WEIGHT = 10;
const TYPICAL_WEIGHT = 1;

const SOLVER_PASSES = 400;
const MIN_BAND_M = 0.9;

/**
 * Re-solve the dimensions, keeping the arrangement.
 *
 * A sketch is drawn by hand, so its proportions are noise: a bathroom comes out
 * bigger than a bedroom because that is where the pen happened to stop. Tracing
 * those faithfully produces a house nobody would build.
 *
 * So the grid structure is kept exactly - every adjacency, every alignment - and
 * the column widths and row heights are solved for afresh, pulling each room
 * toward a plausible size for what it is. Anything written on the drawing is
 * treated as near-fixed; everything else is a preference.
 *
 * Solved by relaxation rather than a matrix: each pass nudges every band toward
 * satisfying the rooms that span it, which converges quickly and, unlike a least
 * squares solve, cannot return a negative wall.
 */
function solveBands(
  xs: number[],
  ys: number[],
  spans: Span[],
  scale: number,
): { widths: number[]; heights: number[] } {
  const widths = xs.slice(0, -1).map((x, i) => Math.max((xs[i + 1] - x) * scale, MIN_BAND_M));
  const heights = ys.slice(0, -1).map((y, i) => Math.max((ys[i + 1] - y) * scale, MIN_BAND_M));

  const targets = spans.map((span) => {
    const [typicalW, typicalH] = typicalSize(span.room.label);
    const writtenW = (span.room.writtenFeet?.width ?? 0) > 2
      ? span.room.writtenFeet!.width! * M_PER_FT
      : null;
    const writtenH = (span.room.writtenFeet?.height ?? 0) > 2
      ? span.room.writtenFeet!.height! * M_PER_FT
      : null;

    // A room drawn wider than tall probably is wider than tall, even if the
    // typical figures for its type are the other way round.
    const drawnLandscape = span.room.width >= span.room.height;
    const typicalLong = Math.max(typicalW, typicalH);
    const typicalShort = Math.min(typicalW, typicalH);

    return {
      span,
      width: writtenW ?? (drawnLandscape ? typicalLong : typicalShort),
      height: writtenH ?? (drawnLandscape ? typicalShort : typicalLong),
      weightW: writtenW ? WRITTEN_WEIGHT : TYPICAL_WEIGHT,
      weightH: writtenH ? WRITTEN_WEIGHT : TYPICAL_WEIGHT,
    };
  });

  const relax = (
    bands: number[],
    pick: (t: (typeof targets)[number]) => { from: number; to: number; target: number; weight: number },
  ) => {
    for (let pass = 0; pass < SOLVER_PASSES; pass++) {
      const delta = new Array(bands.length).fill(0);
      const share = new Array(bands.length).fill(0);

      for (const target of targets) {
        const { from, to, target: want, weight } = pick(target);
        if (to <= from) continue;
        let current = 0;
        for (let i = from; i < to; i++) current += bands[i];
        if (current <= 0) continue;

        const error = want - current;
        for (let i = from; i < to; i++) {
          // Split the correction in proportion to each band's share, so a wide
          // band absorbs more of it than a narrow one.
          delta[i] += error * (bands[i] / current) * weight;
          share[i] += weight;
        }
      }

      let moved = 0;
      for (let i = 0; i < bands.length; i++) {
        if (share[i] === 0) continue;
        const step = (delta[i] / share[i]) * 0.5;
        bands[i] = Math.max(MIN_BAND_M, bands[i] + step);
        moved += Math.abs(step);
      }
      if (moved < 0.001) break;
    }
    return bands.map((b) => Math.max(MIN_BAND_M, Math.round(b / ROUND_TO_M) * ROUND_TO_M));
  };

  return {
    widths: relax(widths, (t) => ({
      from: t.span.c0, to: t.span.c1, target: t.width, weight: t.weightW,
    })),
    heights: relax(heights, (t) => ({
      from: t.span.r0, to: t.span.r1, target: t.height, weight: t.weightH,
    })),
  };
}

export function sketchToPlan(
  reading: SketchReading,
  livingAreaSqft?: number,
): { rooms: Room[]; openings: Opening[]; scale: number; adjustments: string[] } {
  const gridWidth = reading.gridWidth || 100;
  const gridHeight = reading.gridHeight || 100;

  const aligned = alignEdges(reading.rooms, gridWidth, gridHeight);
  const scale = metresPerUnit(aligned, gridWidth, gridHeight, livingAreaSqft);

  // The drawing supplies the arrangement; the dimensions are solved for.
  const { xs, ys, spans } = toGrid(aligned);
  const { widths, heights } = solveBands(xs, ys, spans, scale);

  const edgeX = [0];
  for (const w of widths) edgeX.push(edgeX[edgeX.length - 1] + w);
  const edgeY = [0];
  for (const h of heights) edgeY.push(edgeY[edgeY.length - 1] + h);

  const rooms: Room[] = spans.map((span, i) => {
    const room = span.room;
    const x = edgeX[span.c0];
    const y = edgeY[span.r0];
    const w = Math.max(edgeX[span.c1] - x, MIN_BAND_M);
    const h = Math.max(edgeY[span.r1] - y, MIN_BAND_M);
    return {
      id: `s${i + 1}`,
      label: room.label || `Room ${i + 1}`,
      polygon: [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ] as Vec2[],
      ceilingHeight: 2.7,
      level: room.level ?? 0,
    };
  });

  const written = spans.filter((s) => (s.room.writtenFeet?.width ?? 0) > 2).length;
  const totalSqft = Math.round(
    rooms.reduce((sum, r) => {
      const xs = r.polygon.map((p) => p[0]);
      const ys = r.polygon.map((p) => p[1]);
      return sum + (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    }, 0) / (M_PER_FT * M_PER_FT),
  );

  const adjustments = [
    `Kept your arrangement; sized each room to something a house would actually have.`,
    written > 0
      ? `${written} written dimension${written === 1 ? "" : "s"} treated as near-fixed.`
      : `No dimensions written, so sizes came from what each room is.`,
    `Walls squared and rounded to 6in. About ${totalSqft} sqft in total.`,
  ];

  return { rooms, openings: autoOpenings(rooms), scale, adjustments };
}
