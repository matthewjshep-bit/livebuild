import { boundsOf } from "@/lib/plan/autolayout";
import { levelBase } from "@/lib/plan/geometry";
import { roomKind } from "@/lib/plan/room-kind";
import type { Plan } from "@/lib/schema";
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
};

/** Two seconds is about the floor for "the viewer understood what changed". */
const ROOM_MS = 2600;
const ORBIT_MS = 3400;

/** Standing height for the interior beats. A little above a walker's eye, so
 *  the shot reads as composed rather than as somebody's head. */
const EYE_M = 1.62;

/** How far off the end wall the camera stands. Any closer and the near wall
 *  fills the frame; any further and a small room is left behind you. */
const STAND_OFF_M = 0.85;

/** Rooms nobody opens a tour with. */
const SKIP = new Set(["closet", "outside", "stairs", "hallway"]);

export function buildTour(plan: Plan, label: string): Beat[] {
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

    const caption = `${room.label} · ${formatArea(area, "ft")}`;

    // Stand in the room and look down its length.
    //
    // This used to be an overhead look-in, and standing inside a room was
    // reserved for rooms that had been photographed - because an extrusion in
    // flat colour had nothing to show at eye level and a photograph did. The
    // model is what is being shown now, so every room gets the shot that was
    // previously the reward for having a picture: at head height, backed up
    // against the short end, looking the way somebody walking in would look.
    const wide = b.x1 - b.x0 >= b.y1 - b.y0;
    const eye = base + EYE_M;
    const from: [number, number, number] = wide
      ? [b.x0 + STAND_OFF_M, eye, ry]
      : [rx, eye, b.y0 + STAND_OFF_M];

    beats.push({
      ms: ROOM_MS,
      from,
      // Slightly below eye level: a camera aimed dead level at the far wall
      // shows mostly wall, and tipping it down brings the floor and whatever
      // is standing on it into the frame.
      at: [rx, eye - 0.22, ry],
      caption,
    });
  }

  return beats;
}

/** Total running time, so the UI can say how long a recording will be. */
export function tourDuration(beats: Beat[]): number {
  return beats.reduce((sum, beat) => sum + beat.ms, 0);
}
