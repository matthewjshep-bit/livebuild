import * as THREE from "three";

import { heightFromImageData, normalBytes, ormBytes } from "@/lib/model/maps";
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
 *
 * Each generator draws twice: once in colour, and once in greys saying where
 * the surface is high and low. The second pass is what the normal, occlusion
 * and roughness maps are derived from, and it has to be drawn rather than
 * inferred - a dark board is not a groove, and reading brightness as height is
 * the difference between a surface and an embossed picture of one. Both passes
 * share a seed, so every plank seam and grout line lands in the same place in
 * both.
 */

const surfaceCache = new Map<string, Surface>();

/** The full set of maps for one finish. */
export type Surface = {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  /** AO in red, roughness in green, metalness in blue - the glTF convention. */
  ormMap: THREE.Texture;
};

/** Which channel a generator is being asked to draw. */
export type Channel = "albedo" | "height";

/** Mid-grey: the surface's resting level, from which things rise and sink. */
const GROUND = "#808080";

/** Texels per metre. High enough for grain to survive standing in a room. */
const TEXELS_PER_M = 128;

/**
 * Draw both passes and derive the maps.
 *
 * The height canvas is read back with `getImageData`, which is why this cannot
 * run on the server - the same constraint `canTexture()` already guards.
 */
function makeSurface(
  key: string,
  size: number,
  draw: (g: CanvasRenderingContext2D, w: number, h: number, channel: Channel) => void,
  finish: { roughness: number; roughVariance?: number; metalness?: number; relief: number },
): Surface {
  const hit = surfaceCache.get(key);
  if (hit) return hit;

  const albedo = document.createElement("canvas");
  albedo.width = albedo.height = size;
  const ac = albedo.getContext("2d");
  if (!ac) throw new Error("no 2d context");
  draw(ac, size, size, "albedo");

  const height = document.createElement("canvas");
  height.width = height.height = size;
  // `willReadFrequently` because this canvas exists only to be read back once;
  // without it the browser keeps it on the GPU and the readback stalls.
  const hc = height.getContext("2d", { willReadFrequently: true });
  if (!hc) throw new Error("no 2d context");
  hc.fillStyle = GROUND;
  hc.fillRect(0, 0, size, size);
  draw(hc, size, size, "height");

  const field = heightFromImageData(hc.getImageData(0, 0, size, size).data, size);

  const colour = new THREE.CanvasTexture(albedo);
  colour.colorSpace = THREE.SRGBColorSpace;

  const normal = dataTexture(normalBytes(field, finish.relief), size);
  const orm = dataTexture(ormBytes(field, finish), size);

  for (const texture of [colour, normal, orm]) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 8;
    texture.needsUpdate = true;
  }

  const surface = { map: colour, normalMap: normal, ormMap: orm };
  surfaceCache.set(key, surface);
  return surface;
}

/**
 * A texture carrying numbers rather than colour.
 *
 * `NoColorSpace` is load-bearing and fails quietly: a normal map decoded as
 * sRGB still points roughly the right way, so the surface looks lit but subtly
 * wrong everywhere, with no error to find.
 */
function dataTexture(bytes: Uint8ClampedArray, size: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(bytes, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
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
export function wallSurface(colour: string): Surface {
  return makeSurface(
    `wall|${colour}`,
    512,
    (g, w, h, channel) => {
      const albedo = channel === "albedo";
      g.fillStyle = albedo ? colour : GROUND;
      g.fillRect(0, 0, w, h);

      const rand = seeded(0x5eed);

      // Broad cloudy mottling, as an uneven skim coat takes paint. In height
      // this is the gentle undulation of a hand-finished wall - the thing that
      // makes raking light across plaster look like plaster.
      for (let i = 0; i < 45; i++) {
        const r = 50 + rand() * 140;
        const x = rand() * w;
        const y = rand() * h;
        const up = rand() < 0.5;
        const grad = g.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(
          0,
          albedo
            ? up ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.045)"
            : up ? "rgba(255,255,255,0.30)" : "rgba(0,0,0,0.26)",
        );
        grad.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = grad;
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
      }

      // Short directional strokes: brush and roller marks, which are relief
      // as much as tone.
      for (let i = 0; i < 700; i++) {
        const x = rand() * w;
        const y = rand() * h;
        const len = 8 + rand() * 24;
        const angle = (rand() - 0.5) * 1.3;
        const up = rand() < 0.5;
        g.strokeStyle = albedo
          ? up ? "rgba(255,255,255,0.035)" : "rgba(0,0,0,0.028)"
          : up ? "rgba(255,255,255,0.13)" : "rgba(0,0,0,0.11)";
        g.lineWidth = 1 + rand() * 2.5;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
        g.stroke();
      }

      g.globalAlpha = albedo ? 0.04 : 0.1;
      for (let i = 0; i < 1200; i++) {
        g.fillStyle = rand() < 0.5 ? "#fff" : "#000";
        g.fillRect(rand() * w, rand() * h, 2, 2);
      }
      g.globalAlpha = 1;
    },
    // Emulsion on plaster: nearly matte, barely any relief. The point of the
    // relief that is here is not to be seen as texture but to stop a large
    // white wall reading as a single flat value under a moving light.
    { roughness: 0.92, roughVariance: 0.06, relief: 0.35 },
  );
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
/**
 * How each floor finish behaves under light.
 *
 * `relief` is the one to tune by eye: too little and grout lines vanish, too
 * much and a floor looks like corrugated iron. These are set so the relief is
 * invisible standing up and obvious at a grazing angle, which is how a real
 * floor behaves.
 */
const FLOOR_FINISH: Record<FloorFinish, {
  roughness: number;
  roughVariance?: number;
  metalness?: number;
  relief: number;
}> = {
  // Satin lacquer: the sheen is what says "sealed" rather than "bare timber".
  wood: { roughness: 0.42, roughVariance: 0.14, relief: 1.1 },
  // Glazed, and the grout between is not. That contrast is most of what
  // reads as tile.
  tile: { roughness: 0.22, roughVariance: 0.34, relief: 2.4 },
  stone: { roughness: 0.38, roughVariance: 0.22, relief: 1.9 },
  // No sheen at all, and deep fine relief. Carpet is nothing but pile.
  carpet: { roughness: 0.96, roughVariance: 0.05, relief: 2.2 },
  concrete: { roughness: 0.82, roughVariance: 0.16, relief: 1.3 },
  grass: { roughness: 0.94, roughVariance: 0.08, relief: 1.6 },
};

/**
 * A floor, drawn at one square metre per tile.
 *
 * The metre is what makes the texture usable: the model is metric, so a
 * texture that covers a known real distance can be repeated by world position
 * and every room ends up with the same plank width.
 */
export function floorSurface(finish: FloorFinish, tone: string): Surface {
  return makeSurface(
    `floor|${finish}|${tone}`,
    TEXELS_PER_M * 2,
    (g, w, h, channel) => {
      const albedo = channel === "albedo";
      const rand = seeded(0xf100 + finish.length * 977);
      g.fillStyle = albedo ? tone : GROUND;
      g.fillRect(0, 0, w, h);

      /** A tone in colour, a height in the height pass. */
      const paint = (shifted: number, level: number) =>
        albedo ? shift(tone, shifted) : shift(GROUND, level);

      if (finish === "wood") {
        // Two metres of floor, so eight boards puts them at a real 250mm.
        const boards = 8;
        const bw = h / boards;
        for (let i = 0; i < boards; i++) {
          // Boards are not perfectly coplanar - each sits a hair high or low,
          // which is what catches the light along a real floor.
          g.fillStyle = paint((i % 3) * -7 + 3, (i % 3) * 8 - 6);
          g.fillRect(0, i * bw, w, bw - 1.5);

          // Grain runs along the board. It is colour, not depth: sanded timber
          // is flat, and lifting the grain is what makes fake wood look fake.
          if (albedo) {
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
          } else {
            // The gap between boards, which is depth and nothing else.
            g.fillStyle = shift(GROUND, -70);
            g.fillRect(0, i * bw + bw - 1.5, w, 1.5);
          }

          // End joints, staggered board to board.
          const seam = ((i % 3) * w) / 3 + w / 6;
          g.strokeStyle = albedo ? "rgba(50,32,16,0.35)" : shift(GROUND, -70);
          g.lineWidth = 1.5;
          g.beginPath();
          g.moveTo(seam, i * bw);
          g.lineTo(seam, i * bw + bw - 1.5);
          g.stroke();
        }
        return;
      }

      if (finish === "tile" || finish === "stone") {
        // 400mm tiles at two metres across. The ground stays low and each tile
        // is laid proud of it, so the gaps between become grout automatically.
        if (!albedo) {
          g.fillStyle = shift(GROUND, -60);
          g.fillRect(0, 0, w, h);
        }
        const n = 5;
        const s = w / n;
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            g.fillStyle = paint(
              (rand() - 0.5) * (finish === "stone" ? 22 : 10),
              // Tiles sit at slightly different heights, as laid tiles do.
              50 + (rand() - 0.5) * (finish === "stone" ? 14 : 6),
            );
            g.fillRect(i * s + 1.5, j * s + 1.5, s - 3, s - 3);
            if (finish === "stone" && albedo) {
              // Veining, which is what separates stone from a grey square. It
              // is mineral, not carved, so it stays out of the height pass.
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
        // Dense flecks. Carpet has no pattern, only depth - so this is the one
        // finish where the height pass is doing most of the work.
        for (let i = 0; i < 26000; i++) {
          g.fillStyle = paint((rand() - 0.5) * 26, (rand() - 0.5) * 110);
          g.fillRect(rand() * w, rand() * h, 1.6, 1.6);
        }
        return;
      }

      if (finish === "grass") {
        for (let i = 0; i < 20000; i++) {
          const x = rand() * w;
          const y = rand() * h;
          g.strokeStyle = paint((rand() - 0.5) * 34, (rand() - 0.5) * 90);
          g.lineWidth = 0.8;
          g.beginPath();
          g.moveTo(x, y);
          g.lineTo(x + (rand() - 0.5) * 3, y - 2 - rand() * 3);
          g.stroke();
        }
        return;
      }

      // Concrete: broad blotching plus aggregate speckle. The blotches are
      // staining, so they are colour only; the aggregate is real and shows in
      // both.
      if (albedo) {
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
      } else {
        // Keep the noise stream in step with the albedo pass, so the speckle
        // below lands in the same places in both.
        for (let i = 0; i < 180; i++) rand();
      }
      for (let i = 0; i < 6000; i++) {
        g.fillStyle = paint((rand() - 0.5) * 30, (rand() - 0.5) * 60);
        g.fillRect(rand() * w, rand() * h, 1.4, 1.4);
      }
    },
    FLOOR_FINISH[finish],
  );
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

  const attribute = new THREE.BufferAttribute(uv, 2);
  geometry.setAttribute("uv", attribute);
  // Ambient occlusion reads `uv1`, not `uv`. Nothing warns about this: leave
  // it out and the AO map is sampled with whatever `uv1` happened to hold - on
  // a merged box geometry, nothing at all - so the occlusion silently does not
  // appear. The two sets are identical here, so the same array serves both.
  geometry.setAttribute("uv1", attribute);
}

/** True when textures can be generated at all - false during server render. */
export function canTexture(): boolean {
  return typeof document !== "undefined";
}
