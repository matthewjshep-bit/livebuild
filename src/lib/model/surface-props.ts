import type { Surface } from "@/lib/model/textures";

/**
 * The material props for a surface, or for a flat colour when there is none.
 *
 * Five copies of this block used to live in the two model files, each
 * saying the same thing: the texture carries the colour so the material is
 * white; the one ORM image is read for occlusion, roughness and metalness;
 * roughness and metalness are 1 so the maps are the whole answer. A bundled
 * scan adds a tint - the read colour over the scan's average - and that is
 * one more thing five copies would each have had to learn.
 */
export function surfaceProps(
  surface: Surface | null | undefined,
  flat: { colour: string; roughness: number; metalness?: number },
  envMapIntensity: number,
) {
  if (!surface) {
    return {
      color: flat.colour,
      roughness: flat.roughness,
      metalness: flat.metalness ?? 0,
      envMapIntensity,
    };
  }
  return {
    color: surface.tint ?? "#ffffff",
    map: surface.map,
    normalMap: surface.normalMap,
    aoMap: surface.ormMap,
    roughnessMap: surface.ormMap,
    metalnessMap: surface.ormMap,
    aoMapIntensity: 0.9,
    roughness: 1,
    metalness: 1,
    envMapIntensity,
  };
}
