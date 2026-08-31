import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

/**
 * The three ways this model makes a solid.
 *
 * Lifted out of the renderer so the joinery and ceiling generators can use them
 * without importing a React component. Nothing about them is view-specific -
 * they are the vocabulary the whole model is built from - and having them
 * inside `Model.tsx` was only ever an accident of where the first one was
 * needed.
 */

export function boxGeometry(
  center: [number, number, number],
  size: [number, number, number],
  rotationY = 0,
): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
  if (rotationY) geometry.rotateY(rotationY);
  geometry.translate(center[0], center[1], center[2]);
  return geometry;
}

/**
 * The radius of the fillet on a made thing, in metres.
 *
 * Three millimetres, which is about what a router leaves and about what a
 * sanded edge wears to. Nothing in a house has a mathematically sharp arris
 * except a cut tile.
 */
export const BEVEL_M = 0.003;

/**
 * A box that is an *object* rather than a volume.
 *
 * Every made thing in this model was a `BoxGeometry`, and the flat shading
 * that produces is most of why furniture read as blocking-out rather than as
 * furniture. A sharp edge between two faces gives the eye a single hard
 * discontinuity; a filleted one gives it a narrow band that catches a
 * highlight, and that band is what says "this is a solid thing with a
 * surface". It is the cheapest realism in the whole model - one extra ring of
 * vertices per edge - and it applies to every piece already built.
 *
 * Not for walls, floors or ceilings. A wall's crispness comes from its
 * skirting and its casing, the bevel would never be seen at the scale a wall
 * is looked at, and the segment count over a whole storey is not free.
 */
export function solid(
  center: [number, number, number],
  size: [number, number, number],
  rotationY = 0,
): THREE.BufferGeometry {
  // A fillet cannot be more than half the thinnest dimension, or the box
  // inverts. Thin parts - a worktop, a tread, a pillow - simply get a smaller
  // one, which is also what a real thin edge looks like.
  const radius = Math.min(BEVEL_M, Math.min(size[0], size[1], size[2]) * 0.3);
  const geometry: THREE.BufferGeometry =
    radius > 0.0002
      ? new RoundedBoxGeometry(size[0], size[1], size[2], 1, radius)
      : new THREE.BoxGeometry(size[0], size[1], size[2]);
  if (rotationY) geometry.rotateY(rotationY);
  geometry.translate(center[0], center[1], center[2]);
  return geometry;
}

/** Merge a batch of boxes into one geometry, or null when there are none. */

export function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (parts.length === 0) return null;
  const result = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  return result;
}
