import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { cleanPolygon, triangles } from "@/lib/model/tessellate";
import { signedArea } from "@/lib/plan/geometry";
import type { Vec2 } from "@/lib/schema";

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
 * A floor slab in the shape of the room it is under.
 *
 * `boxGeometry` is right for a rectangular room and there is no box that is
 * right for any other kind, which is why floors have gone through `decompose`
 * until now - and why a room at any angle came back as a coarse staircase that
 * did not cover it. This builds the slab from the polygon itself: a top face
 * from the triangulation, a bottom face from the same triangles wound the other
 * way, and a quad down each boundary edge so the slab has sides when you stand
 * beside it in the dollhouse.
 *
 * Normals are computed rather than authored, and UVs are left to
 * `applyWorldUvs`, which derives them from world position and face direction -
 * so a tiled floor lines up across pieces regardless of how they were cut.
 */
export function slabGeometry(
  polygon: Vec2[],
  topY: number,
  thickness: number,
): THREE.BufferGeometry | null {
  const tris = triangles(polygon);
  if (tris.length === 0) return null;

  const bottomY = topY - thickness;
  const positions: number[] = [];

  const push = (x: number, y: number, z: number) => positions.push(x, y, z);

  for (const [a, b, c] of tris) {
    // Top, wound so the face looks up.
    push(a[0], topY, a[1]);
    push(c[0], topY, c[1]);
    push(b[0], topY, b[1]);
    // Bottom, wound the other way so it looks down.
    push(a[0], bottomY, a[1]);
    push(b[0], bottomY, b[1]);
    push(c[0], bottomY, c[1]);
  }

  // The sides come from the outline rather than from the triangles, so the
  // interior edges the triangulation invented do not get walls of their own.
  const ring = cleanPolygon(polygon);
  const wound = signedArea(ring) >= 0 ? ring : [...ring].reverse();
  for (let i = 0; i < wound.length; i++) {
    const a = wound[i];
    const b = wound[(i + 1) % wound.length];
    push(a[0], topY, a[1]);
    push(a[0], bottomY, a[1]);
    push(b[0], topY, b[1]);

    push(b[0], topY, b[1]);
    push(a[0], bottomY, a[1]);
    push(b[0], bottomY, b[1]);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
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
  /** The fillet's radius. Furniture asks for more than joinery: a sofa arm is not a worktop edge. */
  bevel = BEVEL_M,
): THREE.BufferGeometry {
  // A fillet cannot be more than half the thinnest dimension, or the box
  // inverts. Thin parts - a worktop, a tread, a pillow - simply get a smaller
  // one, which is also what a real thin edge looks like.
  const radius = Math.min(bevel, Math.min(size[0], size[1], size[2]) * 0.3);
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

/**
 * The shapes a garden is made of, in the same idiom as the box.
 *
 * A trunk is a cylinder, a canopy is a sphere or a cone, and at the scale a
 * lot is looked at that is a tree. Low segment counts on purpose: a read can
 * plant eight of them, and they merge into one mesh per colour.
 */
export function cylinderGeometry(
  center: [number, number, number],
  radius: number,
  height: number,
  segments = 10,
): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(radius, radius * 1.15, height, segments);
  geometry.translate(center[0], center[1], center[2]);
  return geometry;
}

export function coneGeometry(
  center: [number, number, number],
  radius: number,
  height: number,
  segments = 8,
): THREE.BufferGeometry {
  const geometry = new THREE.ConeGeometry(radius, height, segments);
  geometry.translate(center[0], center[1], center[2]);
  return geometry;
}

export function sphereGeometry(center: [number, number, number], radius: number, detail = 1): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(radius, detail);
  geometry.translate(center[0], center[1], center[2]);
  return geometry;
}
