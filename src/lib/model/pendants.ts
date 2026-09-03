import type { Part } from "@/lib/model/parts";
import { interiorPoint } from "@/lib/model/tessellate";
import { levelBase } from "@/lib/plan/geometry";
import { roomKind } from "@/lib/plan/room-kind";
import type { Plan } from "@/lib/schema";

/**
 * A light fitting in every room, where `Lighting.tsx` already hangs the
 * point light: a ceiling rose, and under it a pendant on a cord in the rooms
 * people sit in, or a flush shade where a cord would be in the way.
 *
 * The lamps lit the rooms from nowhere - a glow with no fitting - and a lit
 * room with nothing to light it is one of the things that reads as unreal
 * without anyone being able to say why. The bulb is the one part that
 * glows: it is what `lit` counts in the readout, apart from `emissive`,
 * which still means "nothing on the model is faking light".
 */

const ROSE: [number, number, number] = [0.14, 0.03, 0.14];
const CORD_DROP = 0.35;
const SHADE: [number, number, number] = [0.32, 0.18, 0.32];
const FLUSH: [number, number, number] = [0.3, 0.08, 0.3];
const BULB: [number, number, number] = [0.06, 0.06, 0.06];
const WHITE = "#f4f4f2";
const CORD = "#2a2a2c";
const SHADE_COLOUR = "#efe9dd";
const BULB_COLOUR = "#fff4d6";

/** Rooms where a pendant hangs; everywhere else the fitting is flush. */
const HUNG = new Set(["living", "dining", "bedroom", "kitchen", "office"]);

export function pendantsFor(plan: Plan, level: number): Part[] {
  const parts: Part[] = [];
  const baseY = levelBase(plan, level);
  for (const room of plan.rooms) {
    if (room.level !== level) continue;
    const kind = roomKind(room.label);
    if (kind === "outside" || kind === "closet") continue;
    const [x, z] = interiorPoint(room.polygon);
    const ceiling = baseY + room.ceilingHeight;
    const at = (y: number, size: [number, number, number], colour: string, part: string): Part => ({
      center: [x, y, z],
      size,
      angleDeg: 0,
      colour,
      part,
    });
    parts.push(at(ceiling - ROSE[1] / 2, ROSE, WHITE, "rose"));
    if (HUNG.has(kind) && room.ceilingHeight >= 2.3) {
      parts.push(at(ceiling - ROSE[1] - CORD_DROP / 2, [0.012, CORD_DROP, 0.012], CORD, "cord"));
      const shadeY = ceiling - ROSE[1] - CORD_DROP - SHADE[1] / 2;
      parts.push(at(shadeY, SHADE, SHADE_COLOUR, "shade"));
      parts.push(at(shadeY - 0.02, BULB, BULB_COLOUR, "bulb"));
    } else {
      parts.push(at(ceiling - ROSE[1] - FLUSH[1] / 2, FLUSH, SHADE_COLOUR, "shade"));
      parts.push(at(ceiling - ROSE[1] - FLUSH[1] + 0.02, BULB, BULB_COLOUR, "bulb"));
    }
  }
  return parts;
}
