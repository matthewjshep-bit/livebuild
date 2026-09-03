import { useSyncExternalStore } from "react";
import * as THREE from "three";

import { ASSETS, type AssetKey, assetPaths } from "@/lib/model/assets";
import type { Surface } from "@/lib/model/textures";
import { type Rgb, meanOfPixels, tintFor } from "@/lib/model/tint";

/**
 * The bundled scans, as surfaces.
 *
 * Progressive, and synchronous to ask. A caller asks for a surface and gets
 * either the loaded one or null - and null is the cue to use the procedural
 * surface, which is drawn in a few milliseconds and is what the house has
 * always worn. The first ask for a set starts its load; when it lands the
 * version ticks and anything subscribed rebuilds with the scan in place. So
 * a house opens as fast as it ever did and dresses itself as the sets arrive.
 *
 * One upload per set, however many surfaces wear it. A texture is cloned per
 * repeat scale - a floor's UVs cover two metres per tile and a wall's 2.4 -
 * and three shares the image between clones, so the clone is a few bytes of
 * state and not a second copy on the GPU.
 *
 * Off until the viewer says the tier can afford it. A phone never loads
 * these, and the procedural surfaces are what it gets.
 */

type Loaded = { color: THREE.Texture; normal: THREE.Texture; orm: THREE.Texture; mean: Rgb };

const loaded = new Map<AssetKey, Loaded>();
const loading = new Set<AssetKey>();
const failed = new Set<AssetKey>();
const variants = new Map<string, Surface>();
const listeners = new Set<() => void>();
let version = 0;
let enabled = false;
let anisotropy = 8;

function notify() {
  version++;
  for (const fn of listeners) fn();
}

/** Whether the scans are loaded at all. Set from the quality tier. */
export function enableAssets(on: boolean, maxAnisotropy = 8): void {
  anisotropy = maxAnisotropy;
  if (enabled === on) return;
  enabled = on;
  notify();
}

export function assetsEnabled(): boolean {
  return enabled;
}

/** Sets whose load has started and not finished. */
export function pendingAssets(): number {
  return loading.size;
}

export function bundledAssets(): number {
  return loaded.size;
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** Re-renders the caller whenever a set lands, so a memo can rebuild with it. */
export function useAssetsVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
}

const loader = typeof document === "undefined" ? null : new THREE.TextureLoader();

function loadTexture(url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    if (!loader) return reject(new Error("no document"));
    loader.load(url, resolve, undefined, () => reject(new Error(`could not load ${url}`)));
  });
}

/** The scan's average colour, off a small copy of it. */
function meanOf(texture: THREE.Texture): Rgb {
  try {
    const image = texture.image as HTMLImageElement;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 16;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    if (!g) return [0.5, 0.5, 0.5];
    g.drawImage(image, 0, 0, 16, 16);
    return meanOfPixels(g.getImageData(0, 0, 16, 16).data);
  } catch {
    return [0.5, 0.5, 0.5];
  }
}

function prepare(texture: THREE.Texture, colour: boolean): THREE.Texture {
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = anisotropy;
  texture.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  // How the readout tells a bundled scan from a photograph of the house.
  texture.userData.bundled = true;
  texture.needsUpdate = true;
  return texture;
}

function startLoad(key: AssetKey): void {
  if (loaded.has(key) || loading.has(key) || failed.has(key) || !loader) return;
  loading.add(key);
  const paths = assetPaths(key);
  Promise.all([loadTexture(paths.color), loadTexture(paths.normal), loadTexture(paths.orm)])
    .then(([color, normal, orm]) => {
      loaded.set(key, {
        color: prepare(color, true),
        normal: prepare(normal, false),
        orm: prepare(orm, false),
        mean: meanOf(color),
      });
    })
    .catch(() => {
      // Left procedural, for good. The suites that ship the sets would
      // have failed before this could; in the wild it is a missing deploy.
      failed.add(key);
    })
    .finally(() => {
      loading.delete(key);
      notify();
    });
}

function withRepeat(texture: THREE.Texture, repeat: number): THREE.Texture {
  const clone = texture.clone();
  clone.repeat.set(repeat, repeat);
  clone.userData.bundled = true;
  clone.needsUpdate = true;
  return clone;
}

/**
 * The surface for a set, at a UV scale, in a colour - or null, meaning "not
 * yet" or "not on this tier", and either way "use the procedural one".
 *
 * `uvMetres` is what one UV unit spans in the world on the geometry this
 * will dress, which `applyWorldUvs` decided; the repeat is that over the
 * scan's own coverage, so a plank is a plank's width whatever the UVs.
 */
export function assetSurface(key: AssetKey, uvMetres: number, tone: string | null | undefined): Surface | null {
  if (!enabled) return null;
  const set = loaded.get(key);
  if (!set) {
    startLoad(key);
    return null;
  }
  const id = `${key}|${uvMetres}|${tone ?? ""}`;
  const hit = variants.get(id);
  if (hit) return hit;
  const repeat = uvMetres / ASSETS[key].metresPerTile;
  const surface: Surface = {
    map: withRepeat(set.color, repeat),
    normalMap: withRepeat(set.normal, repeat),
    ormMap: withRepeat(set.orm, repeat),
    tint: tintFor(set.mean, tone),
    bundled: true,
  };
  variants.set(id, surface);
  return surface;
}
