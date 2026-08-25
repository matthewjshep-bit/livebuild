/**
 * Multi-storey and pass-through behaviour.
 *
 * Three claims worth checking, all of which fail invisibly - you would not
 * notice until you were inside a tour and could not get somewhere:
 *
 *   1. Rooms stacked on different storeys are NOT joined. A floor is not a door.
 *   2. Stairwells sitting on top of each other ARE joined.
 *   3. A hallway with no photos still connects the rooms either side of it,
 *      rather than severing them.
 */
import { autoOpenings } from "../src/lib/plan/autolayout";
import { buildWalkGraph } from "../src/lib/plan/walkgraph";
import type { Plan, Room, TourNode } from "../src/lib/schema";

const room = (id: string, label: string, x: number, y: number, w: number, h: number, level = 0): Room => ({
  id,
  label,
  polygon: [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ],
  ceilingHeight: 2.7,
  level,
});

const node = (id: string, roomId: string, x: number, y: number): TourNode => ({
  id,
  roomId,
  position: [x, y],
  eyeHeight: 1.5,
  heading: 0,
  pitch: 0,
  fovDeg: 78,
  photo: `${id}.jpg`,
  depth: null,
  parallaxBudget: 0.35,
  neighbors: [],
});

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " - " + detail : ""}`);
  }
};

// --- 1 + 2: two storeys joined only by stairs ---
{
  const rooms = [
    room("g_living", "Living Room", 0, 0, 5, 4, 0),
    room("g_stairs", "Stairs", 5, 0, 2, 3, 0),
    room("u_bed", "Bedroom", 0, 0, 5, 4, 1),
    room("u_stairs", "Stairs", 5, 0, 2, 3, 1),
  ];
  const openings = autoOpenings(rooms);

  const joins = (a: string, b: string) =>
    openings.some((o) => o.between.includes(a) && o.between.includes(b));

  check("ground living is not joined to the bedroom above it", !joins("g_living", "u_bed"));
  check("stacked stairwells are joined", joins("g_stairs", "u_stairs"));
  check(
    "the stair link is marked as stairs",
    openings.find((o) => o.between.includes("g_stairs") && o.between.includes("u_stairs"))?.kind ===
      "stairs",
  );

  const plan: Plan = { scaleRef: { px: 1, meters: 0.3048 }, rooms, openings };
  const nodes = buildWalkGraph(plan, [
    node("n_live", "g_living", 1, 1),
    node("n_bed", "u_bed", 1, 1),
  ]);
  // Neither stairwell is photographed, so this only works if empty rooms are
  // treated as ways through.
  check(
    "you can walk upstairs through an unphotographed stairwell",
    nodes.find((n) => n.id === "n_live")?.neighbors.includes("n_bed") ?? false,
    JSON.stringify(nodes.map((n) => [n.id, n.neighbors])),
  );
}

// --- 3: an empty hallway joins rather than severs ---
{
  const rooms = [
    room("kitchen", "Kitchen", 0, 0, 4, 4),
    room("hall", "Hallway", 4, 0, 1.5, 4),
    room("den", "Den", 5.5, 0, 4, 4),
  ];
  const plan: Plan = {
    scaleRef: { px: 1, meters: 0.3048 },
    rooms,
    openings: autoOpenings(rooms),
  };
  const nodes = buildWalkGraph(plan, [
    node("n_kit", "kitchen", 1, 2),
    node("n_den", "den", 8, 2),
  ]);

  check(
    "kitchen and den connect through an unphotographed hallway",
    nodes.find((n) => n.id === "n_kit")?.neighbors.includes("n_den") ?? false,
    JSON.stringify(nodes.map((n) => [n.id, n.neighbors])),
  );
}

// --- rooms that merely touch across a gap must NOT connect ---
{
  const rooms = [room("a", "A", 0, 0, 4, 4), room("b", "B", 6, 0, 4, 4)];
  check("rooms with a gap between them get no doorway", autoOpenings(rooms).length === 0);
}

console.log(
  failures === 0 ? "FLOORS OK - storeys, stairs and pass-through all behave" : `FLOORS BROKEN - ${failures} failures`,
);
process.exit(failures === 0 ? 0 : 1);
