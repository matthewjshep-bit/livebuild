import { dist, roomAdjacency } from "@/lib/plan/geometry";
import type { Plan, TourNode } from "@/lib/schema";

/** Within a room, a node links to at most this many neighbours. */
const MAX_SAME_ROOM_LINKS = 3;

/**
 * Derive the walk graph from geometry rather than making the user wire it up.
 *
 * MLS sets give roughly two to four photos per room, so the useful structure is
 * simply "the nearest few in here, plus the closest way into each neighbouring
 * room". Links are only ever created within a room or across a doorway, which
 * is what keeps a step from cutting through a wall.
 *
 * Any `neighbors` already present on a node are preserved — hand-authored links
 * beat inferred ones, since the editor lets the user fix cases this misses.
 */
/**
 * Which photo-bearing rooms can be reached from `start`, walking through rooms
 * that have no photos of their own.
 *
 * This is what makes an empty hallway useful rather than an obstruction. A
 * hallway is usually the thing joining the rooms people photograph, and it is
 * often not photographed itself - so treating "no photos" as "no way through"
 * would sever exactly the connections the hallway exists to make.
 *
 * Stairs are just another way through, so this crosses storeys wherever one
 * exists.
 */
function reachableRoomsWithNodes(
  start: string,
  adjacency: Map<string, Set<string>>,
  hasNodes: Set<string>,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>([start]);
  const queue = [start];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      if (hasNodes.has(next)) found.push(next);
      // Only pass *through* empty rooms; a room with photos is a destination,
      // not a corridor, or every room would end up linked to every other.
      else queue.push(next);
    }
  }

  return found;
}

/**
 * Derive the walk graph from geometry rather than making the user wire it up.
 *
 * MLS sets give roughly two to four photos per room, so the useful structure is
 * "the nearest few in here, plus the closest way into each room I can actually
 * get to". Links only ever follow doorways and stairs, which is what keeps a
 * step from cutting through a wall or a floor.
 *
 * Any `neighbors` already present on a node are preserved - hand-authored links
 * beat inferred ones, since the editor lets the user fix cases this misses.
 */
export function buildWalkGraph(plan: Plan, nodes: TourNode[]): TourNode[] {
  const adjacency = roomAdjacency(plan);
  const byRoom = new Map<string, TourNode[]>();
  for (const n of nodes) {
    const list = byRoom.get(n.roomId);
    if (list) list.push(n);
    else byRoom.set(n.roomId, [n]);
  }
  const hasNodes = new Set(byRoom.keys());

  const links = new Map<string, Set<string>>();
  for (const n of nodes) links.set(n.id, new Set(n.neighbors));

  const connect = (a: string, b: string) => {
    if (a === b) return;
    links.get(a)?.add(b);
    links.get(b)?.add(a);
  };

  // Cached per room: several nodes in one room share the same reachable set.
  const reachableCache = new Map<string, string[]>();

  for (const node of nodes) {
    const sameRoom = (byRoom.get(node.roomId) ?? [])
      .filter((o) => o.id !== node.id)
      .sort((p, q) => dist(node.position, p.position) - dist(node.position, q.position));
    for (const other of sameRoom.slice(0, MAX_SAME_ROOM_LINKS)) {
      connect(node.id, other.id);
    }

    let reachable = reachableCache.get(node.roomId);
    if (!reachable) {
      reachable = reachableRoomsWithNodes(node.roomId, adjacency, hasNodes);
      reachableCache.set(node.roomId, reachable);
    }

    for (const roomId of reachable) {
      const candidates = byRoom.get(roomId) ?? [];
      if (candidates.length === 0) continue;
      const nearest = candidates.reduce((best, c) =>
        dist(node.position, c.position) < dist(node.position, best.position) ? c : best,
      );
      connect(node.id, nearest.id);
    }
  }

  return nodes.map((n) => ({
    ...n,
    neighbors: [...(links.get(n.id) ?? [])].sort(),
  }));
}

/**
 * Nodes unreachable from the first node. The editor surfaces these because an
 * orphaned room is the most common plan mistake — usually a missing doorway —
 * and it is invisible until someone walks the tour and hits a dead end.
 */
export function findOrphans(nodes: TourNode[]): TourNode[] {
  if (nodes.length === 0) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>([nodes[0].id]);
  const queue = [nodes[0].id];

  while (queue.length > 0) {
    const current = byId.get(queue.shift()!);
    if (!current) continue;
    for (const next of current.neighbors) {
      if (!seen.has(next) && byId.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }

  return nodes.filter((n) => !seen.has(n.id));
}
