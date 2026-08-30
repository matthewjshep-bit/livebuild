/**
 * Grading survives a re-layout.
 *
 * Re-deriving a plan mints new room ids, and condition is keyed by room id. The
 * failure this guards against is silent and expensive: somebody grades a house
 * room by room, presses "rebuild the layout", and the scope page quietly reads
 * "nothing seen yet" again with no error anywhere.
 */
import { carryCondition } from "../src/lib/build/carryover";
import type { Plan } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const room = (id: string, label: string, level = 0) => ({
  id,
  label,
  polygon: [[0, 0], [1, 0], [1, 1], [0, 1]] as Array<[number, number]>,
  ceilingHeight: 2.7,
  level,
});
const plan = (...rooms: ReturnType<typeof room>[]): Plan => ({
  scaleRef: { px: 1, meters: 0.3048 },
  rooms,
  openings: [],
});

// --- The ordinary case: same rooms, new ids ---
const before = plan(room("r1", "Kitchen"), room("r2", "Living Room"), room("r3", "Bathroom"));
const after = plan(room("k9", "Living Room"), room("k7", "Kitchen"), room("k8", "Bathroom"));

const graded = {
  r1: { flooring: "poor" as const, cabinets: "dated" as const },
  r2: { flooring: "good" as const },
};

const moved = carryCondition(before, after, graded);
check("every graded room is carried", moved.carried === 2, `${moved.carried}`);
check("nothing is reported lost", moved.lost.length === 0, moved.lost.join(", "));
check(
  "the kitchen's grades follow the kitchen",
  moved.condition.k7?.flooring === "poor" && moved.condition.k7?.cabinets === "dated",
  JSON.stringify(moved.condition.k7),
);
check(
  "the living room's grades follow the living room",
  moved.condition.k9?.flooring === "good",
  JSON.stringify(moved.condition.k9),
);
check("an ungraded room gains nothing", moved.condition.k8 === undefined);

// --- Duplicate labels pair off rather than collapsing ---
const twoBeds = plan(room("a1", "Bedroom"), room("a2", "Bedroom"));
const twoBedsAfter = plan(room("b1", "Bedroom"), room("b2", "Bedroom"));
const bedGrades = {
  a1: { flooring: "poor" as const },
  a2: { flooring: "good" as const },
};
const beds = carryCondition(twoBeds, twoBedsAfter, bedGrades);
check("both same-named rooms are carried", beds.carried === 2, `${beds.carried}`);
check(
  "they land on different rooms rather than collapsing",
  beds.condition.b1?.flooring === "poor" && beds.condition.b2?.flooring === "good",
  JSON.stringify(beds.condition),
);

// --- A room that no longer exists is reported, not silently dropped ---
const shrunk = plan(room("c1", "Kitchen"));
const gone = carryCondition(before, shrunk, graded);
check("a vanished room is named", gone.lost.includes("Living Room"), gone.lost.join(", "));
check("what remains is still carried", gone.carried === 1, `${gone.carried}`);

// --- Nothing graded is not a loss ---
const empty = carryCondition(before, after, {});
check("an ungraded house carries nothing and loses nothing",
  empty.carried === 0 && empty.lost.length === 0);

// --- Labels differing only by case and spacing still match ---
const spaced = plan(room("d1", "  kitchen "), room("d2", "LIVING ROOM"));
const loose = carryCondition(before, spaced, graded);
check("matching ignores case and stray spaces", loose.carried === 2, `${loose.carried}`);

console.log(
  failures === 0
    ? "CARRYOVER OK - grades follow their rooms through a re-layout, duplicates pair off, and losses are named"
    : `CARRYOVER BROKEN - ${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
