import type { Exterior } from "@/lib/schema";
import type { HouseSpec } from "@/lib/spec/schema";

/**
 * What the outside looks like, from whichever source saw it best.
 *
 * Three sources can describe the outside: the owner's photographs of it, the
 * map service's imagery of it, and a colour scheme. For appearance the
 * photographs win - they show the actual siding under actual light - then
 * the imagery, then nothing, which the scheme fills. Geometry is not decided
 * here: the footprint, the streets and the ridge bearing are survey data and
 * stay the map's. The one exception is the roof's *shape*, which a front
 * photograph shows better than a satellite tile does, and which fills in
 * only where the map had none.
 */
export type ExteriorLook = {
  wallMaterial: string | null;
  wallColour: string | null;
  roofShape: string | null;
  roofMaterial: string | null;
  roofColour: string | null;
  trimColour: string | null;
  doorColour: string | null;
  /** Whether any of it came from a photograph. */
  photographed: boolean;
};

export function exteriorLook(spec: HouseSpec | null | undefined, exterior: Exterior | null | undefined): ExteriorLook {
  const seen = spec?.exterior ?? null;
  return {
    wallMaterial: seen?.siding?.material ?? exterior?.walls?.material ?? null,
    wallColour: seen?.siding?.colour ?? exterior?.walls?.colour ?? null,
    roofShape: exterior?.roof?.shape ?? seen?.roof?.shape ?? null,
    roofMaterial: seen?.roof?.material ?? exterior?.roof?.material ?? null,
    roofColour: seen?.roof?.colour ?? exterior?.roof?.colour ?? null,
    trimColour: seen?.trim?.colour ?? null,
    doorColour: seen?.door?.colour ?? null,
    photographed: Boolean(seen?.observed),
  };
}
