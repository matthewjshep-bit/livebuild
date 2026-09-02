"use client";

import { type PackPlan, layoutFromFootprint } from "@/lib/plan/footprint";
import { layoutFromSpec } from "@/lib/plan/autolayout";
import { arrangeRooms } from "@/lib/plan/layout-client";
import { roomKind } from "@/lib/plan/room-kind";
import { M_PER_FT, sqftToM2 } from "@/lib/units";
import type { BuildEvidence } from "@/lib/build/gather";
import type { Plan } from "@/lib/schema";

/**
 * Where the rooms go, when nobody drew them.
 *
 * The whole chain in one place: ask for an arrangement, fall back to the
 * packer, and put the result in plan-space. It ran in two places in the wizard,
 * copied line for line - once inside the build and once behind "suggest a
 * layout" - and the copies had already begun to drift, one reporting the
 * model's reasoning into the build notes and the other silently discarding it.
 *
 * Skipped entirely when a layout was drawn. There is nothing to arrange once
 * somebody has said where the walls are, and asking anyway spends a request to
 * be overruled.
 */
export async function arrangeIntoPlan(
  evidence: Pick<BuildEvidence, "footprint" | "rooms" | "adjacency" | "outside">,
  {
    targetSqft = null,
    onStep,
  }: { targetSqft?: number | null; onStep?: (label: string) => void } = {},
): Promise<{ plan: Plan; notes: string[] }> {
  const { footprint: prepared, rooms, adjacency, outside } = evidence;
  const notes: string[] = [];

  const plans = new Map<number, PackPlan>();
  if (prepared) {
    onStep?.("Arranging the rooms");
    const groundLabels = rooms
      .filter((r) => r.level === 0 && roomKind(r.label) !== "outside")
      .map((r) => r.label);
    const arranged = await arrangeRooms(prepared, groundLabels, adjacency, {
      frontDoorBearing: outside?.frontDoorBearing ?? null,
      garageBearing: outside?.garage?.bearing ?? null,
      planXBearing: 90 + prepared.rotationDeg,
    });
    if (arranged) {
      plans.set(0, arranged.plan);
      if (arranged.reasoning) notes.push(arranged.reasoning);
    }
  }

  const built = prepared
    ? layoutFromFootprint({ rooms }, prepared, adjacency, plans)
    : layoutFromSpec({ rooms }, targetSqft ? sqftToM2(targetSqft) : undefined, adjacency);

  return {
    plan: {
      scaleRef: { px: 1, meters: M_PER_FT },
      rooms: built.rooms,
      openings: built.openings,
    },
    notes,
  };
}
