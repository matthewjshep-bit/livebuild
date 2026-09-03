/**
 * The bundled texture sets: what each is, where it came from, and how big it is.
 *
 * Every surface in the house was drawn into a canvas at runtime - planks,
 * grout, grain - which kept the tour free of downloads and licences, and
 * kept it looking like a drawing of a surface rather than a surface. A
 * scanned photograph of real oak is what the difference between "textured"
 * and "real" mostly is, and Poly Haven publishes exactly that under CC0:
 * colour, normal and occlusion-roughness-metalness maps, scanned from the
 * material itself, free to use with no attribution owed.
 *
 * They are shipped under `public/`, fetched once by `tools/fetch-assets.ts`
 * from this table and never at runtime from anyone else's server. The rule
 * that matters is unchanged: no photograph *of this house* is ever on the
 * model. `SceneReadout` tells a bundled map from anything else by its path.
 *
 * `metresPerTile` is how much of the world one repeat of the scan covers. It
 * is the number that makes a board a board's width and a tile a tile's, and
 * it is read off the scan rather than guessed: Poly Haven lists the physical
 * size of each.
 */
export type AssetKey =
  | "floor-wood"
  | "floor-laminate"
  | "floor-tile"
  | "floor-stone"
  | "floor-carpet"
  | "floor-concrete"
  | "wall-paint"
  | "wall-plaster"
  | "wall-brick"
  | "wall-tile"
  | "wall-panelling"
  | "wall-timber"
  | "siding-lap"
  | "siding-wood"
  | "siding-brick"
  | "siding-stucco"
  | "roof-shingle"
  | "roof-tile"
  | "roof-slate"
  | "ground-asphalt"
  | "ground-concrete"
  | "ground-gravel"
  | "fabric-linen"
  | "leather"
  | "wood-veneer"
  | "bark";

export type Asset = {
  /** Poly Haven's id, which is also the download path. */
  source: string;
  /** Metres of world one repeat covers. */
  metresPerTile: number;
  licence: "CC0";
};

export const ASSETS: Record<AssetKey, Asset> = {
  "floor-wood": { source: "wood_floor", metresPerTile: 2, licence: "CC0" },
  "floor-laminate": { source: "laminate_floor_02", metresPerTile: 2, licence: "CC0" },
  "floor-tile": { source: "large_floor_tiles_02", metresPerTile: 2, licence: "CC0" },
  "floor-stone": { source: "slate_floor_02", metresPerTile: 2, licence: "CC0" },
  "floor-carpet": { source: "poly_wool_herringbone", metresPerTile: 0.6, licence: "CC0" },
  "floor-concrete": { source: "concrete_floor_02", metresPerTile: 2, licence: "CC0" },
  "wall-paint": { source: "beige_wall_001", metresPerTile: 2, licence: "CC0" },
  "wall-plaster": { source: "plastered_wall_02", metresPerTile: 2, licence: "CC0" },
  "wall-brick": { source: "brick_wall_02", metresPerTile: 2, licence: "CC0" },
  "wall-tile": { source: "long_white_tiles", metresPerTile: 1, licence: "CC0" },
  "wall-panelling": { source: "white_planks_clean", metresPerTile: 1.5, licence: "CC0" },
  "wall-timber": { source: "wood_planks", metresPerTile: 1.5, licence: "CC0" },
  "siding-lap": { source: "exterior_wall_cladding_03", metresPerTile: 1.5, licence: "CC0" },
  "siding-wood": { source: "weathered_plank_siding", metresPerTile: 1.5, licence: "CC0" },
  "siding-brick": { source: "exterior_wall_cladding_02", metresPerTile: 1.5, licence: "CC0" },
  "siding-stucco": { source: "white_stucco", metresPerTile: 2, licence: "CC0" },
  "roof-shingle": { source: "grey_roof_01", metresPerTile: 2, licence: "CC0" },
  "roof-tile": { source: "clay_roof_tiles", metresPerTile: 2, licence: "CC0" },
  "roof-slate": { source: "roof_slates_02", metresPerTile: 2, licence: "CC0" },
  "ground-asphalt": { source: "asphalt_02", metresPerTile: 3, licence: "CC0" },
  "ground-concrete": { source: "concrete_pavement_02", metresPerTile: 2, licence: "CC0" },
  "ground-gravel": { source: "gravel_floor", metresPerTile: 1.5, licence: "CC0" },
  "fabric-linen": { source: "rough_linen", metresPerTile: 0.5, licence: "CC0" },
  leather: { source: "brown_leather", metresPerTile: 0.6, licence: "CC0" },
  "wood-veneer": { source: "black_walnut_veneer_01", metresPerTile: 1, licence: "CC0" },
  bark: { source: "bark_brown_02", metresPerTile: 1, licence: "CC0" },
};

/** The one sky for a house that has no site, and so no sun to draw one from. */
export const SKY_ASSET = { source: "kloofendal_48d_partly_cloudy_puresky", licence: "CC0" as const };

/** Where a set's three maps live once fetched, relative to the site root. */
export function assetPaths(key: AssetKey): { color: string; normal: string; orm: string } {
  return {
    color: `/textures/${key}/color.jpg`,
    normal: `/textures/${key}/normal.jpg`,
    orm: `/textures/${key}/orm.jpg`,
  };
}

export const SKY_PATH = "/sky/studio.hdr";

/** True for a texture image the app shipped itself. */
export function isBundledUrl(url: string, origin: string): boolean {
  if (!url.startsWith(origin)) return false;
  const path = url.slice(origin.length);
  return path.startsWith("/textures/") || path.startsWith("/sky/");
}

/* ------------------------------------------------------- which set is which */

/**
 * What a furnished thing is made of, coarsely. A box says this and the
 * surface gate picks the scan; the colour the reader gave it tints the scan.
 */
export type BoxMaterial = "fabric" | "leather" | "wood" | "paintedWood" | "metal" | "stone" | "glass" | "paint";

/**
 * Null for grass: Poly Haven scans meadows and verges, not mown lawns, and
 * tinted to a lawn green they came out orange. The drawn grass stays.
 */
export function assetForFloor(finish: string | null | undefined): AssetKey | null {
  const f = (finish ?? "").toLowerCase();
  if (/laminate|vinyl|lvp|lvt/.test(f)) return "floor-laminate";
  if (/tile|ceramic|porcelain/.test(f)) return "floor-tile";
  if (/stone|slate|marble|granite|flag/.test(f)) return "floor-stone";
  if (/carpet|rug/.test(f)) return "floor-carpet";
  if (/concrete|screed/.test(f)) return "floor-concrete";
  if (/grass|lawn|turf/.test(f)) return null;
  return "floor-wood";
}

export function assetForWall(material: string | null | undefined): AssetKey {
  const m = (material ?? "").toLowerCase();
  if (/brick|masonry/.test(m)) return "wall-brick";
  if (/tile/.test(m)) return "wall-tile";
  if (/panel|wainscot|shiplap|beadboard/.test(m)) return "wall-panelling";
  if (/timber|wood|log|cedar|pine/.test(m)) return "wall-timber";
  if (/wallpaper|plaster|render/.test(m)) return "wall-plaster";
  return "wall-paint";
}

export function assetForSiding(finish: string | null | undefined): AssetKey {
  switch (finish) {
    case "brick":
      return "siding-brick";
    case "stucco":
      return "siding-stucco";
    case "shingle":
    case "board-and-batten":
      return "siding-wood";
    default:
      return "siding-lap";
  }
}

export function assetForRoof(material: string | null | undefined): AssetKey {
  const m = (material ?? "").toLowerCase();
  if (/tile|clay|terracotta|pantile|concrete/.test(m)) return "roof-tile";
  if (/slate|metal|standing|steel|tin/.test(m)) return "roof-slate";
  return "roof-shingle";
}

/** Null means the box stays a flat finish: steel and glass are not scans. */
export function assetForBox(material: BoxMaterial | null | undefined): AssetKey | null {
  switch (material) {
    case "fabric":
      return "fabric-linen";
    case "leather":
      return "leather";
    case "wood":
      return "wood-veneer";
    case "paintedWood":
    case "paint":
      return "wall-paint";
    case "stone":
      return "floor-stone";
    default:
      return null;
  }
}
