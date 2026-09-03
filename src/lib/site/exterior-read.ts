import { sidingFinish } from "@/lib/model/siding";
import { toHex } from "@/lib/model/schemes";
import { RoofShape } from "@/lib/schema";
import { type LandscapeFeature, LandscapeKind, quantiseColour } from "@/lib/spec/schema";

/**
 * The outside as the reader described it, made safe to keep.
 *
 * Pure, so a suite can run it without a photograph. Colours go through the
 * same two steps every read colour does - a CSS name to hex, then quantised
 * so twelve near-identical greys do not become twelve textures. Free text
 * about the siding is kept beside the finish it folds to. The one list the
 * reader returns becomes typed features, with anything it named that the
 * garden cannot build dropped rather than failing the read.
 */

/** What the route returns to the client. */
export type ExteriorRead = {
  siding: { material: string | null; finish: string | null; colour: string | null };
  roof: { shape: RoofShape | null; material: string | null; colour: string | null };
  trim: { colour: string | null };
  door: { colour: string | null };
  features: LandscapeFeature[];
  confidence: "high" | "low";
  notes: string;
};

export type ParsedExterior = {
  sidingMaterial: string;
  sidingColour: string;
  roofShape: string;
  roofMaterial: string;
  roofColour: string;
  trimColour: string;
  doorColour: string;
  contents: Array<{ kind: string; material: string; colour: string; where: string; size: string }>;
  confidence: "high" | "low";
  notes: string;
};

const TREES_MAX = 8;
const SHRUBS_MAX = 12;

const text = (s: string | null | undefined): string | null => {
  const t = (s ?? "").trim();
  return t ? t : null;
};
const colour = (s: string | null | undefined): string | null => quantiseColour(toHex(text(s)));

function side(where: string): LandscapeFeature["side"] {
  const w = where.toLowerCase();
  if (/\bboth\b|either side|each side/.test(w)) return "both";
  if (/\bleft\b/.test(w)) return "left";
  if (/\bright\b/.test(w)) return "right";
  if (/\bfront\b|in front|before/.test(w)) return "front";
  if (/behind|\bback\b|\brear\b/.test(w)) return "back";
  return null;
}

function size(s: string): LandscapeFeature["size"] {
  const t = s.toLowerCase();
  if (/^(s|small|young|low)/.test(t)) return "s";
  if (/^(l|large|big|tall|mature|old)/.test(t)) return "l";
  if (/^(m|medium|mid)/.test(t)) return "m";
  return null;
}

export function reconcileExterior(parsed: ParsedExterior): ExteriorRead {
  const sidingMaterial = text(parsed.sidingMaterial);
  const roofShape = RoofShape.safeParse(parsed.roofShape.trim().toLowerCase());
  const features: LandscapeFeature[] = [];
  let trees = 0;
  let shrubs = 0;
  for (const [i, item] of parsed.contents.entries()) {
    const kind = LandscapeKind.safeParse(item.kind.trim().toLowerCase().replace(/\s+/g, "-"));
    if (!kind.success) continue;
    if (kind.data === "tree" && ++trees > TREES_MAX) continue;
    if (kind.data === "shrub" && ++shrubs > SHRUBS_MAX) continue;
    const where = item.where ?? "";
    features.push({
      id: `outside-${i}`,
      kind: kind.data,
      material: text(item.material),
      colour: colour(item.colour),
      side: side(where),
      alongStreet: /street|road|kerb|curb|pavement|sidewalk|verge/i.test(where),
      size: size(item.size ?? ""),
    });
  }
  return {
    siding: { material: sidingMaterial, finish: sidingFinish(sidingMaterial), colour: colour(parsed.sidingColour) },
    roof: { shape: roofShape.success ? roofShape.data : null, material: text(parsed.roofMaterial), colour: colour(parsed.roofColour) },
    trim: { colour: colour(parsed.trimColour) },
    door: { colour: colour(parsed.doorColour) },
    features,
    confidence: parsed.confidence === "high" ? "high" : "low",
    notes: parsed.notes ?? "",
  };
}
