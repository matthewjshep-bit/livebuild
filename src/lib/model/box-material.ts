import type { BoxMaterial } from "@/lib/model/assets";
import type { Box } from "@/lib/model/furniture";

/**
 * What a box is made of, when its builder did not say.
 *
 * Furniture, joinery and fixtures are boxes with a colour, and colour was
 * all a flat material needed. A scanned surface needs to know whether the
 * box is upholstery or veneer, and the kind of piece says that well enough:
 * a sofa is fabric, a wardrobe is wood, a range is steel. A box can still
 * say for itself - a worktop's `finish` already does, and a bed's duvet will
 * once beds have one - and that wins.
 */
export function materialForBox(kind: string, box: Pick<Box, "finish" | "material">): BoxMaterial {
  if (box.material) return box.material;
  // A finish is how a worktop said stainless or stone before there were scans.
  if (box.finish) return box.finish.metalness >= 0.5 ? "metal" : "stone";
  switch (kind) {
    case "sofa":
    case "bed":
      return "fabric";
    case "wardrobe":
    case "media-unit":
    case "coffee-table":
    case "dining-set":
    case "desk":
    case "stairs":
    case "stair":
      return "wood";
    case "counter":
    case "island":
    case "vanity":
    case "cabinet":
      return "paintedWood";
    case "fridge":
    case "range":
    case "hood":
    case "dishwasher":
    case "machines":
    case "car":
      return "metal";
    case "fireplace":
      return "stone";
    case "basin":
    case "wc":
    case "bath":
      return "glass";
    default:
      return "paint";
  }
}
