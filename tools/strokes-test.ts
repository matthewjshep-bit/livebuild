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
import { readStrokes, strokesToRooms, type Label, type Stroke } from "../src/lib/plan/strokes";
import { area } from "../src/lib/plan/geometry";
import { sqftToM2 } from "../src/lib/units";
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

// --- a house with more than three interior walls ---
{
  /**
   * The ceiling this had, and the reason it was invisible.
   *
   * The T-junction repair ran three passes and split once per pass, so exactly
   * three junctions could ever be joined - and an interior wall has two of
   * them. A six-room house needs eight, so the later walls did nothing at all:
   * no refusal, no adjustment, just rooms quietly coming out merged. Six spaces
   * from six spaces drawn is the whole assertion.
   */
  const strokes = [
    pen([100, 100], [700, 100]),
    pen([700, 100], [700, 500]),
    pen([700, 500], [100, 500]),
    pen([100, 500], [100, 100]),
    pen([100, 300], [700, 300]),
    pen([300, 100], [300, 300]),
    pen([500, 100], [500, 300]),
    pen([300, 300], [300, 500]),
    pen([500, 300], [500, 500]),
  ];
  const names = [
    label(200, 200, "Kitchen"),
    label(400, 200, "Living Room"),
    label(600, 200, "Dining Room"),
    label(200, 400, "Primary Bedroom"),
    label(400, 400, "Bedroom 2"),
    label(600, 400, "Bathroom"),
  ];
  const r = strokesToRooms(strokes, names);
  check("a six-room house reads", r.ok, r.ok ? "" : r.why);
  if (r.ok) {
    check("as six rooms and not fewer", r.rooms.length === 6, `${r.rooms.length}`);
    check(
      "each of them named",
      new Set(r.rooms.map((room) => room.label)).size === 6,
      r.rooms.map((room) => room.label).join(", "),
    );
  }
}

// --- the spaces, before anything is asked about names ---
{
  const r = readStrokes(twoRooms());
  check("the board can see the spaces without names", r.faces.length === 2, `${r.faces.length}`);
  check("and says nothing is wrong", r.why === null, r.why ?? "");
  check("an empty pad has no spaces and says why", readStrokes([]).why !== null);
}

// --- a floor area somebody typed beats the assumption ---
{
  const r = strokesToRooms(twoRooms(), twoLabels, { targetGroundSqft: 800 });
  check("a stated floor area is used", r.ok, r.ok ? "" : r.why);
  if (r.ok) {
    const total = r.rooms.reduce((sum, room) => sum + Math.abs(area(room.polygon)), 0);
    check(
      "and the drawing comes out that size",
      Math.abs(total / sqftToM2(800) - 1) < 0.02,
      `${Math.round(total / sqftToM2(1))} sqft`,
    );
    check(
      "and says so",
      r.adjustments.some((a) => /800 sq ft/.test(a)),
      r.adjustments.join(" "),
    );
  }
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
  // This used to refuse and name the room, which was a good message and a bad
  // outcome: a wall that stops short is a thing the reader can close, and
  // stopping meant somebody redrew a house they had already drawn.
  check("a real gap does not stop the build", r.ok, r.ok ? "" : r.why);
  if (r.ok) {
    check("it still comes out as one room", r.rooms.length === 1, `${r.rooms.length}`);
    check(
      "and says what it had to do",
      r.adjustments.some((a) => /closed|fold|narrow|weld/i.test(a)),
      r.adjustments.join(" | "),
    );
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

// --- a room with no name goes to the room next door ---
//
// The refusal this replaces was the single most reported thing about the pad.
// It was defensible - "Other" really is a wrong answer for a room - and it made
// a drawing somebody had plainly finished unbuildable because one space out of
// eight had no word in it. The space next door is a better answer than a stop.
{
  // Both at a fixed scale. Without one the reader falls back to "a room is
  // about sixteen square metres", so two rooms come out as 32 m2 and the one
  // they fold into comes out as 16 - which says nothing about whether the fold
  // kept the floor, only that the fallback did its job.
  const at = { metresPerPixel: 0.02 };
  const before = strokesToRooms(twoRooms(), twoLabels, at);
  const r = strokesToRooms(twoRooms(), [label(200, 250, "Kitchen")], at);
  check("an unnamed room does not stop the build", r.ok, r.ok ? "" : r.why);
  if (r.ok && before.ok) {
    check("it is folded into the one that has a name", r.rooms.length === 1, `${r.rooms.length}`);
    check("which keeps its name", r.rooms[0].label === "Kitchen", r.rooms[0].label);
    check("and says so", r.adjustments.some((a) => /folded/i.test(a)), r.adjustments.join(" | "));
    // Nothing is lost in the fold: the two rooms together are the one room.
    const both = before.rooms.reduce((sum, room) => sum + area(room.polygon), 0);
    check(
      "and the floor area is conserved",
      Math.abs(area(r.rooms[0].polygon) - both) / both < 0.02,
      `${area(r.rooms[0].polygon).toFixed(1)} vs ${both.toFixed(1)}`,
    );
  }
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
  check("two names in one room still builds", r.ok, r.ok ? "" : r.why);
  if (r.ok) {
    check("as the first of them", r.rooms.length === 1 && r.rooms[0].label === "Kitchen",
      r.rooms.map((room) => room.label).join(", "));
    // Still worth saying. It usually does mean a wall is missing, and that is
    // something the drawing can be corrected for - just not stopped for.
    check("and still asks the right question",
      r.adjustments.some((a) => /same space/.test(a) && /wall missing/.test(a)),
      r.adjustments.join(" | "));
  }
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
  check("a drawing with more spaces than names still builds", r.ok, r.ok ? "" : r.why);
  if (r.ok) {
    check("as the rooms that were named", r.rooms.length === 2, `${r.rooms.length}`);
    check(
      "and every one of them is a room somebody could stand in",
      r.rooms.every((room) => area(room.polygon) > 2),
      r.rooms.map((room) => `${room.label} ${area(room.polygon).toFixed(1)}`).join(", "),
    );
  }
}

// --- the same drawing, drawn small and drawn large ---
//
// The bug this pins was invisible and decided everything. Every tolerance was a
// number of paper pixels, and paper pixels are screen pixels over the zoom,
// which the pad clamps between 0.3 and 4 - so the *same house*, drawn by the
// same hand, read differently depending on how far somebody had scrolled the
// wheel before they started. Zoomed out to see the whole plan, corner-closing
// was thirteen times stricter than zoomed in.
{
  // The wobble and the sampling scale too, or this measures the test's hand
  // rather than the reader: a fixed 1.6px shake is 1% of a small drawing and a
  // tenth of that on a large one, which is a different drawing, not the same
  // one bigger.
  const at = (k: number): Stroke[] => {
    const wall = (a: Vec2, b: Vec2) => pen(a, b, 1.6 * k, 6 * k);
    return [
      // A corner that misses by a hair, scaled with everything else.
      wall([100 * k, 100 * k], [500 * k, 100 * k]),
      wall([500 * k, 100 * k], [500 * k, 400 * k]),
      wall([500 * k, 400 * k], [100 * k, 400 * k]),
      wall([100 * k, 400 * k], [100 * k, 108 * k]),
      wall([300 * k, 100 * k], [300 * k, 400 * k]),
    ];
  };
  const small = strokesToRooms(at(0.35), twoLabels);
  const large = strokesToRooms(at(3), twoLabels);
  check("a drawing made small reads", small.ok, small.ok ? "" : small.why);
  check("and made large reads the same way", large.ok, large.ok ? "" : large.why);
  if (small.ok && large.ok) {
    check(
      "into the same rooms",
      small.rooms.length === large.rooms.length && small.rooms.length === 2,
      `${small.rooms.length} vs ${large.rooms.length}`,
    );
    // Same shape, not merely the same count: with no pixel scale given, both
    // fall back to rooms of a usual size, so the metres should agree closely.
    const shape = (r: typeof small) =>
      r.ok ? r.rooms.map((room) => area(room.polygon)).sort((a, b) => a - b) : [];
    const a = shape(small);
    const b = shape(large);
    check(
      "and to the same size",
      a.every((v, i) => Math.abs(v - b[i]) / Math.max(v, 1) < 0.05),
      `${a.map((v) => v.toFixed(1))} vs ${b.map((v) => v.toFixed(1))}`,
    );
  }
}

// --- the drawing that started this ---
//
// Six walls drawn as pairs of lines, which is what a plan looks like in print
// and therefore what people draw. Every cavity between a pair used to come out
// as a room with no name, and six of them came out as a refusal telling the
// user to draw differently. This is the exact shape of that report.
{
  const strokes: Stroke[] = [];
  // Outer walls, single lines.
  strokes.push(pen([100, 100], [700, 100]));
  strokes.push(pen([700, 100], [700, 500]));
  strokes.push(pen([700, 500], [100, 500]));
  strokes.push(pen([100, 500], [100, 100]));
  // Interior walls, each drawn twice about fifteen pixels apart.
  for (const x of [300, 315]) strokes.push(pen([x, 100], [x, 500]));
  for (const y of [300, 315]) strokes.push(pen([100, y], [300, y]));
  for (const y of [220, 235]) strokes.push(pen([315, y], [700, y]));

  const labels = [
    label(200, 200, "Kitchen"),
    label(200, 420, "Living Room"),
    label(500, 160, "Bedroom 2"),
    label(500, 380, "Primary Bedroom"),
  ];
  const r = strokesToRooms(strokes, labels);
  check("a plan drawn with doubled walls builds", r.ok, r.ok ? "" : r.why);
  if (r.ok) {
    check(
      "as the four rooms that were named",
      r.rooms.length === 4,
      r.rooms.map((room) => room.label).join(", "),
    );
    check(
      "with no wall cavities among them",
      r.rooms.every((room) => area(room.polygon) > 4),
      r.rooms.map((room) => `${room.label} ${area(room.polygon).toFixed(1)}`).join(", "),
    );
    check(
      "and it says the walls were doubled",
      r.adjustments.some((a) => /drawn twice|narrow to stand in|[Ff]olded/.test(a)),
      r.adjustments.join(" | "),
    );
  }
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
  "STROKES OK - a wobbly plan reads as rooms, overshoots and T-junctions close, a six-room house keeps all six, the spaces are readable before they are named, a stated floor area sets the size, an erased wall stays erased, a stray tick is ignored, an angled wing keeps its angles, the same house reads the same drawn small or large, and a drawing is taken as it comes: doubled walls weld into one, a gap closes, a space with no name goes to the room next door, and only an empty pad refuses",
);
