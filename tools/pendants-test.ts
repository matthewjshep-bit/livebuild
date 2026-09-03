/**
 * A fitting in every room where the lamp is: a rose at the ceiling, a
 * pendant in the rooms people sit in, flush elsewhere, nothing in a cupboard.
 */
import { pendantsFor } from "../src/lib/model/pendants";
import { pointInPolygon } from "../src/lib/plan/geometry";
import type { Plan, Vec2 } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const plan: Plan = {
  scaleRef: { px: 1, meters: 1 },
  rooms: [
    { id: "living", label: "Living Room", polygon: [[0, 0], [5, 0], [5, 5], [0, 5]], ceilingHeight: 2.7, level: 0 },
    { id: "bath", label: "Bathroom", polygon: [[5, 0], [8, 0], [8, 3], [5, 3]], ceilingHeight: 2.7, level: 0 },
    { id: "closet", label: "Closet", polygon: [[5, 3], [8, 3], [8, 5], [5, 5]], ceilingHeight: 2.7, level: 0 },
    { id: "bed", label: "Bedroom", polygon: [[0, 0], [5, 0], [5, 5], [0, 5]], ceilingHeight: 2.4, level: 1 },
  ],
  openings: [],
};
const ground = pendantsFor(plan, 0);
// The fitting hangs at the room's interior point, which is inside the room
// and need not be the middle of the box round it.
const by = (id: string) => {
  const polygon = plan.rooms.find((r) => r.id === id)!.polygon as Vec2[];
  return ground.filter((p) => pointInPolygon([p.center[0], p.center[2]], polygon));
};
const living = by("living");
const bath = by("bath");
const closet = by("closet");
check("the living room hangs a pendant", living.some((p) => p.part === "cord") && living.some((p) => p.part === "shade") && living.some((p) => p.part === "bulb"));
check("under a rose at the ceiling", living.some((p) => p.part === "rose" && Math.abs(p.center[1] + p.size[1] / 2 - 2.7) < 1e-6));
check("the shade hangs below the ceiling and above head height", living.filter((p) => p.part === "shade").every((p) => p.center[1] < 2.4 && p.center[1] - p.size[1] / 2 > 2.0), JSON.stringify(living.map((p) => [p.part, p.center[1]])));
check("the bathroom's fitting is flush", bath.length > 0 && !bath.some((p) => p.part === "cord") && bath.filter((p) => p.part === "shade").every((p) => p.center[1] > 2.5));
check("nothing in the closet", closet.length === 0, `${closet.length}`);
const upstairs = pendantsFor(plan, 1);
check("the upper storey's fitting is at its own ceiling", upstairs.some((p) => p.part === "rose" && p.center[1] > 2.7 + 2.4 - 0.1), JSON.stringify(upstairs.map((p) => [p.part, p.center[1].toFixed(2)])));
check("every part glows only if it is the bulb", ground.every((p) => (p.part === "bulb") === (p.colour === "#fff4d6")));

console.log(failures === 0 ? "PENDANTS OK - a fitting where the lamp is, hung or flush, none in a cupboard" : `PENDANTS BROKEN - ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
