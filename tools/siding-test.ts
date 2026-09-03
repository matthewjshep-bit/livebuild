/** The site read's free text about the walls lands on a cladding this can draw. */
import { sidingFinish } from "../src/lib/model/siding";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const cases: Array<[string | null, string | null]> = [
  ["asbestos shingle siding", "shingle"],
  ["cedar shakes", "shingle"],
  ["wood siding", "lap"],
  ["vinyl clapboard", "lap"],
  ["fiber cement lap siding", "lap"],
  ["brick veneer", "brick"],
  ["painted brick", "brick"],
  ["stucco", "stucco"],
  ["board and batten", "board-and-batten"],
  ["board & batten over shingle", "board-and-batten"],
  ["", null],
  [null, null],
  ["glass curtain wall", null],
];
for (const [text, want] of cases) {
  const got = sidingFinish(text);
  check(`"${text}" → ${want}`, got === want, `got ${got}`);
}

console.log(failures === 0 ? "SIDING OK - every way the read describes a wall lands on a cladding" : `SIDING BROKEN - ${failures}`);
process.exit(failures === 0 ? 0 : 1);
