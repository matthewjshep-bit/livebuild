import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import type { Vec2 } from "@/lib/schema";

/**
 * Trees and shrubs with the shape of a plant rather than of a lollipop.
 *
 * A tree was one sphere of eighty faces on a cylinder, and a conifer one
 * eight-sided cone - which at a glance is a tree, and at a second glance is
 * the reason a garden read as a toy. A crown is not one ball: it is several
 * lobes, offset and overlapping, denser in the middle, and it is darker
 * underneath than on top because the light comes from above. So a round
 * canopy is a middle lobe with four more hung round it, each a little
 * different, a conifer is tiers of cone that narrow going up, and a shrub
 * is a clump of three. The lobes carry a vertex colour that darkens toward
 * the bottom of the crown, which the material multiplies into whatever
 * colour and grain the foliage wears.
 *
 * Every tree is different and every tree is the same tree each time: the
 * lobes' offsets come from a hash of where the tree stands, so a garden
 * does not rearrange itself between frames or between two people's tours.
 */

export type TreeShape = {
  at: Vec2;
  heightM: number;
  trunkR: number;
  canopyR: number;
  shape: "round" | "cone";
};

/** A small deterministic hash of a position, in [0, 1). */
export function seedAt(at: Vec2, salt = 0): number {
  let h = Math.imul(Math.round(at[0] * 100) | 0, 374761393) ^ Math.imul(Math.round(at[1] * 100) | 0, 668265263) ^ Math.imul(salt + 1, 2147483647 >>> 3);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Where the trunk ends and the crown begins. */
export function trunkHeight(tree: TreeShape): number {
  return tree.shape === "cone" ? tree.heightM * 0.25 : tree.heightM - tree.canopyR * 1.6;
}

/** A lobe: an icosphere squashed to `ry` tall, at a point. */
function lobe(center: [number, number, number], r: number, ry: number, detail = 2): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, detail);
  g.scale(1, ry / r, 1);
  g.translate(center[0], center[1], center[2]);
  return g;
}

/**
 * Vertex colours darkening toward the bottom of the crown: the underside
 * of a canopy is in its own shade. Grey, so the material's colour still
 * decides the green; this only says how much of it.
 */
function shadeByHeight(geometry: THREE.BufferGeometry, from: number, to: number, floor = 0.5): void {
  const position = geometry.getAttribute("position");
  const colours = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    const t = Math.max(0, Math.min(1, (y - from) / Math.max(1e-6, to - from)));
    const v = floor + (1 - floor) * Math.pow(t, 0.7);
    colours[i * 3] = v;
    colours[i * 3 + 1] = v;
    colours[i * 3 + 2] = v;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
}

export function canopyGeometry(tree: TreeShape): THREE.BufferGeometry {
  const [x, z] = tree.at;
  const base = trunkHeight(tree);
  const parts: THREE.BufferGeometry[] = [];
  if (tree.shape === "cone") {
    // Tiers, each narrower than the one below and overlapping it, so the
    // silhouette steps the way a fir's does rather than running straight.
    const tiers = 3 + Math.floor(seedAt(tree.at, 1) * 2);
    const span = tree.heightM - base;
    for (let i = 0; i < tiers; i++) {
      const t = i / tiers;
      const h = (span / tiers) * 1.6;
      const r = tree.canopyR * (1 - t * 0.75) * (0.9 + seedAt(tree.at, 10 + i) * 0.2);
      const y = base + span * t + h / 2 - span * 0.05;
      const g = new THREE.ConeGeometry(r, h, 9 + (i % 2));
      g.translate(x, y, z);
      parts.push(g);
    }
  } else {
    const r = tree.canopyR;
    const centreY = base + r * 0.9;
    parts.push(lobe([x, centreY, z], r, r * 1.15));
    const count = 4 + Math.floor(seedAt(tree.at, 2) * 2);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + seedAt(tree.at, 20 + i) * 1.2;
      const reach = r * (0.45 + seedAt(tree.at, 40 + i) * 0.3);
      const lr = r * (0.55 + seedAt(tree.at, 60 + i) * 0.2);
      const ly = centreY + (seedAt(tree.at, 80 + i) - 0.35) * r * 0.9;
      parts.push(lobe([x + Math.cos(angle) * reach, ly, z + Math.sin(angle) * reach], lr, lr * 1.05));
    }
  }
  const merged = mergeGeometries(parts, false)!;
  merged.computeBoundingBox();
  const box = merged.boundingBox!;
  shadeByHeight(merged, box.min.y, box.max.y);
  return merged;
}

/** The trunk, and a few branches leaning out into the crown. */
export function trunkGeometry(tree: TreeShape): THREE.BufferGeometry {
  const [x, z] = tree.at;
  const base = trunkHeight(tree);
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(tree.trunkR * 0.85, tree.trunkR * 1.2, base + tree.canopyR * 0.6, 10);
  trunk.translate(x, (base + tree.canopyR * 0.6) / 2, z);
  parts.push(trunk);
  if (tree.shape === "round") {
    const count = 3;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + seedAt(tree.at, 100 + i) * 1.5;
      const length = tree.canopyR * 0.8;
      const branch = new THREE.CylinderGeometry(tree.trunkR * 0.25, tree.trunkR * 0.45, length, 6);
      // Stood up, then leant out at about forty degrees, then turned round the trunk.
      branch.translate(0, length / 2, 0);
      branch.rotateZ(0.7);
      branch.rotateY(-angle);
      branch.translate(x, base + tree.canopyR * 0.15, z);
      parts.push(branch);
    }
  }
  return mergeGeometries(parts, false)!;
}

/** A shrub as a clump of three lobes, the middle one tallest. */
export function shrubGeometry(shrub: { at: Vec2; r: number }): THREE.BufferGeometry {
  const [x, z] = shrub.at;
  const r = shrub.r;
  const parts = [lobe([x, r * 0.8, z], r, r * 0.95)];
  for (let i = 0; i < 2; i++) {
    const angle = seedAt(shrub.at, 200 + i) * Math.PI * 2;
    const lr = r * (0.6 + seedAt(shrub.at, 210 + i) * 0.15);
    parts.push(lobe([x + Math.cos(angle) * r * 0.5, lr * 0.75, z + Math.sin(angle) * r * 0.5], lr, lr * 0.9));
  }
  const merged = mergeGeometries(parts, false)!;
  merged.computeBoundingBox();
  shadeByHeight(merged, 0, merged.boundingBox!.max.y, 0.6);
  return merged;
}
