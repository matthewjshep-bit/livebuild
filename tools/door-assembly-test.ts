/** A door is a frame, a panelled leaf, a threshold, a handle and casing. */
import { doorAssembly } from "../src/lib/model/door-assembly";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const parts = doorAssembly([5, 0], [0, -1], 0.9, 2.05, { leaf: "#722", frame: "#fff", casing: "#eee" });
const by = (part: string) => parts.filter((p) => p.part === part);
check("a frame of three and a threshold", by("door-frame").length === 3 && by("threshold").length === 1);
check("six panels", by("door-panel").length === 6);
check("the panels are set back from the leaf", by("door-panel").every((p) => p.size[2] < by("door-leaf")[0].size[2]));
check("one handle, a metre up, on the latch side", by("handle").length === 1 && Math.abs(by("handle")[0].center[1] - 1.0) < 1e-9 && by("handle")[0].center[0] > 5);
check("casing outside, proud of the cladding", by("casing").length === 3 && by("casing").every((p) => p.center[2] < -0.02));
check("the leaf sits in the wall", by("door-leaf").every((p) => p.center[2] > 0));
check("nothing is taller than the frame", parts.every((p) => p.center[1] + p.size[1] / 2 <= 2.05 + 0.06 + 0.09 + 1e-9));
check("hinged the other way, the handle moves", doorAssembly([5, 0], [0, -1], 0.9, 2.05, { leaf: "#722", frame: "#fff", casing: "#eee" }, "right").find((p) => p.part === "handle")!.center[0] < 5);

console.log(failures === 0 ? "DOOR ASSEMBLY OK - frame, six panels, threshold, handle and casing" : `DOOR ASSEMBLY BROKEN - ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
