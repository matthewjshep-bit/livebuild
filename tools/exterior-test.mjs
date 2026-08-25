/**
 * The exterior grader must refuse to guess.
 *
 * There is no exterior photograph in this repo to grade, and a ray-traced one
 * would not settle anything - the synthetic house has already shown three times
 * that it cannot tell us how a vision pass does on real photographs.
 *
 * What can be tested with what is here is the discipline that actually matters,
 * and it is testable precisely *because* the material is wrong: shown the
 * inside of a bathroom and asked about the roof, the honest answer is
 * not_visible. A grader that answers anything else is inventing scope, and
 * inventing scope is worth thousands of dollars a line. This is the failure
 * mode that would be invisible in production, because a confident wrong grade
 * looks exactly like a confident right one.
 */
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

const available = await fetch(`${BASE}/api/condition`)
  .then((r) => r.json())
  .catch(() => null);

if (!available?.available) {
  console.log("EXTERIOR SKIPPED - no ANTHROPIC_API_KEY configured");
  process.exit(0);
}

const asDataUrl = (path) =>
  `data:image/jpeg;base64,${readFileSync(path).toString("base64")}`;

const ELEMENTS = ["roof", "exterior", "windows", "landscaping", "foundation"];
const VALID = new Set(["good", "fair", "dated", "poor", "not_visible"]);

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const response = await fetch(`${BASE}/api/condition`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    scope: "house",
    room: "exterior",
    elements: ELEMENTS,
    photos: [
      asDataUrl("public/properties/demo-house/photos/bath-01.jpg"),
      asDataUrl("public/properties/demo-house/photos/kitchen-01.jpg"),
    ],
  }),
});

check("the route answers", response.ok, `HTTP ${response.status}`);
const data = response.ok ? await response.json() : { grades: [] };
const grades = data.grades ?? [];

// The contract: only what was asked for, only real grades.
const asked = new Set(ELEMENTS);
check("nothing was invented", grades.every((g) => asked.has(g.element)),
  grades.map((g) => g.element).filter((e) => !asked.has(e)).join(", "));
check("every grade is a real grade", grades.every((g) => VALID.has(g.grade)));
check("every element was answered", grades.length === ELEMENTS.length,
  `${grades.length}/${ELEMENTS.length}`);

// The judgement: a bathroom and a kitchen show no roof, no siding and no yard.
// Windows are the one honest exception - an interior shot can show a window -
// so they are excluded rather than pretended to be invisible.
const mustBeBlind = ["roof", "exterior", "landscaping", "foundation"];
for (const element of mustBeBlind) {
  const got = grades.find((g) => g.element === element);
  check(`${element} is not guessed from an interior photo`,
    got?.grade === "not_visible",
    `graded ${got?.grade ?? "missing"}${got?.reason ? ` — "${got.reason}"` : ""}`);
}

for (const g of grades) {
  console.log(`  ${g.element.padEnd(12)} ${g.grade}${g.reason ? ` — ${g.reason}` : ""}`);
}

// A control, without which the above proves nothing.
//
// A route hard-wired to answer not_visible would pass every check so far. The
// same images through the room scope must therefore come back graded - if they
// do, the refusals above are refusals rather than a stuck pipeline.
const control = await fetch(`${BASE}/api/condition`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    room: "Bathroom",
    elements: ["floor", "walls", "vanity", "bathing", "toilet"],
    photos: [asDataUrl("public/properties/demo-house/photos/bath-01.jpg")],
  }),
});
const controlGrades = control.ok ? (await control.json()).grades ?? [] : [];
const judged = controlGrades.filter((g) => g.grade !== "not_visible");
check("the grader is not simply stuck on not_visible",
  judged.length > 0,
  "the same photographs produced no judgement through the room scope either");
console.log(
  `  control: ${judged.length}/${controlGrades.length} graded through the room scope` +
    (judged[0] ? ` (${judged[0].element} ${judged[0].grade})` : ""),
);

console.log(
  failures === 0
    ? "EXTERIOR OK - declines to guess the roof from an interior shot, and is not merely stuck"
    : `EXTERIOR BROKEN - ${failures} failures`,
);
process.exit(failures === 0 ? 0 : 1);
