"use client";


import { getMedia, refToKey } from "@/lib/media-store";
import { boundsOf } from "@/lib/plan/geometry";
import type { Plan, Room, TourNode, Vec2 } from "@/lib/schema";
import { M_PER_FT } from "@/lib/units";

/**
 * Place each photo where it was actually taken from.
 *
 * The fallback placement - a corner facing the room's centre - is a reasonable
 * description of how listing photos are shot and wrong often enough to matter.
 * This asks what the photo itself shows, anchored by the room's dimensions and
 * doorway positions, and only overrides the fallback when the answer is
 * confident. A confidently wrong pose points the tour at a wall; a low-confidence
 * one is worse than the heuristic it would replace.
 */

const POSE_EDGE = 768;
const POSE_BATCH = 4;

async function thumbnail(blob: Blob): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, POSE_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL("image/jpeg", 0.72);
  } catch {
    return null;
  }
}

/** Which walls of a room have a doorway, named so the model can use them. */
function doorwayWalls(plan: Plan, room: Room): string[] {
  const b = boundsOf(room.polygon);
  const walls = new Set<string>();
  const tolerance = 0.2;

  for (const opening of plan.openings) {
    if (!opening.between.includes(room.id)) continue;
    const [x, y] = opening.at;
    if (Math.abs(y - b.y0) < tolerance) walls.add("north");
    else if (Math.abs(y - b.y1) < tolerance) walls.add("south");
    else if (Math.abs(x - b.x0) < tolerance) walls.add("west");
    else if (Math.abs(x - b.x1) < tolerance) walls.add("east");
  }

  return [...walls];
}

/**
 * A *room-frame* compass heading (0 = north, 90 = east) to the app's own
 * convention (0 = plan +y, 90 = plan +x).
 *
 * The two differ by a reflection, not an offset: north is *decreasing* y on a
 * plan drawn with y downward, while the app measures from increasing y. Adding
 * 180 gets north and south right and leaves east and west swapped, which points
 * half the photos at the wrong wall while looking plausible on the other half.
 *
 * **This is not a true-compass converter, despite reading like one.** The
 * "north" it takes is the room's own `y0` wall - the pseudo-compass `/api/pose`
 * describes a room in, matching `doorwayWalls` above - and the formula is the
 * general one with the plan's bearing pinned at 90. A real compass bearing put
 * through it is wrong by exactly the angle the footprint was rotated to square
 * it up, which is 78 degrees on one of the test fixtures: enough to put a
 * building's front door on the wrong side of it. For a real bearing use
 * `planFromBearing` in `model/sun.ts`, which is given the site and knows.
 */
export function compassToPlanHeading(compassDeg: number): number {
  return ((180 - compassDeg) % 360 + 360) % 360;
}

export type PoseResult = {
  id: string;
  u: number;
  v: number;
  headingDeg: number;
  fovDeg: number;
  doorwayVisible: boolean;
  confidence: "high" | "low";
};

/**
 * Refine node placement from the photos themselves.
 *
 * Returns the nodes with better poses applied where the answer was confident,
 * plus how many were actually changed - which is worth reporting, since "we
 * looked and the heuristic was already right" and "we could not tell" are
 * different outcomes that look identical in the result.
 */
export async function refinePoses(
  plan: Plan,
  nodes: TourNode[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ nodes: TourNode[]; refined: number; uncertain: number }> {
  const byRoom = new Map(plan.rooms.map((r) => [r.id, r]));
  const jobs: Array<{ node: TourNode; room: Room; blob: Blob }> = [];

  for (const node of nodes) {
    const room = byRoom.get(node.roomId);
    if (!room) continue;
    const blob = await getMedia(refToKey(node.photo));
    if (blob) jobs.push({ node, room, blob });
  }

  const poses = new Map<string, PoseResult>();

  for (let i = 0; i < jobs.length; i += POSE_BATCH) {
    const batch = jobs.slice(i, i + POSE_BATCH);

    const photos = (
      await Promise.all(
        batch.map(async ({ node, room, blob }) => {
          const dataUrl = await thumbnail(blob);
          if (!dataUrl) return null;
          const b = boundsOf(room.polygon);
          return {
            id: node.id,
            dataUrl,
            room: room.label,
            widthFt: (b.x1 - b.x0) / M_PER_FT,
            depthFt: (b.y1 - b.y0) / M_PER_FT,
            doorways: doorwayWalls(plan, room),
          };
        }),
      )
    ).filter(Boolean);

    if (photos.length > 0) {
      try {
        const response = await fetch("/api/pose", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ photos }),
        });
        if (response.ok) {
          const data = await response.json();
          for (const pose of data.poses ?? []) poses.set(pose.id, pose);
        }
      } catch {
        // A failed batch keeps its heuristic placement, which is still usable.
      }
    }

    onProgress?.(Math.min(i + POSE_BATCH, jobs.length), jobs.length);
  }

  let refined = 0;
  let uncertain = 0;

  const updated = nodes.map((node) => {
    const pose = poses.get(node.id);
    const room = byRoom.get(node.roomId);
    if (!pose || !room) return node;

    if (pose.confidence === "low") {
      uncertain += 1;
      // Keep the heuristic. It is at least predictable, and a guess the model
      // itself doubts is not an improvement on it.
      return node;
    }

    const b = boundsOf(room.polygon);
    const position: Vec2 = [
      b.x0 + (b.x1 - b.x0) * pose.u,
      b.y0 + (b.y1 - b.y0) * pose.v,
    ];

    refined += 1;
    return {
      ...node,
      position,
      heading: compassToPlanHeading(pose.headingDeg),
      fovDeg: pose.fovDeg,
    };
  });

  return { nodes: updated, refined, uncertain };
}
