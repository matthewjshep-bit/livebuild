import * as THREE from "three";

import type { Segment } from "@/lib/plan/geometry";
import type { TrimProfile } from "@/lib/spec/schema";

/**
 * Mouldings, as sections extruded along a run.
 *
 * Skirting was a rectangular box. That is the right first approximation and it
 * is most of what stops a wall meeting a floor looking like two planes
 * intersecting - but it is also, up close, obviously a box. A real moulding is
 * a profile: a shaped section, milled once and run round the room, and the
 * shape is what catches a line of light along the whole wall at grazing angles.
 * It is the same argument the 3mm fillet on furniture makes, at ten times the
 * length.
 *
 * The section is drawn once in 2D and extruded along the run's own length -
 * cheaper and far more predictable than sweeping along a path, and every run
 * here is straight because every wall is. `bevelEnabled` is off deliberately:
 * a bevel would inflate the section and double the triangles to round an edge
 * the profile has already shaped.
 *
 * Corners are mitred by extending each run by its own depth where it turns,
 * which at fifteen millimetres is invisible and avoids a real mitre solver.
 */

/**
 * The cross-section of a moulding, in the plane of the wall.
 *
 * x runs out from the wall face, y runs up from the floor. So the profile is
 * drawn as though you had sawn through the skirting and were looking at the
 * cut end, which is how a joiner would describe it too.
 */
export function profileShape(kind: TrimProfile, height: number, depth: number): THREE.Shape {
  const shape = new THREE.Shape();
  const h = height;
  const d = depth;

  switch (kind) {
    case "square":
      // A plain board. Still worth going through here rather than staying a
      // box, so that everything trim-shaped is made the same way.
      shape.moveTo(0, 0);
      shape.lineTo(d, 0);
      shape.lineTo(d, h);
      shape.lineTo(0, h);
      break;

    case "chamfer":
      // Square, with the top arris taken off at 45 degrees.
      shape.moveTo(0, 0);
      shape.lineTo(d, 0);
      shape.lineTo(d, h - d);
      shape.lineTo(0, h);
      break;

    case "ogee": {
      // The double curve: out from the wall, a hollow, a round, and back. The
      // most common moulded skirting there is, and the one whose shadow line
      // reads from across a room.
      const step = h * 0.62;
      shape.moveTo(0, 0);
      shape.lineTo(d, 0);
      shape.lineTo(d, step * 0.55);
      shape.quadraticCurveTo(d, step, d * 0.55, step);
      shape.quadraticCurveTo(d * 0.12, step, d * 0.12, h * 0.88);
      shape.lineTo(d * 0.12, h - d * 0.3);
      shape.quadraticCurveTo(d * 0.12, h, 0, h);
      break;
    }

    case "stepped": {
      // Two flat reveals. A modern square-edged skirting with a shadow gap,
      // which is what most new-build joinery actually is.
      const back = d * 0.35;
      shape.moveTo(0, 0);
      shape.lineTo(d, 0);
      shape.lineTo(d, h * 0.72);
      shape.lineTo(back, h * 0.72);
      shape.lineTo(back, h * 0.9);
      shape.lineTo(0, h * 0.9);
      break;
    }

    case "colonial": {
      // A stepped base with a rounded top - the profile in most American
      // houses built before about 1980.
      shape.moveTo(0, 0);
      shape.lineTo(d, 0);
      shape.lineTo(d, h * 0.5);
      shape.quadraticCurveTo(d * 0.95, h * 0.66, d * 0.45, h * 0.7);
      shape.lineTo(d * 0.45, h * 0.82);
      shape.quadraticCurveTo(d * 0.4, h, 0, h);
      break;
    }
  }

  shape.closePath();
  return shape;
}

/**
 * How finely a curve in the section is sampled.
 *
 * Four rather than three.js' default of twelve. A skirting section is fifteen
 * millimetres deep and the curve within it is a few millimetres, so beyond four
 * segments nothing is visible and every extra one is paid for along every metre
 * of every wall in the house.
 */
const CURVE_SEGMENTS = 4;

/**
 * One run of moulding, standing against a wall segment.
 *
 * The transform is the fiddly part and is worth spelling out, because getting
 * it subtly wrong produces skirting that is inside the plaster or lying on its
 * side - both of which look, at a glance, like the profile simply not working.
 *
 * `ExtrudeGeometry` leaves the section in the xy plane and sweeps it along +z,
 * so the raw geometry occupies x in [0, depth], y in [0, height], z in [0,
 * length]. A rotation about Y by t sends local +z to (sin t, 0, cos t) and
 * local +x to (cos t, 0, -sin t) - so choosing t = atan2(dx, dz) puts the sweep
 * along the segment, and local +x lands on the segment's right-hand normal.
 * That normal is the one direction that is not a free choice: it has to end up
 * pointing *into* the room, or the skirting grows the wrong way through the
 * wall. So it is measured rather than assumed, and the run is turned end for
 * end when it comes out backwards.
 */
export function runGeometry(
  kind: TrimProfile,
  segment: Segment,
  {
    height,
    depth,
    baseY,
    inward,
    extend = 0,
  }: {
    height: number;
    depth: number;
    /** Height of the run's bottom edge above the storey floor. */
    baseY: number;
    /** Unit vector pointing into the room, across the run. */
    inward: [number, number];
    /** Mitre allowance added at each end, to close the corners. */
    extend?: number;
  },
): THREE.BufferGeometry | null {
  const [ax, az] = segment.a;
  const [bx, bz] = segment.b;
  const dx = bx - ax;
  const dz = bz - az;
  const length = Math.hypot(dx, dz);
  if (length < 1e-4 || height <= 0 || depth <= 0) return null;

  // The right-hand normal of a->b, which is where local +x will land.
  const nx = dz / length;
  const nz = -dx / length;
  const facesInward = nx * inward[0] + nz * inward[1] > 0;

  const angle = facesInward
    ? Math.atan2(dx, dz)
    : Math.atan2(-dx, -dz);
  // Turning the run end for end means starting from the other end of it.
  const startX = facesInward ? ax : bx;
  const startZ = facesInward ? az : bz;

  const shape = profileShape(kind, height, depth);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: length + extend * 2,
    bevelEnabled: false,
    steps: 1,
    curveSegments: CURVE_SEGMENTS,
  });

  geometry.rotateY(angle);
  // Back the start off by the mitre allowance, along the run's own direction.
  const runX = Math.sin(angle);
  const runZ = Math.cos(angle);
  geometry.translate(startX - runX * extend, baseY, startZ - runZ * extend);

  return geometry;
}
