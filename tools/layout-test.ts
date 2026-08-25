/**
 * The auto-layout's one hard promise: every room it produces is reachable.
 *
 * A stranded room is invisible until someone walks the tour and finds a room
 * they cannot enter, so this checks the invariant directly across many room
 * combinations rather than trusting one happy path through the browser.
 */
import { autoLayout, autoOpenings, ROOM_PRESETS } from "../src/lib/plan/autolayout";

function reachableCount(roomIds: string[], openings: Array<{ between: [string, string] }>): number {
  if (roomIds.length === 0) return 0;
  const adjacency = new Map<string, string[]>(roomIds.map((id) => [id, []]));
  for (const o of openings) {
    adjacency.get(o.between[0])?.push(o.between[1]);
    adjacency.get(o.between[1])?.push(o.between[0]);
  }
  const seen = new Set([roomIds[0]]);
  const queue = [roomIds[0]];
  while (queue.length) {
    for (const next of adjacency.get(queue.shift()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen.size;
}

// A deterministic spread of house shapes: sizes 2..12, drawn from the presets
// plus repeats, since real houses have three bedrooms and two bathrooms.
const cases: string[][] = [];
for (let n = 2; n <= 12; n++) {
  for (let offset = 0; offset < 4; offset++) {
    cases.push(
      Array.from({ length: n }, (_, i) => ROOM_PRESETS[(i * 3 + offset) % ROOM_PRESETS.length]),
    );
  }
}
cases.push(["Bedroom", "Bedroom", "Bedroom", "Bathroom", "Bathroom", "Hallway"]);
cases.push(["Hallway", "Hallway", "Bathroom"]);
cases.push(["Living Room", "Garage"]);

let failures = 0;
for (const labels of cases) {
  const rooms = autoLayout(labels);
  const openings = autoOpenings(rooms);
  const reachable = reachableCount(rooms.map((r) => r.id), openings as Array<{ between: [string, string] }>);
  if (reachable !== rooms.length) {
    failures++;
    console.log(`  FAIL ${rooms.length} rooms, only ${reachable} reachable: ${labels.join(", ")}`);
  }
}

console.log(
  failures === 0
    ? `LAYOUT OK - all ${cases.length} house shapes fully connected`
    : `LAYOUT BROKEN - ${failures}/${cases.length} shapes had unreachable rooms`,
);
process.exit(failures === 0 ? 0 : 1);
