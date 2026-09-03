/**
 * A thickened roof is a set of closed prisms, wound outward, as thick as asked.
 */
import { roofFor, thickenFaces } from "../src/lib/model/roof";
import type { Plan } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

type P = [number, number, number];
const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (u: P, v: P): P => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const dot = (u: P, v: P) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const key = (p: P) => p.map((v) => v.toFixed(5)).join(",");

const plan: Plan = {
  scaleRef: { px: 1, meters: 1 },
  rooms: [{ id: "a", label: "a", polygon: [[0, 0], [10, 0], [10, 6], [0, 6]], ceilingHeight: 2.7, level: 0 }],
  openings: [],
};
const roof = roofFor(plan, { roof: { shape: "gable" } }, null)!;
const T = 0.15;
const thick = thickenFaces(roof.faces, T);

// A face with n corners becomes n + 2 faces: itself, its underside, a side per edge.
const expected = roof.faces.reduce((s, f) => s + f.points.length + 2, 0);
check("every face became a prism", thick.length === expected, `${thick.length} faces, expected ${expected}`);

// Closed: each prism's directed edges pair off with their reverses.
let open = 0;
let inward = 0;
let cursor = 0;
for (const f of roof.faces) {
  const count = f.points.length + 2;
  const prism = thick.slice(cursor, cursor + count);
  cursor += count;
  const edges = new Map<string, number>();
  const all = prism.flatMap((p) => p.points);
  const centre: P = [0, 1, 2].map((i) => all.reduce((s, p) => s + p[i], 0) / all.length) as P;
  for (const face of prism) {
    const n = face.points.length;
    for (let i = 0; i < n; i++) {
      const a = face.points[i];
      const b = face.points[(i + 1) % n];
      edges.set(`${key(a)}>${key(b)}`, (edges.get(`${key(a)}>${key(b)}`) ?? 0) + 1);
    }
    // Wound outward: the winding's normal points away from the prism's middle.
    const normal = cross(sub(face.points[1], face.points[0]), sub(face.points[2], face.points[0]));
    const fc: P = [0, 1, 2].map((i) => face.points.reduce((s, p) => s + p[i], 0) / face.points.length) as P;
    if (dot(normal, sub(fc, centre)) <= 0) inward++;
  }
  for (const [e, count] of edges) {
    const [a, b] = e.split(">");
    if (count !== 1 || edges.get(`${b}>${a}`) !== 1) open++;
  }
}
check("every prism is closed", open === 0, `${open} unmatched edge(s)`);
check("and wound outward", inward === 0, `${inward} face(s) facing in`);

// As thick as asked: the underside of a slope is T below it along its normal.
const slope = roof.faces.find((f) => f.kind === "slope")!;
const under = thick[thick.indexOf(slope) + 1];
const n = cross(sub(slope.points[1], slope.points[0]), sub(slope.points[2], slope.points[0]));
const len = Math.hypot(...n);
const gap = dot(sub(slope.points[0], under.points[under.points.length - 1]), [n[0] / len, n[1] / len, n[2] / len]);
check("a slope is as thick as asked", Math.abs(gap - T) < 1e-6, `${gap}`);
check("the top face is unchanged", thick[thick.indexOf(slope)] === slope);
check("nothing rose above the ridge", thick.every((f) => f.points.every((p) => p[1] <= roof.ridgeY + 1e-6)));

console.log(failures === 0 ? "ROOF THICKNESS OK - closed prisms, wound outward, as thick as asked" : `ROOF THICKNESS BROKEN - ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
