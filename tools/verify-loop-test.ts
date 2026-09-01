/**
 * The correction loop cannot make a room worse.
 *
 * This is the one pass in the pipeline that can actively destroy work. A model
 * comparing a render against a photograph will always find *something* to say,
 * and a loop that acts on all of it walks a correct room steadily away from
 * correct - one confident adjustment at a time, each of which looked reasonable.
 *
 * Every guard against that is arithmetic rather than good behaviour, which is
 * what makes it testable here: no API key, no browser, no spent requests. If
 * these hold, the worst the loop can do is nothing.
 */
import {
  CONVERGED,
  MAX_BARREN_ROUNDS,
  MAX_PER_ROUND,
  MAX_ROUNDS,
  NOISE_FLOOR,
  admissible,
  emptyLoop,
  isVerifiable,
  keeps,
  remember,
  verdict,
  type Discrepancy,
} from "../src/lib/spec/verify";
import { RoomSpec } from "../src/lib/spec/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const spec = (source: Record<string, string> = {}) => RoomSpec.parse({ source });

const diff = (over: Partial<Discrepancy> = {}): Discrepancy => ({
  path: "ceiling.heightM",
  severity: "wrong",
  observed: "taller",
  proposed: "2.9",
  confidence: "high",
  ...over,
});

// --- what may be written at all ---
check("a ceiling height may be corrected", isVerifiable("ceiling.heightM"));
check("a beam count may be corrected", isVerifiable("ceiling.beams.count"));
check("a run's length may be corrected", isVerifiable("joinery.cab1.lengthM"));
check("an opening may be corrected", isVerifiable("openings.r2.kind"));

// The exclusion that does most of the work.
check("a floor colour may NOT be", !isVerifiable("floor.colour"));
check("a wall colour may NOT be", !isVerifiable("walls.colour"));
check("a trim colour may NOT be", !isVerifiable("trim.colour"));
check("a floor material may NOT be", !isVerifiable("floor.material"));
check("a cabinet's colour may NOT be", !isVerifiable("joinery.cab1.colour"));
check("nor its door style", !isVerifiable("joinery.cab1.doorStyle"));

// --- what gets through in a round ---
const colourAttempt = admissible([diff({ path: "floor.colour", proposed: "#ff0000" })], spec(), emptyLoop());
check("a colour correction is refused", colourAttempt.apply.length === 0);
check("and says why", colourAttempt.refused[0]?.reason.length > 0, colourAttempt.refused[0]?.reason);

const humanHeld = admissible([diff()], spec({ "ceiling.heightM": "human" }), emptyLoop());
check("a field you set by hand is never touched", humanHeld.apply.length === 0);
check("and the reason says so", humanHeld.refused[0]?.reason.includes("hand") === true);

const cosmetic = admissible([diff({ severity: "cosmetic" })], spec(), emptyLoop());

/**
 * A run's length is a fraction of its wall, whatever the field is called.
 *
 * The single most likely wrong answer this loop can receive: asked how long a
 * cabinet run is, a model answers in metres, because `lengthM` says metres.
 * Stored, it clamps downstream to the entire wall - so the pass that exists to
 * make a kitchen exact would reliably stretch every run it looked at.
 */
const metresForFraction = admissible(
  [diff({ path: "joinery.run.lengthM", proposed: "3.5" })],
  spec(),
  emptyLoop(),
);
check("a metres answer for a fraction field is refused", metresForFraction.apply.length === 0,
  JSON.stringify(metresForFraction.apply));
check("and says why", metresForFraction.refused[0]?.reason === "out of range for this field",
  JSON.stringify(metresForFraction.refused));

const properFraction = admissible(
  [diff({ path: "joinery.run.lengthM", proposed: "0.62" })],
  spec(),
  emptyLoop(),
);
check("a real fraction still gets through", properFraction.apply.length === 1);
check("a cosmetic difference is only noted", cosmetic.apply.length === 0);

const unsure = admissible(
  [diff({ severity: "approximate", confidence: "low" })],
  spec(),
  emptyLoop(),
);
check("an unconfident approximation is not acted on", unsure.apply.length === 0);

const many = admissible(
  [
    diff({ path: "ceiling.heightM", severity: "approximate" }),
    diff({ path: "trim.baseboardM", severity: "wrong", proposed: "0.14" }),
    diff({ path: "joinery.c.lengthM", severity: "wrong", proposed: "0.7" }),
    diff({ path: "ceiling.beams.count", severity: "wrong", proposed: "6" }),
  ],
  spec(),
  emptyLoop(),
);
check(`at most ${MAX_PER_ROUND} corrections a round`, many.apply.length === MAX_PER_ROUND, `${many.apply.length}`);
check(
  "and the most severe go first",
  many.apply.every((d) => d.severity === "wrong"),
  many.apply.map((d) => d.severity).join(" "),
);

// --- oscillation ---
let loop = emptyLoop();
loop = remember(loop, [diff({ proposed: "2.9" })]);
const repeat = admissible([diff({ proposed: "2.9" })], spec(), loop);
check("a value already proposed is refused", repeat.apply.length === 0);

loop = remember(loop, [diff({ proposed: "2.6" })]);
check("a field argued over twice is frozen", loop.frozen.includes("ceiling.heightM"));
const afterFreeze = admissible([diff({ proposed: "3.1" })], spec(), loop);
check("and is then left alone entirely", afterFreeze.apply.length === 0);
check(
  "with a reason a person can read",
  afterFreeze.refused[0]?.reason.includes("argued over") === true,
  afterFreeze.refused[0]?.reason,
);

// --- a round has to earn its keep ---
check("a clear improvement is kept", keeps(0.6, 0.5));
check("noise is not", !keeps(0.51, 0.5));
check(`the floor is ${NOISE_FLOOR}`, !keeps(0.5 + NOISE_FLOOR, 0.5) && keeps(0.5 + NOISE_FLOOR + 0.001, 0.5));

// --- stopping ---
const rounds = (list: Array<{ score: number; kept: boolean }>) => ({ ...emptyLoop(), rounds: list });

check(
  "it stops when it converges",
  verdict(rounds([{ score: CONVERGED, kept: true }]), 3).done === true,
);
check(
  "it stops after the round budget",
  verdict(rounds(Array.from({ length: MAX_ROUNDS }, () => ({ score: 0.4, kept: true }))), 3)
    .done === true,
);
check(
  "it stops when nothing is left to try",
  verdict(rounds([{ score: 0.4, kept: true }]), 0).done === true,
);
const barren = verdict(
  rounds(Array.from({ length: MAX_BARREN_ROUNDS }, () => ({ score: 0.4, kept: false }))),
  3,
);
check("it stops when it stops improving", barren.done === true);
check(
  "and says which of those happened",
  barren.done === true && barren.because === "no-improvement",
  barren.done ? barren.because : "not done",
);
check("otherwise it goes round again", verdict(rounds([{ score: 0.4, kept: true }]), 2).done === false);

// --- the property that matters ---
//
// A run of rounds that never improves must leave the score where it started,
// because every one of them is rolled back. Simulated here rather than argued.
let best = 0.42;
let kept = 0;
for (let i = 0; i < 10; i++) {
  const attempt = 0.42 - i * 0.01; // steadily worse, as a bad loop would be
  if (keeps(attempt, best)) {
    best = attempt;
    kept++;
  }
}
check("a loop that only gets worse changes nothing", kept === 0 && best === 0.42, `best ${best}`);

console.log(
  failures === 0
    ? "VERIFY LOOP OK - geometry only, human edits untouchable, oscillation frozen, rounds capped, and a loop that stops improving reverts rather than drifts"
    : `VERIFY LOOP FAILED - ${failures} check${failures === 1 ? "" : "s"}`,
);
process.exit(failures === 0 ? 0 : 1);
