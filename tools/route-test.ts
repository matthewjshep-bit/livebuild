/** A route on foot goes through the doors, and nowhere there is no door. */
import { routeTo } from "../src/lib/model/route";
import type { Plan } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

// Three rooms in a row with doors between the first two and the last two,
// and a fourth room with no door at all.
const plan: Plan = {
  scaleRef: { px: 1, meters: 1 },
  rooms: [
    { id: "a", label: "Living Room", polygon: [[0, 0], [5, 0], [5, 4], [0, 4]], ceilingHeight: 2.7, level: 0 },
    { id: "b", label: "Hallway", polygon: [[5, 0], [7, 0], [7, 4], [5, 4]], ceilingHeight: 2.7, level: 0 },
    { id: "c", label: "Kitchen", polygon: [[7, 0], [11, 0], [11, 4], [7, 4]], ceilingHeight: 2.7, level: 0 },
    { id: "d", label: "Closet", polygon: [[0, 4], [2, 4], [2, 6], [0, 6]], ceilingHeight: 2.7, level: 0 },
    { id: "up", label: "Bedroom", polygon: [[0, 0], [5, 0], [5, 4], [0, 4]], ceilingHeight: 2.7, level: 1 },
  ],
  openings: [
    { id: "ab", kind: "door", between: ["a", "b"], at: [5, 2], width: 0.9 },
    { id: "bc", kind: "door", between: ["b", "c"], at: [7, 1], width: 0.9 },
    { id: "stairs", kind: "stairs", between: ["b", "up"], at: [6, 3], width: 0.9 },
  ],
};

{
  const route = routeTo(plan, 0, [1, 1], [10, 3]);
  check("a route across two doors has two doorways then the spot", route !== null && route.length === 3, JSON.stringify(route));
  check("through the first door", route !== null && route[0][0] === 5 && route[0][1] === 2, JSON.stringify(route));
  check("then the second", route !== null && route[1][0] === 7 && route[1][1] === 1);
  check("ending where asked", route !== null && route[2][0] === 10 && route[2][1] === 3);
}
{
  const route = routeTo(plan, 0, [1, 1], [4, 3]);
  check("within one room the route is just the spot", route !== null && route.length === 1 && route[0][0] === 4);
}
{
  check("a room with no door is unreachable", routeTo(plan, 0, [1, 1], [1, 5]) === null);
  check("a spot in no room goes nowhere", routeTo(plan, 0, [1, 1], [20, 20]) === null);
  check("stairs are not a door: the bedroom upstairs is not on this storey's route", routeTo(plan, 0, [1, 1], [1, 1]) !== null && routeTo(plan, 1, [1, 1], [10, 3]) === null);
}

console.log(failures === 0 ? "ROUTE OK - a route on foot goes through the doors, and nowhere there is no door" : `ROUTE BROKEN - ${failures}`);
process.exit(failures === 0 ? 0 : 1);
