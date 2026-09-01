/**
 * What somebody drew, read as rooms.
 *
 * Freehand is where a plan gets its shape now, so this is the module a bad
 * house comes from. Everything below is a drawing somebody would actually make:
 * lines that wobble, corners that overshoot, corners that fall short, a wall
 * drawn into the middle of another, a stray tick, a wall rubbed out, a wall
 * drawn twice, and a wing at an angle to the rest.
 *
 * The refusals matter as much as the successes. A gap in a drawing might be a
 * doorway or a slip, and nothing here can tell - so it has to say where the gap
 * is rather than pick one.
 */
import { strokesToRooms, type Label, type Stroke } from "../src/lib/plan/strokes";
import { area } from "../src/lib/plan/geometry";
import type { Vec2 } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

/** A repeatable wobble, so a failure is the same failure twice. */
let seed = 12345;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff - 0.5;
};

/** A hand-drawn line: sampled along, with a wobble across. */
function pen(a: Vec2, b: Vec2, wobble = 1.6, step = 6): Stroke {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(2, Math.round(length / step));
  const points: Array<[number, number]> = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const nx = -(b[1] - a[1]) / length;
    const ny = (b[0] - a[0]) / length;
    const off = i === 0 || i === n ? 0 : rand() * wobble * 2;
    points.push([a[0] + (b[0] - a[0]) * t + nx * off, a[1] + (b[1] - a[1]) * t + ny * off]);
  }
  return { points, width: 5, erase: false };
}

const label = (x: number, y: number, text: string): Label => ({ x, y, text });

/** Two rooms side by side, drawn as five walls with a shared spine. */
function twoRooms(): Stroke[] {
  return [
    pen([100, 100], [500, 100]),   // top
    pen([500, 100], [500, 400]),   // right
    pen([500, 400], [100, 400]),   // bottom
    pen([100, 400], [100, 100]),   // left
    pen([300, 100], [300, 400]),   // the wall between them
  ];
}
const twoLabels = [label(200, 250, "Kitchen"), label(400, 250, "Living Room")];

// --- the ordinary case ---
{
  const r = strokesToRooms(twoRooms(), twoLabels);
  check("a wobbly two-room plan reads", r.ok, r.ok ? "" : r.why);
  if (r.ok) {
    check("as two rooms", r.rooms.length === 2, `${r.rooms.length}`);
    check("named from the labels",
      r.rooms.map((x) => x.label).sort().join(",") === "Kitchen,Living Room",
      r.rooms.map((x) => x.label).join(","));
    check("each with real area", r.rooms.every((x) => area(x.polygon) > 1), 
      r.rooms.map((x) => area(x.polygon).toFixed(1)).join(", "));
    check("and it says what it tidied", r.adjustments.length > 0, JSON.stringify(r.adjustments));
  }
}

// --- corners that overshoot, which is how everybody draws them ---
{
  const strokes = [
    pen([95, 105], [510, 96]),
    pen([503, 92], [497, 410]),
    pen([508, 402], [96, 396]),
    pen([104, 408], [99, 94]),
    pen([300, 98], [302, 404]),
  ];
  const r = strokesToRooms(strokes, twoLabels);
  check("overshot corners still close", r.ok, r.ok ? "" : r.why);
  if (r.ok) check("into two rooms", r.rooms.length === 2, `${r.rooms.length}`);
}

// --- a wall drawn into the middle of another one ---
{
  // The spine stops short of the top wall by a few pixels, as a hand does.
  const strokes = [
    pen([100, 100], [500, 100]),
    pen([500, 100], [500, 400]),
    pen([500, 400], [100, 400]),
    pen([100, 400], [100, 100]),
    pen([300, 108], [300, 393]),
  ];
  const r = strokesToRooms(strokes, twoLabels);
  check("a T-junction is joined and split", r.ok, r.ok ? "" : r.why);
  if (r.ok) check("giving two rooms, not one", r.rooms.length === 2, `${r.rooms.length}`);
}

// --- a gap nobody can guess about ---
{
  const strokes = [
    pen([100, 100], [500, 100]),
    pen([500, 100], [500, 400]),
    pen([500, 400], [100, 400]),
    // The left wall stops a long way short.
    pen([100, 400], [100, 240]),
  ];
  const r = strokesToRooms(strokes, [label(300, 250, "Kitchen")]);
  check("a real gap is refused", !r.ok);
  if (!r.ok) {
    // Named after the room somebody wrote in, which is what they can act on.
    check("and names the room that did not close", /Kitchen is not closed/.test(r.why), r.why);
    check("and says where to look", r.at.length > 0);
  }
}

// --- a stray tick is not a room ---
{
  const strokes = [...twoRooms(), pen([420, 180], [440, 200])];
  const r = strokesToRooms(strokes, twoLabels);
  check("a stray mark does not become a room", r.ok, r.ok ? "" : r.why);
  if (r.ok) check("still two rooms", r.rooms.length === 2, `${r.rooms.length}`);
}

// --- a wall that was rubbed out stays rubbed out ---
{
  const strokes: Stroke[] = [
    ...twoRooms(),
    // A second spine, then an eraser dragged along it.
    pen([400, 100], [400, 400], 0.5),
    // Dragged down the spine only - stopping clear of the walls it meets, the
    // way somebody rubbing out one wall would.
    { points: Array.from({ length: 30 }, (_, i) => [400, 132 + i * 8] as [number, number]), width: 44, erase: true },
  ];
  const r = strokesToRooms(strokes, twoLabels);
  check("an erased wall does not come back", r.ok, r.ok ? "" : r.why);
  if (r.ok) check("so it is still two rooms", r.rooms.length === 2, `${r.rooms.length}`);
}

// --- a wing at an angle keeps its angle ---
{
  const strokes = [
    pen([100, 100], [400, 100]),
    pen([400, 100], [400, 400]),
    pen([400, 400], [100, 400]),
    pen([100, 400], [100, 100]),
    // A wing off the right, at about thirty degrees.
    pen([400, 150], [660, 250]),
    pen([660, 250], [560, 480]),
    pen([560, 480], [400, 400]),
  ];
  const r = strokesToRooms(strokes, [label(250, 250, "Living Room"), label(500, 300, "Sunroom")]);
  check("a wing at an angle reads", r.ok, r.ok ? "" : r.why);
  if (r.ok) {
    check("as two rooms", r.rooms.length === 2, `${r.rooms.length}`);
    // The wing must not have been squared up out of existence.
    const sunroom = r.rooms.find((x) => x.label === "Sunroom");
    const square = sunroom?.polygon.every(
      (p, i, poly) => {
        const q = poly[(i + 1) % poly.length];
        return Math.abs(p[0] - q[0]) < 1e-6 || Math.abs(p[1] - q[1]) < 1e-6;
      },
    );
    check("and the angled one kept its angles", sunroom !== undefined && !square,
      JSON.stringify(sunroom?.polygon.map((p) => p.map((v) => v.toFixed(1)))));
  }
}

// --- a room with no name is refused, because "Other" is a wrong answer ---
{
  const r = strokesToRooms(twoRooms(), [label(200, 250, "Kitchen")]);
  check("an unnamed room is refused", !r.ok);
  if (!r.ok) check("and says why", /no name/.test(r.why), r.why);
}

// --- two names in one space is the most useful error here ---
{
  const strokes = [
    pen([100, 100], [500, 100]),
    pen([500, 100], [500, 400]),
    pen([500, 400], [100, 400]),
    pen([100, 400], [100, 100]),
  ];
  const r = strokesToRooms(strokes, twoLabels);
  check("two names in one room is refused", !r.ok);
  if (!r.ok) check("and asks the right question",
    /same space/.test(r.why) && /wall missing/.test(r.why), r.why);
}

// --- walls drawn as double lines, the way somebody used to plans would ---
//
// The worry was that a pair of lines per wall gives one long thin face per wall
// cavity - forty perfectly good polygons, all wrong. At realistic proportions
// that does not happen: a twelve-pixel cavity against a three-hundred-pixel
// room is far below the sliver threshold and is discarded, leaving the rooms
// somebody meant. Asserted because it is the behaviour, not because it was the
// design.
{
  const strokes: Stroke[] = [];
  for (const x of [100, 112, 300, 312, 500, 512]) strokes.push(pen([x, 100], [x, 400], 0.4));
  for (const y of [100, 112, 400, 412]) strokes.push(pen([100, y], [512, y], 0.4));
  const r = strokesToRooms(strokes, [label(200, 250, "Kitchen"), label(400, 250, "Living Room")]);
  check("double-line walls still give the rooms", r.ok, r.ok ? "" : r.why);
  if (r.ok) {
    check("two of them", r.rooms.length === 2, `${r.rooms.length}`);
    check("of a sensible shape",
      r.rooms.every((room) => {
        const xs = room.polygon.map((q) => q[0]);
        const ys = room.polygon.map((q) => q[1]);
        const w = Math.max(...xs) - Math.min(...xs);
        const h = Math.max(...ys) - Math.min(...ys);
        return Math.max(w, h) / Math.min(w, h) < 3;
      }),
      r.rooms.map((room) => area(room.polygon).toFixed(1)).join(", "));
  }
}

// --- a drawing that comes out as more spaces than were named ---
//
// The realistic version of the double-line worry. Whatever caused it, several
// unnamed spaces at once is worth a better message than "name them", because
// the fix is usually to draw differently.
{
  const strokes: Stroke[] = [];
  for (const x of [100, 150, 220, 270, 340, 390]) strokes.push(pen([x, 100], [x, 260], 0.3));
  for (const y of [100, 150, 210, 260]) strokes.push(pen([100, y], [390, y], 0.3));
  const r = strokesToRooms(strokes, [label(185, 180, "Kitchen"), label(305, 180, "Living Room")]);
  check("a drawing with more spaces than names is refused", !r.ok);
  if (!r.ok) check("and suggests what to draw instead", /one line per wall/.test(r.why), r.why);
}

// --- nothing at all ---
{
  check("an empty pad is refused", !strokesToRooms([], []).ok);
  check("and one line is not a room", !strokesToRooms([pen([0, 0], [100, 0])], []).ok);
}

if (failures > 0) {
  console.error(`\nSTROKES: ${failures} failure(s)`);
  process.exit(1);
}
console.log(
  "STROKES OK - a wobbly plan reads as rooms, overshoots and T-junctions close, an erased wall stays erased, a stray tick is ignored, an angled wing keeps its angles, double-line walls give the rooms anyway, and an unclosed room, an unnamed one, two names in one space and a drawing with more spaces than names are each refused with somewhere to look",
);
