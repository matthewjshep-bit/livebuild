import * as THREE from "three";

import { boxGeometry } from "@/lib/model/solids";
import type { Vec2 } from "@/lib/schema";

/**
 * What is painted on a road: a broken centre line. A strip of asphalt with
 * a kerb each side is a path; the dashes down the middle are what make it a
 * street, and from the kerb they are the most visible thing on it.
 *
 * Pure: a way in plan metres becomes dash boxes along it, three metres of
 * paint and six of gap, laid a hair above the surface so they do not fight
 * it for the same plane. Tested by counting.
 */

export const DASH_M = 3;
export const GAP_M = 6;
export const DASH_WIDTH = 0.12;

export function centreDashes(way: Vec2[], y: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  // Distance along the whole way, so the pattern runs through the vertices
  // rather than restarting at each one.
  let carried = 0;
  for (let i = 0; i + 1 < way.length; i++) {
    const [ax, az] = way[i];
    const [bx, bz] = way[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-6) continue;
    const ux = (bx - ax) / len;
    const uz = (bz - az) / len;
    const angle = -Math.atan2(uz, ux);
    let s = carried;
    while (s < len) {
      const from = Math.max(0, s);
      const to = Math.min(len, s + DASH_M);
      if (to - from > 0.3) {
        const mid = (from + to) / 2;
        out.push(boxGeometry([ax + ux * mid, y, az + uz * mid], [to - from, 0.004, DASH_WIDTH], angle));
      }
      s += DASH_M + GAP_M;
    }
    carried = s - len;
  }
  return out;
}
