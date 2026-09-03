/**
 * Fitted joinery fits, and only one generator supplies each thing.
 *
 * Two failures matter here and neither is obvious in a screenshot. A run that
 * overflows its wall pokes through into the room next door, where it reads as
 * that room's cabinetry. And a run that the furniture generator *also* supplies
 * puts two worktops on one wall - which is a faint z-fight to look at and a
 * kitchen priced twice on the scope of work, the second of which nobody would
 * catch by looking.
 */
import { joineryFor } from "../src/lib/model/joinery";
import { piecesFor } from "../src/lib/model/staging";
import { inferHouse } from "../src/lib/spec/infer";
import { HouseSpec, type RoomSpec } from "../src/lib/spec/schema";
import { autoOpenings } from "../src/lib/plan/autolayout";
import { boundsOf, rectangle } from "../src/lib/plan/geometry";
import { elementForPiece } from "../src/lib/bom/pickable";
import type { Plan, Room } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const room = (id: string, label: string, x: number, y: number, w: number, h: number): Room => ({
  id,
  label,
  polygon: rectangle(x, y, w, h),
  ceilingHeight: 2.7,
  level: 0,
});

const rooms = [
  room("kitchen", "Kitchen", 0, 0, 4.2, 3.6),
  room("bath", "Bathroom", 4.2, 0, 2.6, 3.6),
  room("bed", "Bedroom", 0, 3.6, 6.8, 3.4),
];
const plan: Plan = { scaleRef: { px: 100, meters: 1 }, rooms, openings: autoOpenings(rooms) };
const { spec } = inferHouse(plan, HouseSpec.parse({}));

// --- a room of each kind gets what it should ---
check(
  "a kitchen is fitted with cabinets",
  spec.rooms.kitchen.joinery.some((j) => j.kind === "cabinet-run"),
);
check("a bathroom gets a vanity", spec.rooms.bath.joinery.some((j) => j.kind === "vanity"));
check(
  "a bedroom with a long clear wall gets a fitted wardrobe",
  spec.rooms.bed.joinery.some((j) => j.kind === "wardrobe"),
  `got [${spec.rooms.bed.joinery.map((j) => j.kind)}]`,
);

// And one without does not. A fitted wardrobe in a small bedroom is the
// difference between a bedroom and a corridor.
const small = [room("box", "Bedroom", 0, 0, 2.2, 2.0)];
const smallPlan = {
  scaleRef: { px: 100, meters: 1 },
  rooms: small,
  openings: autoOpenings(small),
};
check(
  "a box room is left alone",
  inferHouse(smallPlan, HouseSpec.parse({})).spec.rooms.box.joinery.length === 0,
);
check(
  "and each says why",
  Boolean(spec.rooms.kitchen.because["joinery"]) && Boolean(spec.rooms.bath.because["joinery"]),
  spec.rooms.kitchen.because["joinery"],
);

// --- everything built stays inside the room it belongs to ---
for (const r of rooms) {
  const b = boundsOf(r.polygon);
  const width = b.x1 - b.x0;
  const depth = b.y1 - b.y0;
  for (const piece of joineryFor(r, spec.rooms[r.id])) {
    for (const box of piece.boxes) {
      const [cx, cy, cz] = box.center;
      const [w, h, d] = box.size;
      const inside =
        cx - w / 2 >= -1e-6 &&
        cx + w / 2 <= width + 1e-6 &&
        cz - d / 2 >= -1e-6 &&
        cz + d / 2 <= depth + 1e-6 &&
        cy - h / 2 >= -1e-6;
      check(
        `${r.label} ${piece.kind}: every part stays inside the room`,
        inside,
        `box at (${cx.toFixed(2)}, ${cz.toFixed(2)}) size ${w.toFixed(2)}x${d.toFixed(2)} in ${width.toFixed(2)}x${depth.toFixed(2)}`,
      );
      check(`${r.label} ${piece.kind}: nothing is below the floor`, cy - h / 2 >= -1e-6);
      check(
        `${r.label} ${piece.kind}: nothing reaches the ceiling`,
        cy + h / 2 <= r.ceilingHeight + 1e-6,
        `${(cy + h / 2).toFixed(2)}m`,
      );
    }
  }
}

// --- nothing is built across a doorway ---
//
// The failure this catches is not cosmetic: a wardrobe on the wall the door is
// in is a room you cannot walk into, and the wall with the door in it is very
// often the longest one, so choosing by length alone picks it.
const DOOR_CLEAR = 0.75;
let doorwaysTested = 0;
for (const r of rooms) {
  const b = boundsOf(r.polygon);
  const doors = plan.openings
    .filter((o) => o.kind !== "stairs" && o.between.includes(r.id))
    .map((o) => [o.at[0] - b.x0, o.at[1] - b.y0] as [number, number]);
  if (doors.length === 0) continue;

  for (const piece of joineryFor(r, spec.rooms[r.id])) {
    for (const box of piece.boxes) {
      const [cx, , cz] = box.center;
      const [w, , d] = box.size;
      for (const [dx, dz] of doors) {
        doorwaysTested++;
        const nearestX = Math.max(cx - w / 2, Math.min(dx, cx + w / 2));
        const nearestZ = Math.max(cz - d / 2, Math.min(dz, cz + d / 2));
        check(
          `${r.label} ${piece.kind}: nothing is built across the doorway`,
          Math.hypot(dx - nearestX, dz - nearestZ) >= DOOR_CLEAR - 1e-6,
          `door at (${dx.toFixed(2)}, ${dz.toFixed(2)}) is ${Math.hypot(dx - nearestX, dz - nearestZ).toFixed(2)}m from a ${piece.kind}`,
        );
      }
    }
  }
}

// A check that silently examines nothing passes for the wrong reason.
check(
  "and the fixture actually has doorways to be built across",
  doorwaysTested > 0,
  `${doorwaysTested} door/part pairs examined`,
);

// --- one worktop per wall ---
const kitchenFitted = joineryFor(rooms[0], spec.rooms.kitchen).map((p) => p.kind);
const kitchenStaged = piecesFor(plan, rooms[0], true, spec.rooms.kitchen).map((p) => p.kind);
check(
  "the furniture generator stops supplying a counter once one is fitted",
  kitchenFitted.includes("cabinet") && !kitchenStaged.includes("counter"),
  `fitted=[${kitchenFitted}] staged=[${kitchenStaged}]`,
);
const bathStaged = piecesFor(plan, rooms[1], true, spec.rooms.bath).map((p) => p.kind);
check(
  "and stops supplying a basin once a vanity is fitted",
  !bathStaged.includes("basin"),
  `staged=[${bathStaged}]`,
);
check("but the bath is still there", bathStaged.includes("bath"), `staged=[${bathStaged}]`);

// --- and it is priced ---
check("a cabinet carries the element that prices it", elementForPiece("cabinet") === "cabinets");
check("a vanity does too", elementForPiece("basin") === "vanity");

// --- joinery is not staging ---
const bathUnfurnished = piecesFor(plan, rooms[1], false, spec.rooms.bath).map((p) => p.kind);
check(
  "turning furniture off leaves the fitted joinery alone",
  joineryFor(rooms[1], spec.rooms.bath).length > 0 && bathUnfurnished.includes("bath"),
);

// --- a run too long for its wall is trimmed rather than allowed through it ---
const greedy: RoomSpec = {
  ...spec.rooms.kitchen,
  joinery: [
    {
      id: "greedy",
      kind: "cabinet-run",
      wall: "north",
      alongM: 0.8,
      lengthM: 0.9,
      depthM: null,
      tier: "base+wall",
      doorStyle: "shaker",
      colour: null,
      hardware: "bar",
      worktop: null,
    },
  ],
};
const b0 = boundsOf(rooms[0].polygon);
const clamped = joineryFor(rooms[0], greedy).flatMap((p) => p.boxes);
check(
  "a run that claims more wall than exists is trimmed to it",
  clamped.every((box) => box.center[0] + box.size[0] / 2 <= b0.x1 - b0.x0 + 1e-6),
  clamped.map((box) => (box.center[0] + box.size[0] / 2).toFixed(2)).join(" "),
);

// --- cost ---
//
// A door is five boxes now rather than one - a frame round a recessed panel -
// so a base-and-wall run of fourteen doors is seventy boxes before its
// carcasses, plinth, top and handles. They merge into one mesh per colour, so
// this is triangles rather than draw calls, and a few thousand triangles is
// nothing. The bound is here to catch a runaway, not to keep the count small.
const boxes = joineryFor(rooms[0], spec.rooms.kitchen).reduce((n, p) => n + p.boxes.length, 0);
check("a kitchen's run is a sensible number of parts", boxes > 6 && boxes < 200, `${boxes} boxes`);

// --- the door style is drawn, not just stored ---
//
// `doorStyle` was read off the photograph, stored with provenance, and never
// looked at: every door was one flat box, so a shaker kitchen and a slab one
// rendered identically. The read prompt says the difference is "a line of
// shadow a few millimetres wide around the edge of each door", which a frame
// of boxes round a recessed panel makes and one box cannot.
{
  const styled = (doorStyle: RoomSpec["joinery"][number]["doorStyle"]): number =>
    joineryFor(rooms[0], {
      ...spec.rooms.kitchen,
      joinery: spec.rooms.kitchen.joinery.map((j) => ({ ...j, doorStyle })),
    }).reduce((n, p) => n + p.boxes.length, 0);
  const slab = styled("slab");
  const shaker = styled("shaker");
  const raised = styled("raised-panel");
  check("a shaker door is more than one box", shaker > slab, `${shaker} vs ${slab}`);
  check("and a raised panel is more again", raised > shaker, `${raised} vs ${shaker}`);
}

// --- the worktop's material reaches its finish ---
//
// `worktop.material` affected only colour, so stainless and laminate in the
// same grey were the same surface. A box may now say how it takes the light.
{
  const withTop = (material: NonNullable<RoomSpec["joinery"][number]["worktop"]>["material"]) =>
    joineryFor(rooms[0], {
      ...spec.rooms.kitchen,
      joinery: spec.rooms.kitchen.joinery.map((j) => ({
        ...j,
        worktop: { material, colour: "#bfbfbf", thicknessM: 0.03 },
      })),
    }).flatMap((p) => p.boxes);
  const steel = withTop("stainless").find((b) => b.finish && b.finish.metalness > 0.5);
  const laminate = withTop("laminate").find((b) => b.finish);
  check("a stainless worktop is a metal", Boolean(steel), "no box with metalness > 0.5");
  check("and a laminate one is matte and not", Boolean(laminate) && laminate!.finish!.metalness === 0 && laminate!.finish!.roughness > 0.5,
    JSON.stringify(laminate?.finish));
}

console.log(
  failures === 0
    ? "JOINERY OK - kitchens and bathrooms are fitted, every part stays in its room, runs are trimmed to their wall, nothing is supplied twice, a door is drawn in its style, and a worktop takes the light like what it is made of"
    : `JOINERY FAILED - ${failures} check${failures === 1 ? "" : "s"}`,
);
process.exit(failures === 0 ? 0 : 1);
