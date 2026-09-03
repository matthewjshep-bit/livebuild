import { roomAt } from "@/lib/model/collide";
import type { Plan, Vec2 } from "@/lib/schema";

/**
 * The way from here to there, on foot, through the doors.
 *
 * Clicking a spot in another room should walk you there the way a person
 * would - through the doorways - not slide you along the wall between. The
 * plan already knows every doorway (`plan.openings`), so this is a search
 * over rooms with doors as the edges, and the waypoints it returns are the
 * doorways' own positions, then the spot asked for. Stairs are not doors: a
 * route never changes storey.
 *
 * Null when either end is outside every room, or no chain of doors joins
 * them; the walker then stays put, which is better than a guess.
 */
export function routeTo(plan: Plan, level: number, from: Vec2, to: Vec2): Vec2[] | null {
  const start = roomAt(plan, level, from[0], from[1]);
  const goal = roomAt(plan, level, to[0], to[1]);
  if (!start || !goal) return null;
  if (start.id === goal.id) return [to];

  const onLevel = new Set(plan.rooms.filter((r) => r.level === level).map((r) => r.id));
  const doors = plan.openings.filter(
    (o) => o.kind !== "stairs" && onLevel.has(o.between[0]) && onLevel.has(o.between[1]),
  );

  // Breadth first: the fewest doorways is the route a person takes.
  const cameFrom = new Map<string, { room: string; through: Vec2 } | null>([[start.id, null]]);
  const queue = [start.id];
  while (queue.length > 0) {
    const room = queue.shift()!;
    if (room === goal.id) break;
    for (const door of doors) {
      const next = door.between[0] === room ? door.between[1] : door.between[1] === room ? door.between[0] : null;
      if (!next || cameFrom.has(next)) continue;
      cameFrom.set(next, { room, through: door.at });
      queue.push(next);
    }
  }
  if (!cameFrom.has(goal.id)) return null;

  const waypoints: Vec2[] = [];
  let at: string = goal.id;
  while (at !== start.id) {
    const step: { room: string; through: Vec2 } | null | undefined = cameFrom.get(at);
    if (!step) break;
    waypoints.unshift(step.through);
    at = step.room;
  }
  waypoints.push(to);
  return waypoints;
}
