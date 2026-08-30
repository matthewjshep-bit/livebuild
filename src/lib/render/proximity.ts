import type { TourNode } from "@/lib/schema";

/**
 * How solid a photograph is when the camera is free rather than parked in it.
 *
 * A shell is a depth-displaced projection taken from one point, so it is only
 * honest near that point. `parallaxBudget` says how near: "how far the camera
 * may drift before the 2.5D shell's tearing at depth discontinuities becomes
 * visible". That is not a cautious estimate. Walking a demo room and screenshot-
 * ting the approach, a shell viewed from 1.5m off its node fills the frame with
 * a smeared close-up of nothing - the angular error goes as the offset over the
 * scene depth, so a metre and a half inside a five-metre room is a third of the
 * picture wrong. From the node itself the same shell is crisp.
 *
 * So the reach is small and deliberately so: solid within the budget, gone
 * shortly after it, and the built model the rest of the time. Walking the house
 * resolves into real photography exactly where there is a photograph to resolve
 * into, and does not pretend anywhere else.
 */
export const WALK_REACH_M = 1.1;

/**
 * The scripted tour gets further, because it is flying straight at the
 * viewpoint and will arrive dead centre. The approach can afford to dissolve
 * rather than cut, and at that speed the tearing reads as the dissolve it is
 * standing in for - which is not true of a walker, who can stop and look.
 */
export const TOUR_REACH_M = 4.5;

/** Mounted from further out than it is ever shown from; a texture takes long
 *  enough to decode that it has to be warm by the time the fade starts. */
export const SHELL_MOUNT_M = 4.5;

/** Where a node's lens was, in three.js world coordinates. */
export function nodeEye(
  node: Pick<TourNode, "position" | "eyeHeight">,
  baseY: number,
): [number, number, number] {
  return [node.position[0], baseY + node.eyeHeight, node.position[1]];
}

/**
 * A shell's opacity from where the camera actually is.
 *
 * Measured in three dimensions on purpose: a walker one storey up is three
 * metres from a ground-floor viewpoint whatever the plan says, so the height
 * difference excludes it without a separate level test.
 */
export function shellProximity(
  node: Pick<TourNode, "position" | "eyeHeight" | "parallaxBudget">,
  baseY: number,
  camera: { x: number; y: number; z: number },
  reach: number,
): number {
  const [x, y, z] = nodeEye(node, baseY);
  const distance = Math.hypot(camera.x - x, camera.y - y, camera.z - z);
  const solid = node.parallaxBudget;
  // A node with a generous budget has earned a wider fade than the floor.
  const gone = Math.max(reach, solid * 2.5);
  if (distance >= gone) return 0;
  if (distance <= solid) return 1;
  return 1 - (distance - solid) / (gone - solid);
}
