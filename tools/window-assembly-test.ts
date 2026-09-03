/** A window is a frame in a reveal, a sill and stool, casing outside, bars and panes. */
import { windowAssembly } from "../src/lib/model/window-assembly";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const window = { center: [5, 0] as [number, number], width: 1.2, sill: 0.9, head: 2.1, thickness: 0.2, angleDeg: 0 };
const outward: [number, number] = [0, -1];
const { trim, glass } = windowAssembly(window, outward, 0, { frame: "#fff", casing: "#eee", glass: "#cde" });

const by = (part: string) => trim.filter((p) => p.part === part);
check("four frame members", by("frame").length === 4);
check("a sill outside and a stool inside", by("sill").length === 1 && by("stool").length === 1);
check("the sill is outside, the stool inside", by("sill")[0].center[2] < 0 && by("stool")[0].center[2] > 0, `${by("sill")[0].center[2]} / ${by("stool")[0].center[2]}`);
check("three casing boards", by("casing").length === 3);
check("the casing is proud of the cladding", by("casing").every((p) => p.center[2] < -0.11), by("casing").map((p) => p.center[2].toFixed(3)).join(","));
// 1.1m inside the frame divides into two lights at about 0.55.
check("a 1.2m window has two lights", glass.length === 2 && by("bar").length === 1, `${glass.length} panes, ${by("bar").length} bar(s)`);
check("and one meeting rail", by("rail").length === 1);
check("panes are thin and in the wall's middle", glass.every((p) => p.size[2] < 0.01 && Math.abs(p.center[2]) < 1e-9));
check("everything is within the opening's height", [...trim, ...glass].every((p) => p.center[1] - p.size[1] / 2 > 0.8 && p.center[1] + p.size[1] / 2 < 2.2));
check("everything is along the wall", [...trim, ...glass].every((p) => p.angleDeg === 0 && Math.abs(p.center[0] - 5) < 0.75));

// A narrow window is one light with no bar.
const small = windowAssembly({ ...window, width: 0.6 }, outward, 0, { frame: "#fff", casing: "#eee", glass: "#cde" });
check("a 0.6m window is one light", small.glass.length === 1 && small.trim.filter((p) => p.part === "bar").length === 0);

// On a wall at 90 degrees the parts turn with it.
const turned = windowAssembly({ ...window, angleDeg: 90, center: [0, 5] }, [-1, 0], 0, { frame: "#fff", casing: "#eee", glass: "#cde" });
check("a turned wall's sill is outside along x", turned.trim.find((p) => p.part === "sill")!.center[0] < 0 && turned.trim.every((p) => p.angleDeg === 90));

console.log(failures === 0 ? "WINDOW ASSEMBLY OK - frame, sill, stool, casing, bars and panes, on the right sides" : `WINDOW ASSEMBLY BROKEN - ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
