"use client";

import type { Footprint, PackPlan } from "@/lib/plan/footprint";
import { validatePackPlan } from "@/lib/plan/footprint";
import { typicalSize } from "@/lib/plan/autolayout";
import { M_PER_FT } from "@/lib/units";

/**
 * Ask for an arrangement of the rooms, and take it only if it holds up.
 *
 * The packer's fallback is a real answer, not an error path - it fills the
 * outline exactly and always has. So everything here fails soft: no key, a
 * refusal, a timeout, or an arrangement that does not validate all end the same
 * way, with the packer doing what it did before.
 */

/** The smallest a room may be, mirrored from `footprint.ts` so the limits sent
 *  to the model are the ones it will actually be judged against. */
const MIN_ROOM_M = 2.1;

export async function arrangeRooms(
  footprint: Footprint,
  labels: string[],
  adjacency: Array<[string, string]>,
  facing: {
    frontDoorBearing?: number | null;
    garageBearing?: number | null;
    planXBearing: number;
  },
): Promise<{ plan: PackPlan; reasoning: string } | null> {
  // One rectangle and one room is not an arrangement, and neither is a house
  // with nowhere to make a choice.
  if (labels.length < 3 || footprint.rects.length === 0) return null;

  const rects = footprint.rects.map((r) => {
    const width = r.x1 - r.x0;
    const depth = r.y1 - r.y0;
    return {
      widthFt: width / M_PER_FT,
      depthFt: depth / M_PER_FT,
      maxRows: Math.max(1, Math.floor(depth / MIN_ROOM_M)),
      maxPerRow: Math.max(1, Math.floor(width / MIN_ROOM_M)),
    };
  });

  const rooms = labels.map((label) => {
    const [w, h] = typicalSize(label);
    return { label, wantsSqft: (w * h) / (M_PER_FT * M_PER_FT) };
  });

  try {
    const response = await fetch("/api/layout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rects, rooms, adjacency, ...facing }),
    });
    if (!response.ok) return null;

    const data = await response.json();
    const plan: PackPlan = { rows: (data.rows ?? []) as number[][][] };

    // Checked here as well as inside the packer, so a rejected arrangement is
    // something the build can report rather than something that silently did
    // not happen.
    if (!validatePackPlan(plan, labels, footprint.rects)) return null;

    return { plan, reasoning: typeof data.reasoning === "string" ? data.reasoning : "" };
  } catch {
    return null;
  }
}
