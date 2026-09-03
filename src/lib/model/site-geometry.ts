import * as THREE from "three";

import type { Vec2 } from "@/lib/schema";

/**
 * Roads as geometry: a ribbon along each way, and kerbs beside it.
 *
 * Flat, one quad per segment with a disc at every join so the corners do not
 * gap, all faces looking up. Nothing here is a solid: a road is a surface,
 * and the only thing anyone looks at is its top.
 */

/** A polyline as a flat strip of the given width at height `y`. */
export function ribbonGeometry(way: Vec2[], width: number, y: number): THREE.BufferGeometry | null {
  if (way.length < 2) return null;
  const half = width / 2;
  const positions: number[] = [];
  const tri = (a: [number, number], b: [number, number], c: [number, number]) => {
    // Wound to look up (+y): the cross product of (b - a) x (c - a) in the
    // ground plane must point along +y, which for (x, z) means a clockwise
    // turn seen from above.
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const [p, q, r] = cross < 0 ? [a, b, c] : [a, c, b];
    positions.push(p[0], y, p[1], q[0], y, q[1], r[0], y, r[1]);
  };
  for (let i = 1; i < way.length; i++) {
    const a = way[i - 1];
    const b = way[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const nx = (-dy / len) * half;
    const ny = (dx / len) * half;
    const a0: [number, number] = [a[0] + nx, a[1] + ny];
    const a1: [number, number] = [a[0] - nx, a[1] - ny];
    const b0: [number, number] = [b[0] + nx, b[1] + ny];
    const b1: [number, number] = [b[0] - nx, b[1] - ny];
    tri(a0, b0, b1);
    tri(a0, b1, a1);
    // A disc at the join, so a bend shows no wedge of lawn.
    if (i < way.length - 1) {
      const segments = 12;
      for (let k = 0; k < segments; k++) {
        const t0 = (k / segments) * Math.PI * 2;
        const t1 = ((k + 1) / segments) * Math.PI * 2;
        tri(
          [b[0], b[1]],
          [b[0] + Math.cos(t0) * half, b[1] + Math.sin(t0) * half],
          [b[0] + Math.cos(t1) * half, b[1] + Math.sin(t1) * half],
        );
      }
    }
  }
  if (positions.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** A polyline moved sideways by `offset` metres, to its left for positive. */
export function offsetWay(way: Vec2[], offset: number): Vec2[] {
  if (way.length < 2) return way;
  return way.map((p, i) => {
    const prev = way[Math.max(0, i - 1)];
    const next = way[Math.min(way.length - 1, i + 1)];
    const dx = next[0] - prev[0];
    const dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    return [p[0] + (-dy / len) * offset, p[1] + (dx / len) * offset] as Vec2;
  });
}

/** Two kerb strips, one along each edge of a road of the given width. */
export function kerbGeometry(way: Vec2[], width: number, y: number, kerbWidth = 0.3): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (const sign of [1, -1]) {
    const edge = offsetWay(way, sign * (width / 2 + kerbWidth / 2));
    const strip = ribbonGeometry(edge, kerbWidth, y);
    if (strip) out.push(strip);
  }
  return out;
}
