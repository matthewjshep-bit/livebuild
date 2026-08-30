import { boundsOf } from "@/lib/plan/autolayout";
import { headingToPlanDir, levelBase } from "@/lib/plan/geometry";
import { roomKind } from "@/lib/plan/room-kind";
import type { Plan, TourNode } from "@/lib/schema";
import { formatArea } from "@/lib/units";

/**
 * A walkthrough that writes itself.
 *
 * The tour this is modelled on is hand-authored: eighteen seconds of beats
 * written for one particular house, with the camera positions typed in. That
 * cannot work here, because no two houses this tool builds are the same and
 * nobody is going to script each one.
 *
 * So the beats are derived, like the doorways and the walk graph before them.
 * An establishing orbit to show the shape, then the rooms in descending order
 * of size, which is very nearly the order an agent would show them in - the
 * living room before the third bedroom, and the airing cupboard not at all.
 */

export type Beat = {
  /** How long this beat lasts, in milliseconds. */
  ms: number;
  /** Where the camera ends up, and what it is looking at. */
  from: [number, number, number];
  at: [number, number, number];
  caption: string;
  /**
   * The viewpoint this beat stands in, when the room has one.
   *
   * A beat that names a node is a beat the camera parks exactly where a
   * photograph was taken, which is the only place that photograph can be shown
   * without tearing. It is what puts photography in the recorded film at all -
   * without it the tour is an orbit of an extruded model, however good that
   * model is.
   */
  nodeId?: string;
};

/** Two seconds is about the floor for "the viewer understood what changed". */
const ROOM_MS = 2600;
const ORBIT_MS = 3400;

/** How far ahead of a viewpoint the camera looks. Far enough that the arc has a
 *  radius to interpolate, near enough to stay inside the room. */
const LOOK_AHEAD_M = 3;

/** Rooms nobody opens a tour with. */
const SKIP = new Set(["closet", "outside", "stairs", "hallway"]);

export function buildTour(plan: Plan, label: string, nodes: TourNode[] = []): Beat[] {
  const level = Math.min(...plan.rooms.map((r) => r.level));
  const ground = plan.rooms.filter((r) => r.level === level);
  if (ground.length === 0) return [];

  const all = boundsOf(ground.flatMap((r) => r.polygon));
  const cx = (all.x0 + all.x1) / 2;
  const cy = (all.y0 + all.y1) / 2;
  const span = Math.max(all.x1 - all.x0, all.y1 - all.y0);
  const base = levelBase(plan, level);

  const beats: Beat[] = [];

  // Two establishing shots from opposite corners. One orbit position tells you
  // the footprint; two tell you it is a building.
  for (const [i, angle] of [-0.7, 1.9].entries()) {
    beats.push({
      ms: ORBIT_MS,
      from: [
        cx + Math.cos(angle) * span * 1.15,
        base + span * 0.75,
        cy + Math.sin(angle) * span * 1.15,
      ],
      at: [cx, base + 1, cy],
      caption: i === 0 ? label : `${ground.length} rooms`,
    });
  }

  const rooms = ground
    .filter((room) => !SKIP.has(roomKind(room.label)))
    .map((room) => {
      const b = boundsOf(room.polygon);
      return { room, b, area: (b.x1 - b.x0) * (b.y1 - b.y0) };
    })
    .sort((a, z) => z.area - a.area)
    .slice(0, 6);

  for (const { room, b, area } of rooms) {
    const rx = (b.x0 + b.x1) / 2;
    const ry = (b.y0 + b.y1) / 2;
    const reach = Math.max(b.x1 - b.x0, b.y1 - b.y0);
    const caption = `${room.label} · ${formatArea(area, "ft")}`;

    // Stand in the photograph when the room has one.
    //
    // A room that was photographed has something better to show than its own
    // extrusion, and the only place that photograph holds together is the spot
    // it was taken from - so the beat goes there and looks the way the lens
    // looked. A room with no photograph keeps the overhead look-in, which is
    // why a house built from an address alone still plays as a tour.
    const node = viewpointFor(nodes, room.id);
    if (node) {
      const eye = base + node.eyeHeight;
      const [dx, dy] = headingToPlanDir(node.heading);
      beats.push({
        ms: ROOM_MS,
        from: [node.position[0], eye, node.position[1]],
        at: [
          node.position[0] + dx * LOOK_AHEAD_M,
          eye,
          node.position[1] + dy * LOOK_AHEAD_M,
        ],
        caption,
        nodeId: node.id,
      });
      continue;
    }

    beats.push({
      ms: ROOM_MS,
      // Above and to one side, looking down into the room. Close enough that
      // the room fills the frame, high enough to see over its own walls -
      // there is no roof in this view, so this reads as looking in.
      from: [rx + reach * 0.85, base + reach * 0.95, ry + reach * 0.85],
      at: [rx, base + 0.9, ry],
      caption,
    });
  }

  return beats;
}

/**
 * The viewpoint worth standing in, out of a room's photographs.
 *
 * One with a depth map wins: it renders as a 2.5D shell the camera can hold
 * still inside, whereas a flat billboard is a picture hung in the air and looks
 * like one the moment anything moves.
 */
function viewpointFor(nodes: TourNode[], roomId: string): TourNode | null {
  const inRoom = nodes.filter((n) => n.roomId === roomId && n.photo);
  return inRoom.find((n) => n.depth) ?? inRoom[0] ?? null;
}

/** Total running time, so the UI can say how long a recording will be. */
export function tourDuration(beats: Beat[]): number {
  return beats.reduce((sum, beat) => sum + beat.ms, 0);
}
