import * as THREE from "three";

import type { SidingFinish } from "@/lib/model/siding";

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
 * Everything here is generated in code. That was the whole answer once, for
 * the reasons furniture is built rather than downloaded: nothing to license,
 * nothing to fetch, a floor that can be regenerated at any size. Scanned sets
 * now ship with the app (`assets.ts`, `asset-surfaces.ts`) and dress the
 * house when the tier can afford them; these are what it opens in, what the
 * low tier keeps, and what it falls back to. Either way a tour opens
 * offline and downloads nothing from anyone else - and no photograph of the
 * house itself is ever on the model.
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
  /**
   * The material colour to multiply the maps by, in linear light. A drawn
   * surface carries its colour in the map and leaves this white; a bundled
   * scan is tinted to the read colour with it. See `tint.ts`.
   */
  tint?: [number, number, number];
  /** True for a shipped scan rather than a drawn one. */
  bundled?: boolean;
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

/**
 * What a wall is made of, when it is not painted plaster.
 *
 * Deliberately the same union as `WallMaterial` in `spec/schema.ts`, for the
 * reason the floors give: a spec that can name a material nothing can render
 * is a spec that lies. Until now it lied - all six were read, stored, and
 * every one of them was drawn as emulsion.
 */
export type WallFinish = "paint" | "wallpaper" | "tile" | "panelling" | "exposed-brick" | "timber";

/** Walls cover 2.4m per tile, so these are the pixel sizes of real things. */
const WALL_PX = 512;
const WALL_PX_PER_M = WALL_PX / 2.4;

/**
 * A wall surface by material. Paint is the plaster generator above; the
 * others are drawn here, in the same two passes with the same seeded noise.
 */
export function wallMaterialSurface(material: WallFinish | null | undefined, colour: string): Surface {
  switch (material) {
    case "exposed-brick":
      return brickSurface(colour);
    case "tile":
      return wallTileSurface(colour);
    case "panelling":
      return boardSurface(colour, "vertical", 0.14, true);
    case "timber":
      return boardSurface(colour, "horizontal", 0.14, false);
    case "wallpaper":
      return wallpaperSurface(colour);
    default:
      return wallSurface(colour);
  }
}

/**
 * Brick in running bond.
 *
 * A standard brick is 215 by 65 with a 10mm joint, and every course is offset
 * by half a brick. The mortar is *lower* than the brick in the height pass -
 * which is the whole of what makes it read as masonry rather than as a
 * printed pattern - and every brick is its own slightly different colour.
 */
function brickSurface(colour: string): Surface {
  return makeSurface(
    `wall|brick|${colour}`,
    WALL_PX,
    (g, w, h, channel) => {
      const albedo = channel === "albedo";
      const rand = seeded(0xb41c);
      // Mortar first, everywhere. Low in height; pale in colour.
      g.fillStyle = albedo ? "rgb(196,190,180)" : shift(GROUND, -55);
      g.fillRect(0, 0, w, h);

      const bw = 0.215 * WALL_PX_PER_M;
      const bh = 0.065 * WALL_PX_PER_M;
      const joint = 0.01 * WALL_PX_PER_M;
      const courses = Math.ceil(h / (bh + joint)) + 1;
      for (let c = 0; c < courses; c++) {
        const y = c * (bh + joint);
        const offset = c % 2 === 0 ? 0 : (bw + joint) / 2;
        for (let x = -bw + offset; x < w + bw; x += bw + joint) {
          // Each brick its own colour: a little lighter or darker, and one in
          // nine noticeably darker, the way a fired batch varies.
          const dark = rand() < 0.11;
          const tone = (rand() - 0.5) * 22 + (dark ? -34 : 0);
          g.fillStyle = albedo ? shift(colour, tone) : shift(GROUND, 8 + (rand() - 0.5) * 8);
          g.fillRect(x, y, bw, bh);
          if (albedo) {
            // Speckle, which is the texture of the clay.
            g.globalAlpha = 0.16;
            for (let k = 0; k < 6; k++) {
              g.fillStyle = rand() < 0.5 ? "#000" : "#fff";
              g.fillRect(x + rand() * bw, y + rand() * bh, 1.5, 1.5);
            }
            g.globalAlpha = 1;
          }
        }
      }
    },
    // Matte and rough, with real relief at the joints.
    { roughness: 0.9, roughVariance: 0.08, relief: 2.6 },
  );
}

/** Wall tile on a 200mm grid, glazed, with grout that is not. */
function wallTileSurface(colour: string): Surface {
  return makeSurface(
    `wall|tile|${colour}`,
    WALL_PX,
    (g, w, h, channel) => {
      const albedo = channel === "albedo";
      const rand = seeded(0x7113);
      g.fillStyle = albedo ? "rgb(214,212,206)" : shift(GROUND, -60);
      g.fillRect(0, 0, w, h);
      const s = 0.2 * WALL_PX_PER_M;
      const grout = 0.003 * WALL_PX_PER_M;
      for (let y = 0; y < h; y += s) {
        for (let x = 0; x < w; x += s) {
          g.fillStyle = albedo
            ? shift(colour, (rand() - 0.5) * 8)
            : shift(GROUND, 48 + (rand() - 0.5) * 5);
          g.fillRect(x + grout / 2, y + grout / 2, s - grout, s - grout);
        }
      }
    },
    { roughness: 0.2, roughVariance: 0.34, relief: 2.2 },
  );
}

/**
 * Boards: vertical panelling with a V-groove, or horizontal timber cladding.
 *
 * Each board is its own shade and sits a hair proud or shy of its neighbour,
 * as the floor's planks do. Grain is colour only - sanded timber is flat.
 */
function boardSurface(colour: string, run: "vertical" | "horizontal", widthM: number, groove: boolean): Surface {
  return makeSurface(
    `wall|board|${run}|${colour}`,
    WALL_PX,
    (g, w, h, channel) => {
      const albedo = channel === "albedo";
      const rand = seeded(run === "vertical" ? 0x9a4e : 0x71b3);
      g.fillStyle = albedo ? colour : GROUND;
      g.fillRect(0, 0, w, h);
      const bw = widthM * WALL_PX_PER_M;
      const gap = groove ? 0.004 * WALL_PX_PER_M : 0.002 * WALL_PX_PER_M;
      const count = Math.ceil((run === "vertical" ? w : h) / bw) + 1;
      for (let i = 0; i < count; i++) {
        const at = i * bw;
        const tone = (i % 3) * -6 + 3 + (rand() - 0.5) * 6;
        const level = (i % 3) * 7 - 5;
        g.fillStyle = albedo ? shift(colour, tone) : shift(GROUND, level);
        if (run === "vertical") g.fillRect(at, 0, bw - gap, h);
        else g.fillRect(0, at, w, bw - gap);

        // The groove or shadow line between boards: depth, not colour.
        if (!albedo) {
          g.fillStyle = shift(GROUND, groove ? -70 : -40);
          if (run === "vertical") g.fillRect(at + bw - gap, 0, gap, h);
          else g.fillRect(0, at + bw - gap, w, gap);
        }

        if (albedo) {
          g.globalAlpha = 0.14;
          g.strokeStyle = shift(colour, -55);
          for (let k = 0; k < 10; k++) {
            g.lineWidth = 0.5 + rand();
            g.beginPath();
            if (run === "vertical") {
              const x = at + rand() * (bw - gap);
              g.moveTo(x, 0);
              g.bezierCurveTo(x + (rand() - 0.5) * 3, h * 0.3, x + (rand() - 0.5) * 3, h * 0.7, x, h);
            } else {
              const y = at + rand() * (bw - gap);
              g.moveTo(0, y);
              g.bezierCurveTo(w * 0.3, y + (rand() - 0.5) * 3, w * 0.7, y + (rand() - 0.5) * 3, w, y);
            }
            g.stroke();
          }
          g.globalAlpha = 1;
        }
      }
    },
    { roughness: 0.62, roughVariance: 0.12, relief: 1.2 },
  );
}

/** Plaster with a faint repeating motif, in colour only. */
function wallpaperSurface(colour: string): Surface {
  // The plaster pass, then a pattern over it. The pattern is albedo only:
  // paper has no relief, and lifting it would read as embossed tin.
  const base = wallSurface(colour);
  return makeSurface(
    `wall|paper|${colour}`,
    WALL_PX,
    (g, w, h, channel) => {
      const albedo = channel === "albedo";
      g.drawImage(base.map.image as HTMLCanvasElement, 0, 0, w, h);
      if (!albedo) return;
      const rand = seeded(0x9a9e);
      const step = 0.12 * WALL_PX_PER_M;
      g.globalAlpha = 0.09;
      g.strokeStyle = shift(colour, -70);
      g.lineWidth = 1.2;
      for (let y = 0; y < h + step; y += step) {
        for (let x = 0; x < w + step; x += step) {
          const ox = (Math.floor(y / step) % 2) * (step / 2);
          g.beginPath();
          g.moveTo(x + ox, y - step * 0.3);
          g.lineTo(x + ox + step * 0.3, y);
          g.lineTo(x + ox, y + step * 0.3);
          g.lineTo(x + ox - step * 0.3, y);
          g.closePath();
          g.stroke();
          if (rand() < 0.02) g.stroke();
        }
      }
      g.globalAlpha = 1;
    },
    { roughness: 0.9, roughVariance: 0.05, relief: 0.35 },
  );
}

/* ---------------------------------------------------------------- outside */

/**
 * The outside of the house.
 *
 * Every wall generator above is what a room looks like from inside. These
 * are what the building looks like from the street, which is where a house
 * is judged first - and until now the street saw an untextured box.
 */
export function sidingSurface(finish: SidingFinish | null, colour: string): Surface {
  switch (finish) {
    case "brick":
      return brickSurface(colour);
    case "board-and-batten":
      return boardSurface(colour, "vertical", 0.3, true);
    case "stucco":
      return stuccoSurface(colour);
    case "shingle":
      return courseSurface(colour, "shingle");
    default:
      return courseSurface(colour, "lap");
  }
}

/**
 * Horizontal courses: lap boards, or shingles with their staggered joints.
 *
 * The look is the shadow line under each course - a lap board is thicker at
 * its bottom edge and casts a line on the one below - so in height each
 * course thickens downward and ends in a dark step. Shingles are the same
 * courses cut into tabs of uneven width, offset course to course.
 */
function courseSurface(colour: string, kind: "lap" | "shingle"): Surface {
  return makeSurface(
    `siding|${kind}|${colour}`,
    WALL_PX,
    (g, w, h, channel) => {
      const albedo = channel === "albedo";
      const rand = seeded(kind === "lap" ? 0x1a9 : 0x5b1);
      g.fillStyle = albedo ? colour : GROUND;
      g.fillRect(0, 0, w, h);

      const course = (kind === "lap" ? 0.15 : 0.2) * WALL_PX_PER_M;
      const shadow = 3;
      const courses = Math.ceil(h / course) + 1;
      for (let c = 0; c < courses; c++) {
        const y = c * course;
        if (kind === "lap") {
          const tone = (rand() - 0.5) * 8;
          if (albedo) {
            g.fillStyle = shift(colour, tone);
            g.fillRect(0, y, w, course - shadow);
          } else {
            // Thickening toward the bottom edge, then the step.
            const grad = g.createLinearGradient(0, y, 0, y + course - shadow);
            grad.addColorStop(0, shift(GROUND, 2));
            grad.addColorStop(1, shift(GROUND, 16));
            g.fillStyle = grad;
            g.fillRect(0, y, w, course - shadow);
          }
          g.fillStyle = albedo ? "rgba(0,0,0,0.28)" : shift(GROUND, -40);
          g.fillRect(0, y + course - shadow, w, shadow);
        } else {
          const offset = rand() * 0.2 * WALL_PX_PER_M;
          for (let x = -0.3 * WALL_PX_PER_M + offset; x < w; ) {
            const tab = (0.1 + rand() * 0.15) * WALL_PX_PER_M;
            const tone = (rand() - 0.5) * 18;
            g.fillStyle = albedo ? shift(colour, tone) : shift(GROUND, 6 + (rand() - 0.5) * 6);
            g.fillRect(x, y, tab - 2, course - shadow);
            x += tab;
          }
          g.fillStyle = albedo ? "rgba(0,0,0,0.3)" : shift(GROUND, -40);
          g.fillRect(0, y + course - shadow, w, shadow);
        }
      }
    },
    { roughness: 0.85, roughVariance: 0.06, relief: 2.2 },
  );
}

/** Render: the plaster pass with a coarser hand and real relief. */
function stuccoSurface(colour: string): Surface {
  return makeSurface(
    `siding|stucco|${colour}`,
    WALL_PX,
    (g, w, h, channel) => {
      const albedo = channel === "albedo";
      const rand = seeded(0x57cc);
      g.fillStyle = albedo ? colour : GROUND;
      g.fillRect(0, 0, w, h);
      // Trowelled: overlapping soft blobs, each a little up or down.
      for (let i = 0; i < 900; i++) {
        const r = 4 + rand() * 18;
        const x = rand() * w;
        const y = rand() * h;
        const up = rand() < 0.5;
        const grad = g.createRadialGradient(x, y, 0, x, y, r);
        const tone = albedo ? (up ? "255,255,255" : "0,0,0") : up ? "255,255,255" : "0,0,0";
        grad.addColorStop(0, `rgba(${tone},${albedo ? 0.06 : 0.16})`);
        grad.addColorStop(1, `rgba(${tone},0)`);
        g.fillStyle = grad;
        g.fillRect(x - r, y - r, r * 2, r * 2);
      }
    },
    { roughness: 0.95, roughVariance: 0.05, relief: 3.4 },
  );
}

/**
 * Foliage: a canopy, a shrub, a hedge.
 *
 * Dense flecks in two tones over the leaf colour, rough, with enough relief
 * that the light breaks over it. It does not try to be leaves; it tries to
 * stop a sphere reading as a sphere.
 */
export function foliageSurface(tone: string): Surface {
  return makeSurface(
    `site|foliage|${tone}`,
    WALL_PX,
    (g, w, h, channel) => {
      const albedo = channel === "albedo";
      const rand = seeded(0xf011);
      g.fillStyle = albedo ? tone : GROUND;
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 6000; i++) {
        const light = rand() < 0.45;
        const r = 2 + rand() * 5;
        g.fillStyle = albedo ? shift(tone, light ? 26 : -30) : shift(GROUND, light ? 22 : -22);
        g.beginPath();
        g.ellipse(rand() * w, rand() * h, r, r * 0.6, rand() * Math.PI, 0, Math.PI * 2);
        g.fill();
      }
    },
    { roughness: 0.95, roughVariance: 0.05, relief: 2.4 },
  );
}

/**
 * Asphalt, for the road outside.
 *
 * A fine aggregate speckle over a dark grey, a faint pale seam now and then
 * where a repair was made, and almost no relief - a road is the flattest
 * thing in the scene, and the texture's job is to stop it reading as a strip
 * of paint.
 */
export function asphaltSurface(tone = "#4a4b4d"): Surface {
  return makeSurface(
    `site|asphalt|${tone}`,
    WALL_PX,
    (g, w, h, channel) => {
      const albedo = channel === "albedo";
      const rand = seeded(0xa5fa);
      g.fillStyle = albedo ? tone : GROUND;
      g.fillRect(0, 0, w, h);
      // Aggregate.
      g.globalAlpha = albedo ? 0.22 : 0.3;
      for (let i = 0; i < 9000; i++) {
        const bright = rand() < 0.5;
        g.fillStyle = albedo ? (bright ? "#fff" : "#000") : bright ? shift(GROUND, 10) : shift(GROUND, -8);
        g.fillRect(rand() * w, rand() * h, 1.2, 1.2);
      }
      g.globalAlpha = 1;
      // A repair seam or two.
      for (let i = 0; i < 3; i++) {
        const x = rand() * w;
        g.strokeStyle = albedo ? "rgba(255,255,255,0.08)" : shift(GROUND, -6);
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x + (rand() - 0.5) * 40, h);
        g.stroke();
      }
    },
    { roughness: 0.92, roughVariance: 0.05, relief: 0.6 },
  );
}

/**
 * Asphalt shingle on the roof: courses of tabs, staggered, with a dark
 * line at each course. The colour is the read's roof colour or a dark grey.
 */
export function roofSurface(colour: string): Surface {
  return makeSurface(
    `roof|${colour}`,
    WALL_PX,
    (g, w, h, channel) => {
      const albedo = channel === "albedo";
      const rand = seeded(0x400f);
      g.fillStyle = albedo ? colour : GROUND;
      g.fillRect(0, 0, w, h);
      const course = 0.3 * WALL_PX_PER_M;
      const tab = 0.45 * WALL_PX_PER_M;
      const courses = Math.ceil(h / course) + 1;
      for (let c = 0; c < courses; c++) {
        const y = c * course;
        const offset = (c % 2) * (tab / 2) + (rand() - 0.5) * 6;
        for (let x = -tab + offset; x < w; x += tab) {
          const tone = (rand() - 0.5) * 20;
          g.fillStyle = albedo ? shift(colour, tone) : shift(GROUND, 8 + (rand() - 0.5) * 6);
          g.fillRect(x, y, tab - 2, course - 3);
          if (albedo) {
            // Granules.
            g.globalAlpha = 0.14;
            for (let k = 0; k < 10; k++) {
              g.fillStyle = rand() < 0.5 ? "#000" : "#fff";
              g.fillRect(x + rand() * tab, y + rand() * course, 1.5, 1.5);
            }
            g.globalAlpha = 1;
          }
        }
        g.fillStyle = albedo ? "rgba(0,0,0,0.35)" : shift(GROUND, -44);
        g.fillRect(0, y + course - 3, w, 3);
      }
    },
    { roughness: 0.96, roughVariance: 0.04, relief: 2.0 },
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
        // Slow blotches first - a lawn is greener where the ground holds
        // water and paler where it is worn - in colour only, since they are
        // not relief. Then the blades, with far less contrast than they
        // had: strong light-dark speckle at blade scale read as camouflage
        // from the kerb, which is where a lawn is mostly seen from.
        if (albedo) {
          for (let i = 0; i < 24; i++) {
            const r = w * (0.12 + rand() * 0.22);
            const x = rand() * w;
            const y = rand() * h;
            const grad = g.createRadialGradient(x, y, 0, x, y, r);
            grad.addColorStop(0, rand() < 0.5 ? "rgba(255,255,230,0.07)" : "rgba(0,20,0,0.07)");
            grad.addColorStop(1, "rgba(0,0,0,0)");
            g.fillStyle = grad;
            g.beginPath();
            g.arc(x, y, r, 0, Math.PI * 2);
            g.fill();
            // Wrapped copies, so a blotch at the edge continues across the seam.
            for (const [ox, oy] of [[w, 0], [-w, 0], [0, h], [0, -h]] as const) {
              g.beginPath();
              g.arc(x + ox, y + oy, r, 0, Math.PI * 2);
              g.fill();
            }
          }
        } else {
          for (let i = 0; i < 24 * 4; i++) rand();
        }
        for (let i = 0; i < 20000; i++) {
          const x = rand() * w;
          const y = rand() * h;
          g.strokeStyle = paint((rand() - 0.5) * 16, (rand() - 0.5) * 36);
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
