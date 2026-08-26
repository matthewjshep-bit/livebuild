import * as THREE from "three";

import { type RoomKind, roomKind } from "@/lib/plan/room-kind";

/**
 * Surface textures, drawn into a canvas at runtime.
 *
 * The model used to be flat colour on the reasoning that an architectural
 * drawing is judged on its own terms while a render invites comparison with the
 * photographs and loses. That was wrong in practice: flat colour does not read
 * as a considered drawing, it reads as untextured geometry, and the difference
 * between this and a model people call convincing turns out to be mostly
 * surface grain.
 *
 * Everything is generated in code rather than shipped as images. That is the
 * same choice already made for furniture and for the same reasons: nothing to
 * license, nothing to download, and a floor that can be regenerated at any size
 * without a texture atlas. It also keeps the tour openable offline.
 *
 * Every generator is memoised, because a house has one oak floor no matter how
 * many rooms are laid with it.
 */

const cache = new Map<string, THREE.Texture>();

/** Texels per metre. High enough for grain to survive standing in a room. */
const TEXELS_PER_M = 128;

function make(key: string, size: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void) {
  const hit = cache.get(key);
  if (hit) return hit;

  // Server-side rendering has no canvas. Callers fall back to plain colour,
  // which is what the model looked like before any of this existed.
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2d context");
  draw(context, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  cache.set(key, texture);
  return texture;
}

const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** Nudge a colour lighter or darker, for grain within one material. */
const shift = (hex: string, amount: number): string => {
  const [r, g, b] = rgb(hex);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v + amount)));
  return `rgb(${clamp(r)},${clamp(g)},${clamp(b)})`;
};

/**
 * Deterministic noise.
 *
 * `Math.random` would give a different floor on every reload, which reads as
 * the model being unsure of itself - the same reason the layout arranger is
 * seeded.
 */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* ------------------------------------------------------------------ walls */

/**
 * Painted plaster.
 *
 * Short directional strokes and a little fine grain. The effect is almost
 * subliminal at a distance and is the whole difference close up: a flat wall
 * has no scale, and a wall with grain tells the eye how far away it is.
 */
export function wallTexture(colour: string): THREE.Texture {
  return make(`wall|${colour}`, 512, (g, w, h) => {
    g.fillStyle = colour;
    g.fillRect(0, 0, w, h);

    const rand = seeded(0x5eed);

    // Broad cloudy mottling, as an uneven skim coat takes paint.
    for (let i = 0; i < 45; i++) {
      const r = 50 + rand() * 140;
      const x = rand() * w;
      const y = rand() * h;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, rand() < 0.5 ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.045)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }

    for (let i = 0; i < 700; i++) {
      const x = rand() * w;
      const y = rand() * h;
      const len = 8 + rand() * 24;
      const angle = (rand() - 0.5) * 1.3;
      g.strokeStyle = rand() < 0.5 ? "rgba(255,255,255,0.035)" : "rgba(0,0,0,0.028)";
      g.lineWidth = 1 + rand() * 2.5;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
      g.stroke();
    }

    g.globalAlpha = 0.04;
    for (let i = 0; i < 1200; i++) {
      g.fillStyle = rand() < 0.5 ? "#fff" : "#000";
      g.fillRect(rand() * w, rand() * h, 2, 2);
    }
  });
}

/* ------------------------------------------------------------------ floors */

export type FloorFinish = "wood" | "tile" | "stone" | "carpet" | "concrete" | "grass";

/** What each kind of room is floored with. */
const FINISHES: Record<RoomKind, FloorFinish> = {
  living: "wood",
  dining: "wood",
  office: "wood",
  hallway: "wood",
  stairs: "wood",
  bedroom: "carpet",
  "primary-bedroom": "carpet",
  closet: "carpet",
  kitchen: "tile",
  laundry: "tile",
  bathroom: "tile",
  powder: "tile",
  entry: "stone",
  garage: "concrete",
  basement: "concrete",
  outside: "grass",
  other: "wood",
};

export function floorFinish(label: string): FloorFinish {
  return FINISHES[roomKind(label)] ?? "wood";
}

/**
 * A floor, drawn at one square metre per tile.
 *
 * The metre is what makes the texture usable: the model is metric, so a
 * texture that covers a known real distance can be repeated by world position
 * and every room ends up with the same plank width.
 */
export function floorTexture(finish: FloorFinish, tone: string): THREE.Texture {
  return make(`floor|${finish}|${tone}`, TEXELS_PER_M * 2, (g, w, h) => {
    const rand = seeded(0xf100 + finish.length * 977);
    g.fillStyle = tone;
    g.fillRect(0, 0, w, h);

    if (finish === "wood") {
      // Two metres of floor, so eight boards puts them at a real 250mm.
      const boards = 8;
      const bw = h / boards;
      for (let i = 0; i < boards; i++) {
        g.fillStyle = shift(tone, (i % 3) * -7 + 3);
        g.fillRect(0, i * bw, w, bw - 1.5);
        // Grain, running along the board.
        g.globalAlpha = 0.16;
        g.strokeStyle = shift(tone, -60);
        for (let k = 0; k < 14; k++) {
          const y = i * bw + rand() * bw;
          g.lineWidth = 0.5 + rand();
          g.beginPath();
          g.moveTo(0, y);
          g.bezierCurveTo(w * 0.3, y + (rand() - 0.5) * 3, w * 0.7, y + (rand() - 0.5) * 3, w, y);
          g.stroke();
        }
        g.globalAlpha = 1;
        // End joints, staggered board to board.
        const seam = ((i % 3) * w) / 3 + w / 6;
        g.strokeStyle = "rgba(50,32,16,0.35)";
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(seam, i * bw);
        g.lineTo(seam, i * bw + bw - 1.5);
        g.stroke();
      }
      return;
    }

    if (finish === "tile" || finish === "stone") {
      // 400mm tiles at two metres across.
      const n = 5;
      const s = w / n;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          g.fillStyle = shift(tone, (rand() - 0.5) * (finish === "stone" ? 22 : 10));
          g.fillRect(i * s + 1.5, j * s + 1.5, s - 3, s - 3);
          if (finish === "stone") {
            // Veining, which is what separates stone from a grey square.
            g.globalAlpha = 0.18;
            g.strokeStyle = shift(tone, -55);
            for (let k = 0; k < 3; k++) {
              g.lineWidth = 0.6 + rand() * 1.2;
              g.beginPath();
              const x0 = i * s + rand() * s;
              const y0 = j * s;
              g.moveTo(x0, y0);
              g.bezierCurveTo(
                x0 + (rand() - 0.5) * s, y0 + s * 0.4,
                x0 + (rand() - 0.5) * s, y0 + s * 0.7,
                x0 + (rand() - 0.5) * s, y0 + s,
              );
              g.stroke();
            }
            g.globalAlpha = 1;
          }
        }
      }
      return;
    }

    if (finish === "carpet") {
      // Dense flecks. Carpet has no pattern, only depth.
      for (let i = 0; i < 26000; i++) {
        g.fillStyle = shift(tone, (rand() - 0.5) * 26);
        g.fillRect(rand() * w, rand() * h, 1.6, 1.6);
      }
      return;
    }

    if (finish === "grass") {
      for (let i = 0; i < 20000; i++) {
        const x = rand() * w;
        const y = rand() * h;
        g.strokeStyle = shift(tone, (rand() - 0.5) * 34);
        g.lineWidth = 0.8;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + (rand() - 0.5) * 3, y - 2 - rand() * 3);
        g.stroke();
      }
      return;
    }

    // Concrete: broad blotching plus aggregate speckle.
    for (let i = 0; i < 60; i++) {
      const r = 20 + rand() * 90;
      const x = rand() * w;
      const y = rand() * h;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, rand() < 0.5 ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    for (let i = 0; i < 6000; i++) {
      g.fillStyle = shift(tone, (rand() - 0.5) * 30);
      g.fillRect(rand() * w, rand() * h, 1.4, 1.4);
    }
  });
}

/** How many metres one tile of a texture covers, so UVs can be world-scaled. */
export const TEXTURE_METRES = { wall: 2.4, floor: 2 } as const;

/**
 * Rewrite a merged geometry's UVs from world position.
 *
 * Boxes arrive with their own 0-to-1 UVs per face, so a repeating texture
 * tiles exactly once across every box however large it is - a floorboard the
 * width of a room, a different plank size in every room. Since the merge
 * happens in world coordinates, the fix is to derive UVs from the position
 * instead, projecting on whichever pair of axes the face points away from.
 *
 * The result is one texel density everywhere in the house, so a floor reads as
 * continuous across a doorway and a wall's grain does not change size with the
 * wall.
 */
export function applyWorldUvs(geometry: THREE.BufferGeometry, metresPerTile: number): void {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  if (!position || !normal) return;

  const uv = new Float32Array(position.count * 2);
  const scale = 1 / metresPerTile;

  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const nx = Math.abs(normal.getX(i));
    const ny = Math.abs(normal.getY(i));
    const nz = Math.abs(normal.getZ(i));

    let u: number;
    let v: number;
    if (ny >= nx && ny >= nz) {
      // Floor or ceiling: read the plan directly.
      u = x;
      v = z;
    } else if (nx >= nz) {
      u = z;
      v = y;
    } else {
      u = x;
      v = y;
    }
    uv[i * 2] = u * scale;
    uv[i * 2 + 1] = v * scale;
  }

  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

/** True when textures can be generated at all - false during server render. */
export function canTexture(): boolean {
  return typeof document !== "undefined";
}
